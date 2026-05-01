import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import chokidar, { type FSWatcher } from "chokidar";
import {
  appendChangelog,
  paths,
  readBoard,
  writeBoard,
} from "./workspace.js";
import { acquireWriterLock, type ReleaseLock } from "./lock.js";
import { refreshContext } from "./context-writer.js";
import { buildAdapters, type AgentAdapter } from "./agent-adapter.js";
import type { AdapterFactoryConfig } from "./agent-adapter.js";
import type { AgentName, Board } from "./types.js";

export type OrchestratorEventKind =
  | "tick_start"
  | "tick_skip"
  | "tick_dispatch"
  | "tick_done"
  | "tick_error"
  | "watcher_started"
  | "watcher_stopped"
  | "refresh_requested"
  | "permission_denied";

export interface OrchestratorEvent {
  kind: OrchestratorEventKind;
  at: string;
  msg: string;
  data?: Record<string, unknown>;
}

export interface OrchestratorOptions {
  /** Map agent name → adapter. Default: real tmux adapters. */
  adapters?: Record<AgentName, AgentAdapter>;
  /** Watcher debounce in ms (defaults to 200). */
  debounceMs?: number;
  /** Disable spawning real CLIs (used in tests). */
  dryRun?: boolean;
  /** Sink for structured events (default: append to logs/orchestrator.log). */
  onEvent?: (e: OrchestratorEvent) => void;
}

/**
 * Decide whether the current board is dispatchable. We dispatch when:
 *   - STATUS is ACTIVE
 *   - NEXT_AGENT is a known agent
 *   - the agent's adapter is alive (or can be brought up — handled by dispatch)
 */
function shouldDispatch(board: Board): { ok: true } | { ok: false; reason: string } {
  if (board.control.STATUS !== "ACTIVE") {
    return { ok: false, reason: `STATUS=${board.control.STATUS}` };
  }
  const a = board.control.NEXT_AGENT;
  if (!["CLAUDE", "CODEX", "GEMINI"].includes(a)) {
    return { ok: false, reason: `unknown NEXT_AGENT=${a}` };
  }
  return { ok: true };
}

/**
 * Build the rehydration prompt for an agent: protocol + memory + board + objective.
 * Per PRD §17: never include changelog.md or long_term.md wholesale.
 */
async function buildDispatchPrompt(root: string, agent: AgentName, board: Board): Promise<string> {
  const p = paths(root);
  const protocol = await fs.readFile(p.protocol, "utf8").catch(() => "");
  const memory = await fs.readFile(p.memory, "utf8").catch(() => "");
  const boardText = await fs.readFile(p.board, "utf8").catch(() => "");
  return [
    `# Dispatch to ${agent}`,
    `TASK_ID: ${board.control.TASK_ID}`,
    `PHASE: ${board.control.PHASE}`,
    `STATUS: ${board.control.STATUS}`,
    "",
    "## protocol.md",
    protocol.trimEnd(),
    "",
    "## memory.md",
    memory.trimEnd(),
    "",
    "## board.md",
    boardText.trimEnd(),
    "",
    "## Objective",
    board.objective,
  ].join("\n");
}

/**
 * Detect agent self-refresh requests in the per-agent free-text blocks.
 * The protocol asks an agent in trouble to write `REFRESH_REQUESTED: TRUE`.
 */
export function detectRefreshRequests(board: Board): AgentName[] {
  const blocks: [AgentName, string][] = [
    ["CLAUDE", board.claude],
    ["CODEX", board.codex],
    ["GEMINI", board.gemini],
  ];
  const out: AgentName[] = [];
  for (const [name, text] of blocks) {
    if (/REFRESH_REQUESTED:\s*TRUE/i.test(text)) out.push(name);
  }
  return out;
}

export class Orchestrator {
  readonly root: string;
  private adapters: Record<AgentName, AgentAdapter> | undefined;
  private debounceMs: number;
  private dryRun: boolean;
  private onEvent: (e: OrchestratorEvent) => void;
  private watcher: FSWatcher | null = null;
  private inflight = false;
  private pending = false;
  private lastSelfWriteHash: string | null = null;
  private pendingLogs: Set<Promise<void>> = new Set();

  constructor(root: string, opts: OrchestratorOptions = {}) {
    this.root = root;
    this.debounceMs = opts.debounceMs ?? 200;
    this.dryRun = opts.dryRun ?? false;
    if (opts.adapters) this.adapters = opts.adapters;
    this.onEvent =
      opts.onEvent ??
      ((e) => {
        const pr = this.appendLog(e);
        this.pendingLogs.add(pr);
        void pr.finally(() => this.pendingLogs.delete(pr));
      });
  }

  private async appendLog(e: OrchestratorEvent): Promise<void> {
    try {
      const p = paths(this.root);
      await fs.mkdir(p.logsDir, { recursive: true });
      await fs.appendFile(
        join(p.logsDir, "orchestrator.log"),
        JSON.stringify(e) + "\n",
        "utf8",
      );
    } catch {
      // best-effort logging; never let observability fail the orchestrator
    }
  }

  private getAdapters(): Record<AgentName, AgentAdapter> {
    if (!this.adapters) this.adapters = buildAdapters(this.root) as Record<AgentName, AgentAdapter>;
    return this.adapters;
  }

  /** Run a single orchestration tick. Returns the action taken. */
  async tick(): Promise<{ action: "dispatched" | "skipped" | "error"; agent?: AgentName; reason?: string }> {
    const startedAt = new Date().toISOString();
    this.onEvent({ kind: "tick_start", at: startedAt, msg: "tick begin" });

    let release: ReleaseLock | null = null;
    try {
      release = await acquireWriterLock(this.root, { retries: 5, staleMs: 60_000 });

      const board = await readBoard(this.root);

      const refreshAsked = detectRefreshRequests(board);
      for (const a of refreshAsked) {
        this.onEvent({
          kind: "refresh_requested",
          at: new Date().toISOString(),
          msg: `agent ${a} requested refresh`,
        });
      }

      const decision = shouldDispatch(board);

      if (!decision.ok) {
        // Non-dispatching tick: only update metrics, leave board.md alone.
        await refreshContext(this.root, { updateBoard: false, updateMetrics: true });
        this.onEvent({
          kind: "tick_skip",
          at: new Date().toISOString(),
          msg: `skipped: ${decision.reason}`,
        });
        return { action: "skipped", reason: decision.reason };
      }

      // Dispatching tick: measure context, set STATUS=WAITING, write once.
      const { snapshots } = await refreshContext(this.root, {
        updateBoard: false,
        updateMetrics: true,
      });

      const agent = board.control.NEXT_AGENT;
      const prompt = await buildDispatchPrompt(this.root, agent, board);

      if (!this.dryRun) {
        const adapter = this.getAdapters()[agent];
        if (!(await adapter.isAlive())) {
          await adapter.spawn();
        }
        await adapter.prompt(prompt);
      }

      const next = board;
      next.control.STATUS = "WAITING";
      next.contextHealth = {
        CLAUDE: snapshots.CLAUDE.pct,
        CODEX: snapshots.CODEX.pct,
        GEMINI: snapshots.GEMINI.pct,
      };
      await this.selfWriteBoard(next);

      await appendChangelog(
        this.root,
        `- ${new Date().toISOString()} dispatched ${agent} (task ${board.control.TASK_ID}, phase ${board.control.PHASE})`,
      );
      this.onEvent({
        kind: "tick_dispatch",
        at: new Date().toISOString(),
        msg: `dispatched ${agent}`,
        data: { task: board.control.TASK_ID, phase: board.control.PHASE },
      });
      return { action: "dispatched", agent };
    } catch (e) {
      const msg = (e as Error).message;
      this.onEvent({
        kind: "tick_error",
        at: new Date().toISOString(),
        msg,
      });
      return { action: "error", reason: msg };
    } finally {
      if (release) {
        try {
          await release();
        } catch {
          // ignore
        }
      }
      this.onEvent({ kind: "tick_done", at: new Date().toISOString(), msg: "tick end" });
      await this.flushLogs();
    }
  }

  /** Wait for any pending async log writes to complete. */
  async flushLogs(): Promise<void> {
    while (this.pendingLogs.size > 0) {
      await Promise.allSettled([...this.pendingLogs]);
    }
  }

  /** Watch board.md for changes and run tick() debounced. */
  async watch(): Promise<void> {
    if (this.watcher) throw new Error("already watching");
    const p = paths(this.root);
    const w = chokidar.watch(p.board, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: this.debounceMs, pollInterval: 50 },
    });
    this.watcher = w;
    this.onEvent({
      kind: "watcher_started",
      at: new Date().toISOString(),
      msg: `watching ${p.board}`,
    });
    w.on("add", () => void this.scheduleTick());
    w.on("change", () => void this.scheduleTick());
  }

  async stop(): Promise<void> {
    if (!this.watcher) return;
    await this.watcher.close();
    this.watcher = null;
    this.onEvent({
      kind: "watcher_stopped",
      at: new Date().toISOString(),
      msg: "watcher stopped",
    });
  }

  private async scheduleTick(): Promise<void> {
    // Suppress events caused by our own writes.
    if (await this.isSelfWrite()) return;
    if (this.inflight) {
      this.pending = true;
      return;
    }
    this.inflight = true;
    void this.tick().finally(() => {
      this.inflight = false;
      if (this.pending) {
        this.pending = false;
        void this.scheduleTick();
      }
    });
  }

  private async isSelfWrite(): Promise<boolean> {
    if (!this.lastSelfWriteHash) return false;
    try {
      const p = paths(this.root);
      const cur = await fs.readFile(p.board, "utf8");
      return hashContent(cur) === this.lastSelfWriteHash;
    } catch {
      return false;
    }
  }

  private async selfWriteBoard(board: Board): Promise<void> {
    const { serializeBoard } = await import("./board.js");
    const text = serializeBoard(board);
    this.lastSelfWriteHash = hashContent(text);
    await writeBoard(this.root, board);
  }
}

function hashContent(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface DaemonOptions extends OrchestratorOptions {
  /** Override adapter config. */
  agentConfig?: AdapterFactoryConfig;
}

export async function startDaemon(root: string, opts: DaemonOptions = {}): Promise<Orchestrator> {
  const o = new Orchestrator(root, opts);
  await o.watch();
  return o;
}
