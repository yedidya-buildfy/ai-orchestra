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
  it("legacy Y/N trust-folder pattern still matches old phrasings", () => {
    const banks = [CODEX_AUTO_RESPONDERS, GEMINI_AUTO_RESPONDERS, CLAUDE_AUTO_RESPONDERS];
    const phrasings = [
      "Trust this directory? (y/N)",
      "Trust this project? (y/N)",
      "Trusting this workspace? (y/N)",
    ];
    for (const bank of banks) {
      const trust = bank.find((r) => r.description === "trust folder (Y/N)")!;
      expect(trust).toBeDefined();
      for (const p of phrasings) expect(trust.pattern.test(p)).toBe(true);
    }
  });

  it("numbered-choice trust prompts (codex 0.128+, gemini 0.40+) get '1'", () => {
    const banks = [CODEX_AUTO_RESPONDERS, GEMINI_AUTO_RESPONDERS, CLAUDE_AUTO_RESPONDERS];
    const phrasings = [
      // codex 0.128+
      "Do you trust the contents of this directory? Working with untrusted contents...",
      // gemini 0.40+
      "Do you trust the files in this folder?\n\n1. Trust folder (orchestra-test)",
    ];
    for (const bank of banks) {
      const rule = bank.find((r) =>
        r.description.startsWith("trust folder (numbered"),
      )!;
      expect(rule).toBeDefined();
      expect(rule.response).toBe("1");
      for (const p of phrasings) expect(rule.pattern.test(p)).toBe(true);
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
  it("answers a legacy Y/N trust-folder prompt with 'y'", async () => {
    const ad = new FakeAdapter("CODEX", [
      "",
      "Welcome to Codex CLI v1.0\nTrust this folder? (y/N)\n",
      "Welcome to Codex CLI v1.0\nTrust this folder? (y/N) y\nReady.\n",
      "Welcome to Codex CLI v1.0\nTrust this folder? (y/N) y\nReady.\n",
    ]);
    const r = await warmupAgent(ad, { initialDelayMs: 0, delayMs: 5, rounds: 6 });
    expect(r.responded.some((x) => x.description.startsWith("trust folder (Y/N)"))).toBe(true);
    expect(ad.prompts).toContain("y");
  });

  it("answers a numbered-choice trust prompt with '1' (codex/gemini latest)", async () => {
    const ad = new FakeAdapter("CODEX", [
      "",
      "> Do you trust the contents of this directory?\n  1. Yes, continue\n  2. No, quit\n",
      "Trusted. Ready.\n",
      "Trusted. Ready.\n",
    ]);
    const r = await warmupAgent(ad, { initialDelayMs: 0, delayMs: 5, rounds: 6 });
    expect(r.responded.some((x) => x.description.startsWith("trust folder (numbered"))).toBe(true);
    expect(ad.prompts).toContain("1");
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
