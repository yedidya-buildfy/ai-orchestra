import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDemo } from "../src/demo.js";
import { paths } from "../src/workspace.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orch-demo-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("complex-mode demo", () => {
  it("walks PLAN → DONE with conflict resolution and produces a clean changelog", async () => {
    const r = await runDemo(root);
    expect(r.finalPhase).toBe("DONE");
    expect(r.decisionsCount).toBeGreaterThanOrEqual(7);

    const cl = readFileSync(paths(root).changelog, "utf8");
    // sequence: task started → PLAN/CODEX/GEMINI verdicts → conflict → MERGE
    expect(cl).toMatch(/task 001 started in complex mode/);
    expect(cl).toMatch(/decision phase=PLAN.*verdict=approve/);
    expect(cl).toMatch(/decision phase=REVIEW_CODEX.*verdict=approve/);
    expect(cl).toMatch(/decision phase=REVIEW_GEMINI.*verdict=needs_changes/);
    expect(cl).toMatch(/decision phase=MERGE.*verdict=approve/);
  });

  it("re-running the demo from a fresh init reproduces a clean changelog", async () => {
    const r1 = await runDemo(root);
    const cl1 = readFileSync(paths(root).changelog, "utf8");
    const r2 = await runDemo(root); // force=true wipes
    const cl2 = readFileSync(paths(root).changelog, "utf8");
    expect(r1.finalPhase).toBe(r2.finalPhase);
    // Both runs end in DONE with same decision count.
    expect(r1.decisionsCount).toBe(r2.decisionsCount);
    // changelog contents on second run start fresh (have one task-start line).
    expect((cl2.match(/task 001 started/g) ?? []).length).toBe(1);
  });
});
