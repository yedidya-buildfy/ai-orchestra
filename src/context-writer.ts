import { atomicWrite } from "./fs-atomic.js";
import { paths, readBoard, writeBoard } from "./workspace.js";
import {
  CONTEXT_WINDOWS,
  measureAll,
  type AllSnapshots,
  type MeasureInput,
} from "./context-engine.js";
import { buildTokenizers, type TokenizerSet } from "./tokenizer.js";
import type { AgentName } from "./types.js";

/**
 * Optional runtime overrides — token counts reported by the running agent
 * itself (statusline / Codex usage block). When provided, the engine uses
 * them verbatim and skips the file-based estimation.
 */
export interface RuntimeOverrides {
  CLAUDE?: number;
  CODEX?: number;
  GEMINI?: number;
}

export interface RefreshOptions {
  /** Override token windows (defaults to PRD §9). */
  windows?: Partial<Record<AgentName, number>>;
  /** Runtime token counts per agent if known. */
  runtime?: RuntimeOverrides;
  /** Inject a custom tokenizer set (used in tests). */
  tokenizers?: TokenizerSet;
  /** Write Context Health back to board.md (default: true). Set false from inside the orchestrator to avoid self-trigger loops. */
  updateBoard?: boolean;
  /** Write metrics/context.json (default: true). */
  updateMetrics?: boolean;
}

/**
 * Build the default per-agent measurement inputs from a workspace.
 * Per PRD §17: load board + memory by default. Specific file scopes for
 * Codex/Gemini will be wired in M4 once the watcher dispatches with scope.
 */
export function defaultInputs(root: string, opts: RefreshOptions = {}): {
  CLAUDE: MeasureInput;
  CODEX: MeasureInput;
  GEMINI: MeasureInput;
} {
  const p = paths(root);
  const w = (a: AgentName) => opts.windows?.[a] ?? CONTEXT_WINDOWS[a];
  const files = [p.board, p.memory];
  const r = opts.runtime ?? {};

  const make = (agent: AgentName, runtime: number | undefined): MeasureInput => {
    const base: MeasureInput = { agent, files, windowMax: w(agent) };
    return runtime !== undefined ? { ...base, runtimeTokens: runtime } : base;
  };

  return {
    CLAUDE: make("CLAUDE", r.CLAUDE),
    CODEX: make("CODEX", r.CODEX),
    GEMINI: make("GEMINI", r.GEMINI),
  };
}

export interface RefreshResult {
  snapshots: AllSnapshots;
  metricsPath: string;
}

/**
 * Measure all three agents, then atomically update:
 *   - board.md → Context Health section
 *   - metrics/context.json → { claude, codex, gemini } as 0..1 fractions plus per-agent detail
 */
export async function refreshContext(
  root: string,
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  const tokenizers = opts.tokenizers ?? buildTokenizers();
  const inputs = defaultInputs(root, opts);
  const snapshots = await measureAll(inputs, tokenizers);

  const updateBoard = opts.updateBoard !== false;
  const updateMetrics = opts.updateMetrics !== false;

  if (updateBoard) {
    const board = await readBoard(root);
    board.contextHealth = {
      CLAUDE: snapshots.CLAUDE.pct,
      CODEX: snapshots.CODEX.pct,
      GEMINI: snapshots.GEMINI.pct,
    };
    await writeBoard(root, board);
  }

  const p = paths(root);
  if (updateMetrics) {
    const metricsBody = {
      claude: snapshots.CLAUDE.pct,
      codex: snapshots.CODEX.pct,
      gemini: snapshots.GEMINI.pct,
      detail: {
        CLAUDE: serializeSnapshot(snapshots.CLAUDE),
        CODEX: serializeSnapshot(snapshots.CODEX),
        GEMINI: serializeSnapshot(snapshots.GEMINI),
      },
      updatedAt: new Date().toISOString(),
    };
    await atomicWrite(p.metrics, JSON.stringify(metricsBody, null, 2) + "\n", {
      bypassGuard: true,
    });
  }

  return { snapshots, metricsPath: p.metrics };
}

function serializeSnapshot(s: AllSnapshots[AgentName]) {
  return {
    tokens: s.tokens,
    rawTokens: s.rawTokens,
    windowMax: s.windowMax,
    pct: s.pct,
    band: s.band,
    source: s.source,
    tokenizer: s.tokenizer,
    bufferApplied: s.bufferApplied,
  };
}
