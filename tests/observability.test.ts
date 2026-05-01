import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace, paths, readBoard, writeBoard } from "../src/workspace.js";
import { doctor, recoverFromCrash, status, tailLog } from "../src/observability.js";
import { appendOnly } from "../src/fs-atomic.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orch-obs-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("doctor", () => {
  it("reports failures when workspace missing, passes after init", async () => {
    const r1 = await doctor(root);
    expect(r1.ok).toBe(false);
    expect(r1.checks.find((c) => c.name === ".orchestra/ exists")?.ok).toBe(false);

    await initWorkspace(root);
    const r2 = await doctor(root);
    // tmux should be there in dev env; tokenizers loadable; workspace exists.
    const wsCheck = r2.checks.find((c) => c.name === ".orchestra/ exists")!;
    expect(wsCheck.ok).toBe(true);
    const tokCheck = r2.checks.find((c) => c.name === "tokenizers loadable")!;
    expect(tokCheck.ok).toBe(true);
  });
});

describe("status", () => {
  it("summarises board + context + agents", async () => {
    await initWorkspace(root);
    const s = await status(root);
    expect(s.board.taskId).toBe("000");
    expect(s.board.phase).toBe("IDLE");
    expect(s.agents.map((a) => a.name)).toEqual(["CLAUDE", "CODEX", "GEMINI"]);
    // alive flag depends on global tmux state; just verify the shape.
    for (const a of s.agents) expect(typeof a.alive).toBe("boolean");
  });
});

describe("tailLog", () => {
  it("returns empty for missing log", async () => {
    await initWorkspace(root);
    const t = await tailLog(root, "nonexistent");
    expect(t).toBe("");
  });

  it("returns last N lines of an existing log", async () => {
    await initWorkspace(root);
    const p = paths(root);
    const log = join(p.logsDir, "orchestrator.log");
    writeFileSync(log, Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n") + "\n");
    const t = await tailLog(root, "orchestrator", 3);
    // Last 3 non-trailing lines plus trailing empty.
    expect(t).toContain("line9");
    expect(t).not.toContain("line0");
  });
});

describe("recoverFromCrash", () => {
  it("flips ACTIVE → WAITING when last changelog line was a dispatch", async () => {
    await initWorkspace(root);
    const b = await readBoard(root);
    b.control.STATUS = "ACTIVE";
    b.control.NEXT_AGENT = "CODEX";
    await writeBoard(root, b);
    await appendOnly(paths(root).changelog, "- 2026-05-01 dispatched CODEX (task 1)");
    const r = await recoverFromCrash(root);
    expect(r.recovered).toBe(true);
    const after = await readBoard(root);
    expect(after.control.STATUS).toBe("WAITING");
  });

  it("does nothing when state is consistent", async () => {
    await initWorkspace(root);
    const r = await recoverFromCrash(root);
    expect(r.recovered).toBe(false);
  });
});
