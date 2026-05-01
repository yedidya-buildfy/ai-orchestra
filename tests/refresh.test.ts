import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace, paths, readBoard, writeBoard } from "../src/workspace.js";
import { decideRefreshes, refreshAgent, refreshSweep } from "../src/refresh.js";
import type { AgentAdapter, RuntimeUsage } from "../src/agent-adapter.js";
import type { AgentName, Board } from "../src/types.js";

class FakeAdapter implements AgentAdapter {
  readonly agent: AgentName;
  readonly sessionName: string;
  readonly tmux: { readPipeBuffer: () => Promise<string> };
  alive = false;
  prompts: string[] = [];
  injected: { label: string; content: string }[][] = [];
  killed = 0;
  spawned = 0;
  buffer = "";

  constructor(agent: AgentName) {
    this.agent = agent;
    this.sessionName = agent.toLowerCase();
    this.tmux = { readPipeBuffer: async () => this.buffer };
  }
  async spawn() {
    this.spawned++;
    this.alive = true;
  }
  async kill() {
    this.killed++;
    this.alive = false;
  }
  async prompt(t: string) {
    if (!this.alive) throw new Error("not alive");
    this.prompts.push(t);
  }
  async injectContext(files: { label: string; content: string }[]) {
    if (!this.alive) throw new Error("not alive");
    this.injected.push(files);
    this.prompts.push(files.map((f) => `${f.label}:${f.content.length}`).join(","));
  }
  async readUsage(): Promise<RuntimeUsage | null> {
    return null;
  }
  async isAlive() {
    return this.alive;
  }
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orch-refresh-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function freshBoard(b: Partial<Board> = {}): Board {
  return {
    control: {
      TASK_ID: "001",
      PHASE: "IMPLEMENT",
      TASK_TYPE: "FIX",
      NEXT_AGENT: "CODEX",
      STATUS: "ACTIVE",
    },
    permissions: {
      CODEX: { mode: "WRITE", scope: ["src/**"] },
      GEMINI: { mode: "READ", scope: [] },
    },
    contextHealth: { CLAUDE: 0, CODEX: 0, GEMINI: 0 },
    objective: "fix it",
    claude: "(empty)",
    codex: "(empty)",
    gemini: "(empty)",
    decisions: "(empty)",
    changelog: "(empty)",
    ...b,
  };
}

describe("decideRefreshes", () => {
  it("flags FORCE_RESET as context_overflow", () => {
    const b = freshBoard();
    const d = decideRefreshes(b, { CLAUDE: 0.96, CODEX: 0.5, GEMINI: 0.1 });
    expect(d).toEqual([{ agent: "CLAUDE", reason: "context_overflow", band: "FORCE_RESET", pct: 0.96 }]);
  });

  it("flags REFRESH band as context_pressure", () => {
    const b = freshBoard();
    const d = decideRefreshes(b, { CLAUDE: 0.5, CODEX: 0.92, GEMINI: 0.1 });
    expect(d).toEqual([{ agent: "CODEX", reason: "context_pressure", band: "REFRESH", pct: 0.92 }]);
  });

  it("flags self-requested even when band is OK", () => {
    const b = freshBoard({ gemini: "REFRESH_REQUESTED: TRUE\nReason: confused" });
    const d = decideRefreshes(b, { CLAUDE: 0.1, CODEX: 0.1, GEMINI: 0.1 });
    expect(d.map((x) => x.agent)).toEqual(["GEMINI"]);
    expect(d[0]!.reason).toBe("agent_requested");
  });

  it("FORCE_RESET takes precedence over self-request", () => {
    const b = freshBoard({ codex: "REFRESH_REQUESTED: TRUE" });
    const d = decideRefreshes(b, { CLAUDE: 0.1, CODEX: 0.97, GEMINI: 0.1 });
    expect(d[0]!.reason).toBe("context_overflow");
  });
});

describe("refreshAgent", () => {
  it("snapshots, kills, respawns, rehydrates, verifies", async () => {
    await initWorkspace(root);
    const b = await readBoard(root);
    b.codex = "Working on bug fix; context full.\nREFRESH_REQUESTED: TRUE";
    await writeBoard(root, b);

    const ad = new FakeAdapter("CODEX");
    ad.alive = true;
    ad.buffer = "fake pane line A\nfake pane line B\nfake pane line C\n";

    const r = await refreshAgent(root, "CODEX", "agent_requested", { adapter: ad });
    expect(r.killed).toBe(true);
    expect(r.rehydrated).toBe(true);
    expect(r.verified).toBe(true);
    expect(ad.killed).toBe(1);
    expect(ad.spawned).toBe(1);
    expect(ad.injected.length).toBe(1);
    const labels = ad.injected[0]!.map((f) => f.label);
    expect(labels).toEqual(["protocol.md", "memory.md", "board.md", "objective"]);

    // The snapshot must be persisted in memory.md.
    const mem = readFileSync(paths(root).memory, "utf8");
    expect(mem).toMatch(/Refresh snapshot: CODEX/);
    expect(mem).toMatch(/REFRESH_REQUESTED/);

    // Changelog has START + DONE entries.
    const cl = readFileSync(paths(root).changelog, "utf8");
    expect(cl).toMatch(/refresh START agent=CODEX/);
    expect(cl).toMatch(/refresh DONE agent=CODEX verified=true/);

    // Board agent block has been cleared.
    const after = await readBoard(root);
    expect(after.codex).toMatch(/refreshed/);
  });

  it("dryRun does not kill or respawn", async () => {
    await initWorkspace(root);
    const ad = new FakeAdapter("CLAUDE");
    ad.alive = true;
    const r = await refreshAgent(root, "CLAUDE", "manual", { adapter: ad, dryRun: true });
    expect(r.killed).toBe(false);
    expect(r.rehydrated).toBe(false);
    expect(ad.killed).toBe(0);
    expect(ad.spawned).toBe(0);
    // Snapshot still happened.
    const mem = readFileSync(paths(root).memory, "utf8");
    expect(mem).toMatch(/Refresh snapshot: CLAUDE/);
  });
});

describe("refreshSweep", () => {
  it("refreshes only agents over threshold", async () => {
    await initWorkspace(root);
    const adapters = {
      CLAUDE: new FakeAdapter("CLAUDE"),
      CODEX: new FakeAdapter("CODEX"),
      GEMINI: new FakeAdapter("GEMINI"),
    };
    adapters.CLAUDE.alive = true;
    adapters.CODEX.alive = true;
    adapters.GEMINI.alive = true;

    // No agents over threshold based on tiny init workspace.
    const r1 = await refreshSweep(root, { adapters });
    expect(r1).toEqual([]);

    // Force one self-request.
    const b = await readBoard(root);
    b.gemini = "REFRESH_REQUESTED: TRUE";
    await writeBoard(root, b);
    const r2 = await refreshSweep(root, { adapters });
    expect(r2.map((x) => x.agent)).toEqual(["GEMINI"]);
    expect(adapters.GEMINI.killed).toBe(1);
    expect(adapters.GEMINI.spawned).toBe(1);
    expect(adapters.CLAUDE.killed).toBe(0);
    expect(adapters.CODEX.killed).toBe(0);
  });
});
