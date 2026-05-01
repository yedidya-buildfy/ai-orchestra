import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace, paths, readBoard } from "../src/workspace.js";
import {
  advancePhase,
  applyVerdict,
  nextAgentForPhase,
  recordDecision,
  resolveConflict,
  startComplexTask,
  startSimpleTask,
} from "../src/execution-mode.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orch-mode-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("complex-mode state machine", () => {
  it("PLAN → REVIEW_CODEX on approve", () => {
    expect(advancePhase("complex", "PLAN", "approve").next).toBe("REVIEW_CODEX");
  });
  it("REVIEW_CODEX → REVIEW_GEMINI on approve", () => {
    expect(advancePhase("complex", "REVIEW_CODEX", "approve").next).toBe("REVIEW_GEMINI");
  });
  it("REVIEW_GEMINI → MERGE on approve", () => {
    expect(advancePhase("complex", "REVIEW_GEMINI", "approve").next).toBe("MERGE");
  });
  it("MERGE → DONE on approve", () => {
    expect(advancePhase("complex", "MERGE", "approve").next).toBe("DONE");
  });
  it("any reject sends back to PLAN", () => {
    expect(advancePhase("complex", "REVIEW_GEMINI", "reject").next).toBe("PLAN");
    expect(advancePhase("complex", "MERGE", "needs_changes").next).toBe("PLAN");
  });
  it("nextAgentForPhase maps phases to agents", () => {
    expect(nextAgentForPhase("complex", "PLAN")).toBe("CLAUDE");
    expect(nextAgentForPhase("complex", "REVIEW_CODEX")).toBe("CODEX");
    expect(nextAgentForPhase("complex", "REVIEW_GEMINI")).toBe("GEMINI");
    expect(nextAgentForPhase("complex", "MERGE")).toBe("CLAUDE");
  });
});

describe("applyVerdict + decisions", () => {
  it("walks the full happy-path complex flow", async () => {
    await initWorkspace(root);
    await startComplexTask(root, "T-1", "the objective");
    let b = await readBoard(root);
    expect(b.control.PHASE).toBe("PLAN");
    expect(b.control.NEXT_AGENT).toBe("CLAUDE");

    await applyVerdict(root, "complex", "approve", "plan", "ok");
    b = await readBoard(root);
    expect(b.control.PHASE).toBe("REVIEW_CODEX");
    expect(b.control.NEXT_AGENT).toBe("CODEX");

    await applyVerdict(root, "complex", "approve", "review-codex", "ok");
    b = await readBoard(root);
    expect(b.control.PHASE).toBe("REVIEW_GEMINI");
    expect(b.control.NEXT_AGENT).toBe("GEMINI");

    await applyVerdict(root, "complex", "approve", "review-gemini", "ok");
    b = await readBoard(root);
    expect(b.control.PHASE).toBe("MERGE");
    expect(b.control.NEXT_AGENT).toBe("CLAUDE");

    await applyVerdict(root, "complex", "approve", "merge", "ok");
    b = await readBoard(root);
    expect(b.control.PHASE).toBe("DONE");
    expect(b.control.STATUS).toBe("DONE");

    // Decisions captured every step.
    expect((b.decisions.match(/^### /gm) ?? []).length).toBeGreaterThanOrEqual(4);

    // Changelog has decision entries.
    const cl = readFileSync(paths(root).changelog, "utf8");
    expect(cl).toMatch(/decision phase=PLAN agent=CLAUDE verdict=approve/);
    expect(cl).toMatch(/decision phase=MERGE agent=CLAUDE verdict=approve/);
  });

  it("reject during REVIEW sends back to PLAN", async () => {
    await initWorkspace(root);
    await startComplexTask(root, "T-2", "x");
    await applyVerdict(root, "complex", "approve", "p", undefined);
    await applyVerdict(root, "complex", "reject", "c", "wrong approach");
    const b = await readBoard(root);
    expect(b.control.PHASE).toBe("PLAN");
    expect(b.control.NEXT_AGENT).toBe("CLAUDE");
  });
});

describe("simple mode", () => {
  it("IMPLEMENT → DONE on approve", async () => {
    await initWorkspace(root);
    await startSimpleTask(root, "S-1", "GEMINI", "do a thing");
    let b = await readBoard(root);
    expect(b.control.PHASE).toBe("IMPLEMENT");
    expect(b.control.NEXT_AGENT).toBe("GEMINI");
    await applyVerdict(root, "simple", "approve", "did it", undefined);
    b = await readBoard(root);
    expect(b.control.PHASE).toBe("DONE");
    expect(b.control.STATUS).toBe("DONE");
  });
});

describe("resolveConflict", () => {
  it("logs a conflict resolution and changelog entry", async () => {
    await initWorkspace(root);
    await startComplexTask(root, "T-3", "x");
    await applyVerdict(root, "complex", "approve", "plan", undefined);
    await applyVerdict(root, "complex", "approve", "codex", undefined);
    await resolveConflict(
      root,
      {
        codexVerdict: "approve",
        geminiVerdict: "reject",
        claudeVerdict: "approve",
        outcome: "approve",
      },
      "tiebreaker",
    );
    const b = await readBoard(root);
    expect(b.decisions).toMatch(/conflict resolved \(codex=approve, gemini=reject\) → approve/);
  });
});

describe("recordDecision input hashing", () => {
  it("includes a stable inputs-hash prefix", async () => {
    await initWorkspace(root);
    await startComplexTask(root, "T-4", "x");
    await recordDecision(root, {
      phase: "PLAN",
      agent: "CLAUDE",
      verdict: "approve",
      inputs: "deterministic-string",
      outcome: "x",
    });
    const b = await readBoard(root);
    // SHA-256 first 12 chars stable for a given string.
    expect(b.decisions).toMatch(/inputs: [a-f0-9]{12}/);
  });
});
