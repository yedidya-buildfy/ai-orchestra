import { describe, it, expect } from "vitest";
import {
  CODEX_AUTO_RESPONDERS,
  GEMINI_AUTO_RESPONDERS,
  CLAUDE_AUTO_RESPONDERS,
  warmupAgent,
} from "../src/warmup.js";
import type { AgentAdapter, RuntimeUsage } from "../src/agent-adapter.js";
import type { AgentName } from "../src/types.js";

class FakeAdapter implements AgentAdapter {
  readonly agent: AgentName;
  readonly sessionName: string;
  readonly tmux: { readPipeBuffer: () => Promise<string> };
  alive = true;
  prompts: string[] = [];
  // Script of buffer states: each call to readPipeBuffer returns the next entry.
  // After exhausting the script, returns the last entry.
  private bufferScript: string[];
  private idx = 0;

  constructor(agent: AgentName, bufferScript: string[]) {
    this.agent = agent;
    this.sessionName = agent.toLowerCase();
    this.bufferScript = bufferScript;
    this.tmux = {
      readPipeBuffer: async () => {
        const i = Math.min(this.idx, this.bufferScript.length - 1);
        this.idx++;
        return this.bufferScript[i] ?? "";
      },
    };
  }
  async spawn() {}
  async kill() {
    this.alive = false;
  }
  async prompt(t: string) {
    this.prompts.push(t);
    // After a prompt, the next buffer state should reflect a "post-answer" view.
    // Tests provide that in the script.
  }
  async injectContext() {}
  async readUsage(): Promise<RuntimeUsage | null> {
    return null;
  }
  async isAlive() {
    return this.alive;
  }
}

describe("auto-responder pattern bank", () => {
  it("trust-folder pattern matches expected phrasings", () => {
    const banks = [CODEX_AUTO_RESPONDERS, GEMINI_AUTO_RESPONDERS, CLAUDE_AUTO_RESPONDERS];
    const phrasings = [
      "Do you trust this folder?",
      "Trust this directory?",
      "Trusting this workspace requires confirmation",
      "Trust this project? (y/N)",
    ];
    for (const bank of banks) {
      const trust = bank.find((r) => r.description === "trust folder")!;
      for (const p of phrasings) expect(trust.pattern.test(p)).toBe(true);
    }
  });

  it("update prompts get a 'no'", () => {
    const trustless = "Update available! Install now? (y/N)";
    const r = CODEX_AUTO_RESPONDERS.find(
      (rule) => rule.pattern.test(trustless) && rule.response === "n",
    );
    expect(r).toBeDefined();
  });

  it("'press enter to continue' is answered with empty (just Enter)", () => {
    const banks = [CODEX_AUTO_RESPONDERS, GEMINI_AUTO_RESPONDERS, CLAUDE_AUTO_RESPONDERS];
    for (const bank of banks) {
      const r = bank.find((x) => x.description === "press enter");
      expect(r).toBeDefined();
      expect(r!.response).toBe("");
    }
  });
});

describe("warmupAgent", () => {
  it("answers a trust-folder prompt with 'y'", async () => {
    const ad = new FakeAdapter("CODEX", [
      "",
      "Welcome to Codex CLI v1.0\nDo you trust this folder? (y/N)\n",
      "Welcome to Codex CLI v1.0\nDo you trust this folder? (y/N) y\nReady.\n",
      "Welcome to Codex CLI v1.0\nDo you trust this folder? (y/N) y\nReady.\n",
    ]);
    const r = await warmupAgent(ad, { initialDelayMs: 0, delayMs: 5, rounds: 6 });
    expect(r.responded.some((x) => x.description === "trust folder")).toBe(true);
    expect(ad.prompts).toContain("y");
  });

  it("declines an update prompt", async () => {
    const ad = new FakeAdapter("GEMINI", [
      "",
      "Update available! Install now? (y/N)\n",
      "Update available! Install now? (y/N) n\nProceeding.\n",
      "Update available! Install now? (y/N) n\nProceeding.\n",
    ]);
    const r = await warmupAgent(ad, { initialDelayMs: 0, delayMs: 5, rounds: 6 });
    expect(r.responded.some((x) => x.sent === "n")).toBe(true);
  });

  it("exits cleanly when no prompts appear", async () => {
    const ad = new FakeAdapter("CLAUDE", [
      "Welcome back to Claude Code v2.1\nReady.\n",
    ]);
    const r = await warmupAgent(ad, { initialDelayMs: 0, delayMs: 5, rounds: 6 });
    expect(r.responded).toEqual([]);
  });

  it("respects maxTotalMs hard timeout", async () => {
    const ad = new FakeAdapter("CODEX", ["never matches anything useful"]);
    const r = await warmupAgent(ad, {
      initialDelayMs: 0,
      delayMs: 5,
      rounds: 100,
      maxTotalMs: 50,
    });
    expect(r.durationMs).toBeLessThan(500);
  });
});
