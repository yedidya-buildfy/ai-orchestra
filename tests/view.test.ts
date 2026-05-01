import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { TmuxSession } from "../src/tmux.js";
import {
  createView,
  killView,
  resizeClaude,
  toggleSidekicks,
  viewExists,
} from "../src/view.js";

function tmux(args: string[]): Promise<number> {
  return new Promise((res) => {
    const c = spawn("tmux", args, { stdio: "ignore" });
    c.on("close", (code) => res(code ?? -1));
    c.on("error", () => res(-1));
  });
}

const tmuxOk = await TmuxSession.tmuxAvailable();
const dscribe = tmuxOk ? describe : describe.skip;

const created: string[] = [];

afterEach(async () => {
  await killView();
  for (const s of created.splice(0)) await tmux(["kill-session", "-t", s]);
});

function uniq(prefix: string): string {
  return `${prefix}-${randomBytes(3).toString("hex")}`;
}

dscribe("view layer (real tmux)", () => {
  it("creates a 3-pane view from three live sessions", async () => {
    const cs = uniq("v-claude");
    const xs = uniq("v-codex");
    const gs = uniq("v-gemini");
    for (const s of [cs, xs, gs]) {
      await tmux(["new-session", "-d", "-s", s, "bash --norc -i"]);
      created.push(s);
    }
    const r = await createView({
      claudeSession: cs,
      codexSession: xs,
      geminiSession: gs,
      autoShrinkMs: 0,
    });
    expect(r.viewSession).toBe("orchestra-view");
    expect(await viewExists()).toBe(true);
  });

  it("toggleSidekicks zooms / unzooms the claude pane", async () => {
    const cs = uniq("v-claude");
    const xs = uniq("v-codex");
    const gs = uniq("v-gemini");
    for (const s of [cs, xs, gs]) {
      await tmux(["new-session", "-d", "-s", s, "bash --norc -i"]);
      created.push(s);
    }
    await createView({
      claudeSession: cs,
      codexSession: xs,
      geminiSession: gs,
      autoShrinkMs: 0,
    });
    const r1 = await toggleSidekicks();
    expect(r1.toggled).toBe(true);
    const r2 = await toggleSidekicks();
    expect(r2.toggled).toBe(true);
  });

  it("resizeClaude succeeds with a sane percentage", async () => {
    const cs = uniq("v-claude");
    const xs = uniq("v-codex");
    const gs = uniq("v-gemini");
    for (const s of [cs, xs, gs]) {
      await tmux(["new-session", "-d", "-s", s, "bash --norc -i"]);
      created.push(s);
    }
    await createView({
      claudeSession: cs,
      codexSession: xs,
      geminiSession: gs,
      autoShrinkMs: 0,
    });
    const r = await resizeClaude(70);
    expect(r.ok).toBe(true);
  });

  it("toggleSidekicks reports a clean failure when view is absent", async () => {
    await killView();
    const r = await toggleSidekicks();
    expect(r.toggled).toBe(false);
    expect(r.reason).toMatch(/not running/);
  });
});
