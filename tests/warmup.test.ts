import { describe, it, expect } from "vitest";
import {
  CODEX_AUTO_RESPONDERS,
  GEMINI_AUTO_RESPONDERS,
  CLAUDE_AUTO_RESPONDERS,
  warmupAgent,
  waitForIdle,
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

  it("codex's numbered trust prompt gets '1' (Yes, continue)", () => {
    const codexTrust = CODEX_AUTO_RESPONDERS.find((r) =>
      r.description.startsWith("trust folder (codex numbered"),
    );
    expect(codexTrust).toBeDefined();
    expect(codexTrust!.response).toBe("1");
    expect(
      codexTrust!.pattern.test(
        "> Do you trust the contents of this directory? Working with untrusted contents...",
      ),
    ).toBe(true);
    // Must NOT match Gemini's prompt — that one wants a different answer.
    expect(
      codexTrust!.pattern.test(
        "Do you trust the files in this folder?\n  1. Trust folder",
      ),
    ).toBe(false);
  });

  it("gemini's numbered trust prompt gets '2' (Trust parent folder)", () => {
    const geminiTrust = GEMINI_AUTO_RESPONDERS.find((r) =>
      r.description.startsWith("trust parent folder (gemini numbered"),
    );
    expect(geminiTrust).toBeDefined();
    expect(geminiTrust!.response).toBe("2");
    expect(
      geminiTrust!.pattern.test(
        "Do you trust the files in this folder?\n  1. Trust folder (orchestra-test)\n  2. Trust parent folder (yedidya)\n  3. Don't trust",
      ),
    ).toBe(true);
    // Must NOT match codex's prompt.
    expect(
      geminiTrust!.pattern.test("Do you trust the contents of this directory?"),
    ).toBe(false);
  });

  it("claude does NOT receive either numbered trust pattern (claude doesn't ask)", () => {
    const claudeTrust = CLAUDE_AUTO_RESPONDERS.find((r) =>
      r.description.includes("numbered"),
    );
    expect(claudeTrust).toBeUndefined();
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

  it("answers codex's numbered trust prompt with '1'", async () => {
    const ad = new FakeAdapter("CODEX", [
      "",
      "> Do you trust the contents of this directory?\n  1. Yes, continue\n  2. No, quit\n",
      "Trusted. Ready.\n",
      "Trusted. Ready.\n",
    ]);
    const r = await warmupAgent(ad, { initialDelayMs: 0, delayMs: 5, rounds: 6 });
    expect(
      r.responded.some((x) => x.description.startsWith("trust folder (codex numbered")),
    ).toBe(true);
    expect(ad.prompts).toContain("1");
  });

  it("answers gemini's numbered trust prompt with '2' (parent folder)", async () => {
    const ad = new FakeAdapter("GEMINI", [
      "",
      "Do you trust the files in this folder?\n  1. Trust folder (proj)\n  2. Trust parent folder (parent)\n  3. Don't trust\n",
      "Trusted parent. Ready.\n",
      "Trusted parent. Ready.\n",
    ]);
    const r = await warmupAgent(ad, { initialDelayMs: 0, delayMs: 5, rounds: 6 });
    expect(
      r.responded.some((x) => x.description.startsWith("trust parent folder (gemini numbered")),
    ).toBe(true);
    expect(ad.prompts).toContain("2");
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

describe("waitForIdle", () => {
  it("returns settled=true once the buffer stops growing for quietMs", async () => {
    // Buffer grows for the first 3 reads, then stays the same.
    const ad = new FakeAdapter("GEMINI", ["a", "ab", "abc", "abcd", "abcd", "abcd", "abcd"]);
    const r = await waitForIdle(ad, { quietMs: 80, checkEveryMs: 20, timeoutMs: 5000 });
    expect(r.settled).toBe(true);
    expect(r.durationMs).toBeLessThan(1000);
    expect(r.agent).toBe("GEMINI");
  });

  it("returns settled=false on timeout when the buffer keeps growing", async () => {
    let n = 0;
    const ad: AgentAdapter = {
      agent: "CODEX",
      sessionName: "codex",
      tmux: { readPipeBuffer: async () => "x".repeat(++n) } as never,
      spawn: async () => {},
      kill: async () => {},
      prompt: async () => {},
      injectContext: async () => {},
      readUsage: async () => null,
      isAlive: async () => true,
    };
    const r = await waitForIdle(ad, { quietMs: 200, checkEveryMs: 10, timeoutMs: 100 });
    expect(r.settled).toBe(false);
  });
});
