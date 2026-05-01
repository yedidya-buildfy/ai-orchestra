import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace, paths, readBoard, writeBoard } from "../src/workspace.js";
import { Orchestrator, detectRefreshRequests } from "../src/orchestrator.js";
import type { AgentAdapter, RuntimeUsage } from "../src/agent-adapter.js";
import type { AgentName } from "../src/types.js";

class StubAdapter implements AgentAdapter {
  readonly agent: AgentName;
  readonly sessionName: string;
  readonly tmux = { name: "stub" } as never;
  alive = false;
  prompts: string[] = [];
  spawned = 0;
  constructor(agent: AgentName) {
    this.agent = agent;
    this.sessionName = agent.toLowerCase();
  }
  async spawn() {
    this.spawned++;
    this.alive = true;
  }
  async kill() {
    this.alive = false;
  }
  async prompt(text: string) {
    if (!this.alive) throw new Error("not alive");
    this.prompts.push(text);
  }
  async injectContext() {}
  async readUsage(): Promise<RuntimeUsage | null> {
    return null;
  }
  async isAlive() {
    return this.alive;
  }
}

function makeStubs(): Record<AgentName, StubAdapter> {
  return {
    CLAUDE: new StubAdapter("CLAUDE"),
    CODEX: new StubAdapter("CODEX"),
    GEMINI: new StubAdapter("GEMINI"),
  };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orch-orch-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Orchestrator.tick", () => {
  it("skips when STATUS != ACTIVE", async () => {
    await initWorkspace(root);
    const stubs = makeStubs();
    const o = new Orchestrator(root, { adapters: stubs });
    const r = await o.tick();
    expect(r.action).toBe("skipped");
    expect(stubs.CLAUDE.spawned).toBe(0);
    expect(stubs.CODEX.spawned).toBe(0);
  });

  it("dispatches when STATUS=ACTIVE, sets STATUS=WAITING after", async () => {
    await initWorkspace(root);
    const b = await readBoard(root);
    b.control.STATUS = "ACTIVE";
    b.control.NEXT_AGENT = "CODEX";
    b.control.PHASE = "IMPLEMENT";
    b.control.TASK_ID = "001";
    b.objective = "Fix it";
    await writeBoard(root, b);

    const stubs = makeStubs();
    const o = new Orchestrator(root, { adapters: stubs });
    const r = await o.tick();
    expect(r.action).toBe("dispatched");
    expect(r.agent).toBe("CODEX");
    expect(stubs.CODEX.spawned).toBe(1);
    expect(stubs.CODEX.prompts.length).toBe(1);
    const fresh = await readBoard(root);
    expect(fresh.control.STATUS).toBe("WAITING");
  });

  it("appends a changelog entry on dispatch", async () => {
    await initWorkspace(root);
    const b = await readBoard(root);
    b.control.STATUS = "ACTIVE";
    b.control.NEXT_AGENT = "CLAUDE";
    await writeBoard(root, b);
    const stubs = makeStubs();
    const o = new Orchestrator(root, { adapters: stubs });
    await o.tick();
    const cl = readFileSync(paths(root).changelog, "utf8");
    expect(cl).toMatch(/dispatched CLAUDE/);
  });

  it("updates Context Health on dispatch", async () => {
    await initWorkspace(root);
    const b = await readBoard(root);
    b.control.STATUS = "ACTIVE";
    b.control.NEXT_AGENT = "GEMINI";
    await writeBoard(root, b);
    const stubs = makeStubs();
    const o = new Orchestrator(root, { adapters: stubs });
    await o.tick();
    const after = await readBoard(root);
    // contextHealth is fractional 0..1
    expect(after.contextHealth.GEMINI).toBeGreaterThan(0);
  });

  it("a tick without a dispatch does not modify board.md", async () => {
    await initWorkspace(root);
    const before = readFileSync(paths(root).board, "utf8");
    const o = new Orchestrator(root, { adapters: makeStubs() });
    await o.tick();
    const after = readFileSync(paths(root).board, "utf8");
    expect(after).toBe(before);
  });

  it("metrics file is updated even on a skipped tick", async () => {
    await initWorkspace(root);
    const m1 = readFileSync(paths(root).metrics, "utf8");
    const o = new Orchestrator(root, { adapters: makeStubs() });
    await o.tick();
    const m2 = readFileSync(paths(root).metrics, "utf8");
    expect(m2).not.toBe(m1);
  });
});

describe("detectRefreshRequests", () => {
  it("picks up REFRESH_REQUESTED in agent blocks", async () => {
    await initWorkspace(root);
    const b = await readBoard(root);
    b.codex = "REFRESH_REQUESTED: TRUE\nReason: overflow";
    b.gemini = "(empty)";
    expect(detectRefreshRequests(b)).toEqual(["CODEX"]);
  });
});
