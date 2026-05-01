import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { paths, readBoard } from "./workspace.js";
import { TmuxSession } from "./tmux.js";
import { buildAdapters } from "./agent-adapter.js";
import type { AgentName } from "./types.js";

export interface DoctorReport {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

/**
 * doctor: sanity-check the environment.
 * - tmux installed?
 * - workspace exists and parses?
 * - file perms (R+W on .orchestra/)?
 * - tokenizers loadable?
 * - configured agent commands present on PATH?
 */
export async function doctor(root: string): Promise<DoctorReport> {
  const checks: DoctorReport["checks"] = [];

  // tmux
  const tmuxOk = await TmuxSession.tmuxAvailable();
  checks.push({
    name: "tmux installed",
    ok: tmuxOk,
    detail: tmuxOk ? "yes" : "tmux not found on PATH",
  });

  // workspace
  const p = paths(root);
  const wsOk = existsSync(p.root);
  checks.push({
    name: ".orchestra/ exists",
    ok: wsOk,
    detail: wsOk ? p.root : `missing — run 'ai-orchestra init' in ${root}`,
  });

  if (wsOk) {
    try {
      const board = await readBoard(root);
      checks.push({
        name: "board.md parses",
        ok: true,
        detail: `phase=${board.control.PHASE} status=${board.control.STATUS} next=${board.control.NEXT_AGENT}`,
      });
    } catch (e) {
      checks.push({
        name: "board.md parses",
        ok: false,
        detail: (e as Error).message,
      });
    }

    // write check
    try {
      const probe = join(p.root, ".doctor-probe");
      await fs.writeFile(probe, "x", "utf8");
      await fs.unlink(probe);
      checks.push({ name: ".orchestra/ writable", ok: true, detail: "ok" });
    } catch (e) {
      checks.push({
        name: ".orchestra/ writable",
        ok: false,
        detail: (e as Error).message,
      });
    }
  }

  // tokenizers
  try {
    const { buildTokenizers } = await import("./tokenizer.js");
    const set = buildTokenizers();
    set.CLAUDE.countTokens("hi");
    set.CODEX.countTokens("hi");
    set.GEMINI.countTokens("hi");
    checks.push({ name: "tokenizers loadable", ok: true, detail: "claude/codex/gemini all loaded" });
  } catch (e) {
    checks.push({
      name: "tokenizers loadable",
      ok: false,
      detail: (e as Error).message,
    });
  }

  // agent CLIs on PATH
  if (wsOk) {
    const adapters = buildAdapters(root);
    for (const a of ["CLAUDE", "CODEX", "GEMINI"] as const) {
      const cmd = adapters[a].tmux.command.split(/\s+/)[0]!;
      const found = await commandExists(cmd);
      checks.push({
        name: `agent CLI on PATH: ${cmd} (${a})`,
        ok: found,
        detail: found ? "yes" : `not found on PATH — set agents.${a}.command in config or install it`,
      });
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}

async function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("which", [cmd], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

/**
 * Crash recovery: replay the last consistent state from changelog.md.
 *
 * The changelog is append-only and authoritative for "what happened". After
 * an unclean shutdown we re-read the board (which is atomically written) and
 * cross-check the last few changelog entries; if a "dispatched" was logged
 * but STATUS is ACTIVE (not WAITING), we conservatively flip it to WAITING
 * so the watcher does not re-dispatch the same agent.
 */
export async function recoverFromCrash(root: string): Promise<{ recovered: boolean; reason: string }> {
  const p = paths(root);
  if (!existsSync(p.board) || !existsSync(p.changelog)) {
    return { recovered: false, reason: "no workspace files" };
  }
  const board = await readBoard(root);
  const cl = await fs.readFile(p.changelog, "utf8");
  const lastLine = cl.split("\n").reverse().find((l) => l.trim().length > 0) ?? "";
  if (board.control.STATUS === "ACTIVE" && /dispatched/.test(lastLine)) {
    const { writeBoard } = await import("./workspace.js");
    board.control.STATUS = "WAITING";
    await writeBoard(root, board);
    return { recovered: true, reason: `flipped STATUS ACTIVE→WAITING after seeing dispatched in last changelog line` };
  }
  return { recovered: false, reason: "no inconsistency detected" };
}

export interface StatusSummary {
  board: {
    taskId: string;
    phase: string;
    status: string;
    nextAgent: string;
    objective: string;
  };
  contextHealth: { CLAUDE: number; CODEX: number; GEMINI: number };
  agents: { name: AgentName; alive: boolean; sessionName: string }[];
  metrics?: unknown;
}

export async function status(root: string): Promise<StatusSummary> {
  const board = await readBoard(root);
  const adapters = buildAdapters(root);
  const agents: StatusSummary["agents"] = [];
  for (const a of ["CLAUDE", "CODEX", "GEMINI"] as const) {
    agents.push({ name: a, alive: await adapters[a].isAlive(), sessionName: adapters[a].sessionName });
  }
  const p = paths(root);
  let metrics: unknown;
  try {
    metrics = JSON.parse(await fs.readFile(p.metrics, "utf8"));
  } catch {
    metrics = null;
  }
  return {
    board: {
      taskId: board.control.TASK_ID,
      phase: board.control.PHASE,
      status: board.control.STATUS,
      nextAgent: board.control.NEXT_AGENT,
      objective: board.objective,
    },
    contextHealth: board.contextHealth,
    agents,
    metrics,
  };
}

export async function tailLog(root: string, name: string, lines = 100): Promise<string> {
  const p = paths(root);
  const file = join(p.logsDir, `${name}.log`);
  if (!existsSync(file)) return "";
  const text = await fs.readFile(file, "utf8");
  const all = text.split("\n");
  return all.slice(-lines).join("\n");
}
