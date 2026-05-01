import { createHash } from "node:crypto";
import {
  appendChangelog,
  readBoard,
  writeBoard,
} from "./workspace.js";
import type { AgentName, Board, Phase } from "./types.js";

/**
 * Execution modes from PRD §18.
 *
 *   complex: PLAN → REVIEW_CODEX → REVIEW_GEMINI → MERGE → DONE
 *   simple:  IMPLEMENT (single agent) → DONE
 *
 * Each mode is a state machine over `board.control.PHASE`. Transitions are
 * driven by a single function (`advancePhase`) that consults a `Verdict`
 * supplied by the caller (which is the orchestrator after talking to agents).
 */
export type ExecutionMode = "complex" | "simple";

export type Verdict = "approve" | "reject" | "needs_changes";

export interface PhaseTransition {
  from: Phase;
  to: Phase;
  agent: AgentName | null;
  verdict: Verdict | null;
  reason: string;
}

const COMPLEX_FLOW: Record<Phase, { next: Record<Verdict, Phase> } | null> = {
  IDLE: null,
  PLAN: {
    next: {
      approve: "REVIEW_CODEX",
      reject: "PLAN",
      needs_changes: "PLAN",
    },
  },
  REVIEW_CODEX: {
    next: {
      approve: "REVIEW_GEMINI",
      reject: "PLAN",
      needs_changes: "PLAN",
    },
  },
  REVIEW_GEMINI: {
    next: {
      approve: "MERGE",
      reject: "PLAN",
      needs_changes: "PLAN",
    },
  },
  MERGE: {
    next: {
      approve: "DONE",
      reject: "PLAN",
      needs_changes: "PLAN",
    },
  },
  IMPLEMENT: null,
  DONE: null,
};

const COMPLEX_AGENT: Record<Phase, AgentName | null> = {
  IDLE: null,
  PLAN: "CLAUDE",
  REVIEW_CODEX: "CODEX",
  REVIEW_GEMINI: "GEMINI",
  MERGE: "CLAUDE",
  IMPLEMENT: null,
  DONE: null,
};

export function nextAgentForPhase(mode: ExecutionMode, phase: Phase): AgentName | null {
  if (mode === "complex") return COMPLEX_AGENT[phase];
  // simple mode: caller decides; default to NEXT_AGENT in board.
  return null;
}

export function advancePhase(
  mode: ExecutionMode,
  current: Phase,
  verdict: Verdict,
): { next: Phase; reason: string } {
  if (mode === "complex") {
    const node = COMPLEX_FLOW[current];
    if (!node) {
      return { next: current, reason: `phase ${current} has no transition` };
    }
    return { next: node.next[verdict], reason: `complex ${current} + ${verdict}` };
  }
  // simple
  if (current === "IMPLEMENT" && verdict === "approve") return { next: "DONE", reason: "simple done" };
  if (verdict === "approve") return { next: "DONE", reason: "simple approve" };
  return { next: current, reason: "simple stays" };
}

export interface DecisionEntry {
  at: string;
  phase: Phase;
  agent: AgentName | null;
  verdict: Verdict | null;
  inputsHash: string;
  outcome: string;
  notes?: string;
}

/**
 * Append a structured Decisions entry to the board.
 * Decisions are kept in board.decisions (free-text); we render as markdown.
 */
export async function recordDecision(
  root: string,
  entry: Omit<DecisionEntry, "at" | "inputsHash"> & { inputs: string },
): Promise<void> {
  const board = await readBoard(root);
  const at = new Date().toISOString();
  const inputsHash = createHash("sha256").update(entry.inputs).digest("hex").slice(0, 12);
  const line = [
    `### ${at} — ${entry.phase} / ${entry.agent ?? "—"} / ${entry.verdict ?? "—"}`,
    `inputs: ${inputsHash}`,
    `outcome: ${entry.outcome}`,
    entry.notes ? `notes: ${entry.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  board.decisions =
    board.decisions === "(empty)" ? line : `${board.decisions.trimEnd()}\n\n${line}`;
  await writeBoard(root, board);
  await appendChangelog(
    root,
    `- ${at} decision phase=${entry.phase} agent=${entry.agent} verdict=${entry.verdict} outcome="${entry.outcome}"`,
  );
}

/**
 * Apply a verdict: advance the phase, set NEXT_AGENT for the next step,
 * and (when DONE) flip STATUS=DONE.
 */
export async function applyVerdict(
  root: string,
  mode: ExecutionMode,
  verdict: Verdict,
  inputs: string,
  notes?: string,
): Promise<{ from: Phase; to: Phase; nextAgent: AgentName | null }> {
  const board = await readBoard(root);
  const from = board.control.PHASE;
  const { next: to, reason } = advancePhase(mode, from, verdict);
  const nextAgent = nextAgentForPhase(mode, to);

  const newBoard: Board = { ...board };
  newBoard.control = { ...board.control, PHASE: to };
  if (to === "DONE") {
    newBoard.control.STATUS = "DONE";
  } else if (nextAgent) {
    newBoard.control.NEXT_AGENT = nextAgent;
    newBoard.control.STATUS = "ACTIVE";
  }
  await writeBoard(root, newBoard);

  const entry: Omit<DecisionEntry, "at" | "inputsHash"> & { inputs: string } = {
    phase: from,
    agent: COMPLEX_AGENT[from] ?? null,
    verdict,
    outcome: `${from} → ${to} (${reason})`,
    inputs,
  };
  if (notes !== undefined) entry.notes = notes;
  await recordDecision(root, entry);

  return { from, to, nextAgent };
}

/**
 * Resolve a disagreement between Codex and Gemini. Both their verdicts are
 * recorded; CLAUDE is the tiebreaker.
 */
export interface ConflictResolution {
  codexVerdict: Verdict;
  geminiVerdict: Verdict;
  claudeVerdict: Verdict;
  outcome: Verdict;
}

export async function resolveConflict(
  root: string,
  conflict: ConflictResolution,
  inputs: string,
): Promise<void> {
  await recordDecision(root, {
    phase: "REVIEW_GEMINI",
    agent: "CLAUDE",
    verdict: conflict.outcome,
    outcome: `conflict resolved (codex=${conflict.codexVerdict}, gemini=${conflict.geminiVerdict}) → ${conflict.outcome}`,
    inputs,
    notes: `Claude tiebreaker on Codex/Gemini disagreement`,
  });
}

/** Reset the board to PLAN with mode=complex, ready to run a new task. */
export async function startComplexTask(
  root: string,
  taskId: string,
  objective: string,
): Promise<void> {
  const board = await readBoard(root);
  board.control = {
    TASK_ID: taskId,
    PHASE: "PLAN",
    TASK_TYPE: "FIX",
    NEXT_AGENT: "CLAUDE",
    STATUS: "ACTIVE",
  };
  board.objective = objective;
  await writeBoard(root, board);
  await appendChangelog(
    root,
    `- ${new Date().toISOString()} task ${taskId} started in complex mode: "${objective}"`,
  );
}

export async function startSimpleTask(
  root: string,
  taskId: string,
  agent: AgentName,
  objective: string,
): Promise<void> {
  const board = await readBoard(root);
  board.control = {
    TASK_ID: taskId,
    PHASE: "IMPLEMENT",
    TASK_TYPE: "FIX",
    NEXT_AGENT: agent,
    STATUS: "ACTIVE",
  };
  board.objective = objective;
  await writeBoard(root, board);
  await appendChangelog(
    root,
    `- ${new Date().toISOString()} task ${taskId} started in simple mode (${agent}): "${objective}"`,
  );
}
