import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TmuxSession } from "../src/tmux.js";

const tmuxOk = await TmuxSession.tmuxAvailable();
const dscribe = tmuxOk ? describe : describe.skip;

let dir: string;
const sessions: TmuxSession[] = [];

beforeAll(() => {
  if (!tmuxOk) console.warn("tmux not available — skipping tmux tests");
});

afterEach(async () => {
  for (const s of sessions.splice(0)) {
    try {
      await s.stop();
    } catch {
      // ignore
    }
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function uniqueName(): string {
  return `orch-test-${randomBytes(4).toString("hex")}`;
}

dscribe("TmuxSession", () => {
  it("starts, reports alive, sends keys, captures, and stops", async () => {
    dir = mkdtempSync(join(tmpdir(), "orch-tmux-"));
    const pipe = join(dir, "pane.log");
    const s = new TmuxSession({
      name: uniqueName(),
      command: "bash --norc -i",
      cwd: dir,
      pipeFile: pipe,
    });
    sessions.push(s);

    expect(await s.isAlive()).toBe(false);
    await s.start();
    expect(await s.isAlive()).toBe(true);

    await s.send("printf 'HELLO_TMUX_TOKEN_42'");
    // give bash a moment to render output to the pane and flush to pipe
    await new Promise((r) => setTimeout(r, 600));

    const captured = await s.capture(50);
    expect(captured).toContain("HELLO_TMUX_TOKEN_42");

    const piped = await s.readPipeBuffer();
    expect(piped).toContain("HELLO_TMUX_TOKEN_42");

    await s.stop();
    expect(await s.isAlive()).toBe(false);
  });

  it("rejects invalid session names", () => {
    expect(() => new TmuxSession({ name: "bad name!", command: "true" })).toThrow();
    expect(() => new TmuxSession({ name: "ok-name_42", command: "true" })).not.toThrow();
  });

  it("restart kills and respawns the session", async () => {
    dir = mkdtempSync(join(tmpdir(), "orch-tmux-"));
    const s = new TmuxSession({
      name: uniqueName(),
      command: "bash --norc -i",
      cwd: dir,
    });
    sessions.push(s);
    await s.start();
    expect(await s.isAlive()).toBe(true);
    await s.restart();
    expect(await s.isAlive()).toBe(true);
  });

  it("readPipeBuffer returns last N bytes of large logs", async () => {
    dir = mkdtempSync(join(tmpdir(), "orch-tmux-"));
    const pipe = join(dir, "pane.log");
    const s = new TmuxSession({
      name: uniqueName(),
      command: "bash --norc -i",
      cwd: dir,
      pipeFile: pipe,
    });
    sessions.push(s);
    await s.start();
    await s.send("for i in $(seq 1 200); do printf 'line%03d\\n' $i; done");
    await new Promise((r) => setTimeout(r, 1000));
    const tail = await s.readPipeBuffer(2000);
    expect(tail.length).toBeLessThanOrEqual(2000);
    expect(tail).toContain("line200");
  });
});
