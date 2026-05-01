import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TmuxSession } from "../src/tmux.js";
import {
  ClaudeAdapter,
  CodexAdapter,
  GeminiAdapter,
  buildAdapters,
} from "../src/agent-adapter.js";
import { initWorkspace, paths } from "../src/workspace.js";

const tmuxOk = await TmuxSession.tmuxAvailable();
const dscribe = tmuxOk ? describe : describe.skip;

let root: string;
const cleanup: (() => Promise<void>)[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orch-adapter-"));
});
afterEach(async () => {
  for (const fn of cleanup.splice(0)) {
    try {
      await fn();
    } catch {
      // ignore
    }
  }
  rmSync(root, { recursive: true, force: true });
});

function uniqueSession(): string {
  return `orch-adapter-${randomBytes(4).toString("hex")}`;
}

dscribe("agent adapters with real tmux + bash", () => {
  it("ClaudeAdapter spawns, sends a prompt, persists metadata, and kills", async () => {
    await initWorkspace(root);
    const ad = new ClaudeAdapter(root, {
      command: "bash --norc -i",
      sessionName: uniqueSession(),
    });
    cleanup.push(() => ad.kill());

    await ad.spawn();
    expect(await ad.isAlive()).toBe(true);

    await ad.prompt("printf 'PROMPT_OK_99'");
    await new Promise((r) => setTimeout(r, 600));

    const meta = JSON.parse(readFileSync(join(paths(root).sessionsDir, `${ad.sessionName}.json`), "utf8"));
    expect(meta.agent).toBe("CLAUDE");
    expect(meta.lastPromptPreview).toContain("PROMPT_OK_99");

    await ad.kill();
    expect(await ad.isAlive()).toBe(false);
  });

  it("Codex adapter parses input/output/reasoning_tokens lines", async () => {
    await initWorkspace(root);
    const ad = new CodexAdapter(root, {
      command: "bash --norc -i",
      sessionName: uniqueSession(),
    });
    cleanup.push(() => ad.kill());
    await ad.spawn();
    await ad.prompt(
      "printf 'input_tokens: 1,200\\noutput_tokens: 50\\nreasoning_tokens: 25\\n'",
    );
    await new Promise((r) => setTimeout(r, 700));
    const usage = await ad.readUsage();
    expect(usage).not.toBeNull();
    expect(usage!.tokens).toBe(1200 + 50 + 25);
    expect(usage!.source).toMatch(/codex/);
  });

  it("Claude adapter parses statusline tokens N / M", async () => {
    await initWorkspace(root);
    const ad = new ClaudeAdapter(root, {
      command: "bash --norc -i",
      sessionName: uniqueSession(),
    });
    cleanup.push(() => ad.kill());
    await ad.spawn();
    await ad.prompt("printf 'tokens: 152,300 / 200,000\\n'");
    await new Promise((r) => setTimeout(r, 600));
    const usage = await ad.readUsage();
    expect(usage).not.toBeNull();
    expect(usage!.tokens).toBe(152300);
  });

  it("Gemini adapter parses 'Tokens used: N'", async () => {
    await initWorkspace(root);
    const ad = new GeminiAdapter(root, {
      command: "bash --norc -i",
      sessionName: uniqueSession(),
    });
    cleanup.push(() => ad.kill());
    await ad.spawn();
    await ad.prompt("printf 'Tokens used: 8421\\n'");
    await new Promise((r) => setTimeout(r, 600));
    const usage = await ad.readUsage();
    expect(usage).not.toBeNull();
    expect(usage!.tokens).toBe(8421);
  });

  it("buildAdapters returns one adapter per agent with correct session names", () => {
    const set = buildAdapters(root);
    expect(set.CLAUDE.sessionName).toBe("claude");
    expect(set.CODEX.sessionName).toBe("codex");
    expect(set.GEMINI.sessionName).toBe("gemini");
  });

  it("returns null usage when no parseable output is present", async () => {
    await initWorkspace(root);
    const ad = new ClaudeAdapter(root, {
      command: "bash --norc -i",
      sessionName: uniqueSession(),
    });
    cleanup.push(() => ad.kill());
    await ad.spawn();
    await ad.prompt("printf 'no usage info here\\n'");
    await new Promise((r) => setTimeout(r, 500));
    const usage = await ad.readUsage();
    expect(usage).toBeNull();
  });
});
