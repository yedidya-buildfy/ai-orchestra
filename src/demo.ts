import { initWorkspace, readBoard } from "./workspace.js";
import {
  applyVerdict,
  startComplexTask,
  resolveConflict,
} from "./execution-mode.js";

/**
 * End-to-end demo: complex-mode task that walks through all phases.
 *
 * This runner is deterministic: it does not require live Claude/Codex/Gemini
 * sessions to demonstrate the state machine, decision log, and changelog flow.
 * To run with real agents, drop the `applyVerdict` calls and let the
 * orchestrator dispatch + read agent responses instead.
 *
 * Demonstrated invariants:
 *   - PHASE walks PLAN → REVIEW_CODEX → REVIEW_GEMINI → MERGE → DONE
 *   - NEXT_AGENT updates correctly at every transition
 *   - Decisions section captures every verdict with an inputs hash
 *   - Conflict resolution is logged when reviewers disagree
 */
export async function runDemo(root: string): Promise<{
  finalPhase: string;
  decisionsCount: number;
}> {
  await initWorkspace(root, { force: true });
  await startComplexTask(root, "001", "Fix ZIP validation bug");

  // CLAUDE finishes a plan
  await applyVerdict(root, "complex", "approve", "plan v1: add stricter regex", "plan ready");

  // CODEX reviews and disagrees with Gemini-style suggestion: approves
  await applyVerdict(
    root,
    "complex",
    "approve",
    "code review: regex change isolated to src/api/zip.ts",
    "looks correct, no perf concerns",
  );

  // GEMINI also reviews. Suppose it requests changes for UX consistency.
  await applyVerdict(
    root,
    "complex",
    "needs_changes",
    "ux review: error message wording",
    "rephrase 'invalid zip' to match other validation copy",
  );

  // After Gemini's needs_changes, the loop sends us back to PLAN.
  // Claude updates the plan; agents re-review.
  await applyVerdict(root, "complex", "approve", "plan v2: regex + reworded error", "plan v2");
  await applyVerdict(
    root,
    "complex",
    "approve",
    "code review v2: same regex, message updated",
    "ok",
  );

  // Disagreement scenario: Codex approve, Gemini reject. We log the conflict
  // and resolve via Claude.
  await resolveConflict(
    root,
    {
      codexVerdict: "approve",
      geminiVerdict: "reject",
      claudeVerdict: "approve",
      outcome: "approve",
    },
    "claude tiebreaker after codex/gemini disagreement",
  );
  // Now the actual REVIEW_GEMINI phase verdict (matching the resolution).
  await applyVerdict(root, "complex", "approve", "ux review v2: ok with caveats", "approved");

  // MERGE phase
  await applyVerdict(root, "complex", "approve", "merge: applied to main", "merged");

  const board = await readBoard(root);
  const decisions = board.decisions === "(empty)" ? 0 : board.decisions.split(/\n###\s+/).length;
  return { finalPhase: board.control.PHASE, decisionsCount: decisions };
}
