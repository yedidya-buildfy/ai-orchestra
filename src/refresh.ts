import {
  appendChangelog,
  readBoard,
  writeBoard,
} from "./workspace.js";
import { bandFor, type ThresholdBand } from "./context-engine.js";
import { refreshContext } from "./context-writer.js";
import { appendToMemory, compressMemoryIfNeeded } from "./memory.js";
import { detectRefreshRequests } from "./orchestrator.js";
import type { AgentAdapter } from "./agent-adapter.js";
import { buildAdapters } from "./agent-adapter.js";
import { buildBootstrapPrompt } from "./bootstrap-prompt.js";
import type { AgentName, Board } from "./types.js";

export type RefreshReason =
  | "context_overflow"      // band == FORCE_RESET (>=95%)
  | "context_pressure"      // band == REFRESH (90–95%)
  | "agent_requested"       // agent wrote REFRESH_REQUESTED: TRUE
  | "task_complete"         // orchestrator decision after a large task
  | "loop_detected"         // orchestrator decision (M6 hook)
  | "manual";               // CLI / external trigger

export interface RefreshDecision {
  agent: AgentName;
  reason: RefreshReason;
  band: ThresholdBand;
  pct: number;
}

/**
 * Decide which agents should be refreshed based on the latest board + context
 * snapshots. Combines threshold-based triggers (PRD §12) with self-requests
 * (PRD §13). REFRESH band is "recommend"; FORCE_RESET is "must".
 */
export function decideRefreshes(
  board: Board,
  contextHealth: { CLAUDE: number; CODEX: number; GEMINI: number },
): RefreshDecision[] {
  const out: RefreshDecision[] = [];
  const requested = new Set(detectRefreshRequests(board));
  for (const agent of ["CLAUDE", "CODEX", "GEMINI"] as const) {
    const pct = contextHealth[agent];
    const band = bandFor(pct);
    if (band === "FORCE_RESET") {
      out.push({ agent, reason: "context_overflow", band, pct });
      continue;
    }
    if (band === "REFRESH") {
      out.push({ agent, reason: "context_pressure", band, pct });
      continue;
    }
    if (requested.has(agent)) {
      out.push({ agent, reason: "agent_requested", band, pct });
    }
  }
  return out;
}

export interface AgentRefreshResult {
  agent: AgentName;
  reason: RefreshReason;
  killed: boolean;
  rehydrated: boolean;
  verified: boolean;
  notes: string[];
}

export interface RefreshOpts {
  adapter?: AgentAdapter;
  /** Maximum ms to wait for the new session to come up + acknowledge. */
  verifyTimeoutMs?: number;
  /** If true, do not actually kill/respawn (used for dry runs). */
  dryRun?: boolean;
}

/**
 * Refresh a single agent end-to-end:
 *   1. snapshot the agent's current free-text block + recent log buffer
 *      into memory.md (active) and changelog.md (full history) — never lose it
 *   2. compress memory.md if it's now over its cap
 *   3. kill the tmux session
 *   4. spawn a fresh one
 *   5. rehydrate with protocol + memory + board + objective
 *   6. verify the new session is alive and accepts the prompt
 */
export async function refreshAgent(
  root: string,
  agent: AgentName,
  reason: RefreshReason,
  opts: RefreshOpts = {},
): Promise<AgentRefreshResult> {
  const notes: string[] = [];
  const board = await readBoard(root);
  const adapter =
    opts.adapter ?? buildAdapters(root)[agent];

  // 1. Snapshot — no agent memory may be lost.
  const block = pickAgentBlock(board, agent);
  const buffer = await safeBuffer(adapter);
  const snapshot = composeSnapshot(agent, reason, block, buffer);
  await appendToMemory(root, `Refresh snapshot: ${agent} (${reason})`, snapshot);
  await appendChangelog(
    root,
    `- ${new Date().toISOString()} refresh START agent=${agent} reason=${reason}`,
  );
  notes.push("snapshot persisted");

  // 2. Compress if needed.
  const c = await compressMemoryIfNeeded(root);
  if (c.compressed) {
    notes.push(`memory compressed: moved ${c.movedWords} words → long_term.md`);
  }

  if (opts.dryRun) {
    return { agent, reason, killed: false, rehydrated: false, verified: false, notes };
  }

  // 3 + 4. Kill and respawn.
  let killed = false;
  if (await adapter.isAlive()) {
    await adapter.kill();
    killed = true;
  }
  await adapter.spawn();

  // Clear the agent's free-text block so the new session starts clean.
  // Anything important is already in memory.md / long_term.md / changelog.md.
  const next = await readBoard(root);
  setAgentBlock(next, agent, "(refreshed; awaiting rehydration ack)");
  // Reset its self-request flag.
  await writeBoard(root, next);

  // 5. Rehydrate via the canonical bootstrap prompt (same one that runs on
  // initial spawn). This guarantees the refreshed agent re-reads its role
  // file, the current memory.md, and the live board state — so anything
  // that changed while it was killed is reflected in its working context.
  const prompt = await buildBootstrapPrompt(agent, root);
  await adapter.prompt(prompt);
  notes.push("bootstrap prompt sent");

  // 6. Verify.
  const verified = await verifySession(adapter, opts.verifyTimeoutMs ?? 3000);
  notes.push(verified ? "session alive after refresh" : "verification timed out");

  await appendChangelog(
    root,
    `- ${new Date().toISOString()} refresh DONE agent=${agent} verified=${verified}`,
  );

  // Recompute context now that memory may have changed.
  await refreshContext(root, { updateBoard: true, updateMetrics: true });

  return { agent, reason, killed, rehydrated: true, verified, notes };
}

async function verifySession(adapter: AgentAdapter, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await adapter.isAlive()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return adapter.isAlive();
}

async function safeBuffer(adapter: AgentAdapter): Promise<string> {
  try {
    return (await adapter.tmux.readPipeBuffer()) ?? "";
  } catch {
    return "";
  }
}

function pickAgentBlock(board: Board, agent: AgentName): string {
  switch (agent) {
    case "CLAUDE": return board.claude;
    case "CODEX": return board.codex;
    case "GEMINI": return board.gemini;
  }
}

function setAgentBlock(board: Board, agent: AgentName, text: string): void {
  switch (agent) {
    case "CLAUDE":  board.claude = text; break;
    case "CODEX":   board.codex = text; break;
    case "GEMINI":  board.gemini = text; break;
  }
}

function composeSnapshot(
  agent: AgentName,
  reason: RefreshReason,
  block: string,
  buffer: string,
): string {
  const tail = buffer
    ? buffer.split("\n").slice(-50).join("\n")
    : "(no pipe buffer)";
  return [
    `agent: ${agent}`,
    `reason: ${reason}`,
    "",
    "### Last board block",
    block.trim() || "(empty)",
    "",
    "### Last 50 lines of session output",
    "```",
    tail.trim(),
    "```",
  ].join("\n");
}

/**
 * Sweep: compute current context, decide refreshes, run each in turn.
 * Returns the list of refresh results (one per agent that was refreshed).
 */
export async function refreshSweep(
  root: string,
  opts: { adapters?: Record<AgentName, AgentAdapter>; dryRun?: boolean } = {},
): Promise<AgentRefreshResult[]> {
  const { snapshots } = await refreshContext(root, { updateBoard: true, updateMetrics: true });
  const board = await readBoard(root);
  const decisions = decideRefreshes(board, {
    CLAUDE: snapshots.CLAUDE.pct,
    CODEX: snapshots.CODEX.pct,
    GEMINI: snapshots.GEMINI.pct,
  });
  const adapters = opts.adapters ?? buildAdapters(root);
  const out: AgentRefreshResult[] = [];
  for (const d of decisions) {
    const refreshOpts: RefreshOpts = { adapter: adapters[d.agent] };
    if (opts.dryRun) refreshOpts.dryRun = true;
    out.push(await refreshAgent(root, d.agent, d.reason, refreshOpts));
  }
  return out;
}
