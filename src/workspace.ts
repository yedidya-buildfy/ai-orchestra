import { promises as fs } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendOnly,
  assertPureAppend,
  atomicWrite,
  exists,
  readText,
} from "./fs-atomic.js";
import { defaultBoard, parseBoard, serializeBoard } from "./board.js";
import type { Board } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve the templates directory both in dev (src/) and in build (dist/). */
async function resolveTemplatesDir(): Promise<string> {
  const candidates = [
    resolve(__dirname, "..", "templates"),
    resolve(__dirname, "..", "..", "templates"),
  ];
  for (const c of candidates) {
    if (await exists(c)) return c;
  }
  throw new Error(`templates directory not found; tried: ${candidates.join(", ")}`);
}

export interface WorkspacePaths {
  root: string;
  board: string;
  memory: string;
  changelog: string;
  longTerm: string;
  protocol: string;
  agents: { claude: string; codex: string; gemini: string };
  sessionsDir: string;
  metricsDir: string;
  metrics: string;
  logsDir: string;
  lockfile: string;
}

export function paths(root: string): WorkspacePaths {
  const o = join(root, ".orchestra");
  return {
    root: o,
    board: join(o, "board.md"),
    memory: join(o, "memory.md"),
    changelog: join(o, "changelog.md"),
    longTerm: join(o, "long_term.md"),
    protocol: join(o, "protocol.md"),
    agents: {
      claude: join(o, "agents", "claude.md"),
      codex: join(o, "agents", "codex.md"),
      gemini: join(o, "agents", "gemini.md"),
    },
    sessionsDir: join(o, "sessions"),
    metricsDir: join(o, "metrics"),
    metrics: join(o, "metrics", "context.json"),
    logsDir: join(o, "logs"),
    lockfile: join(o, ".lock"),
  };
}

export interface InitOptions {
  /** Overwrite existing files. Default false: refuses if .orchestra/ exists. */
  force?: boolean;
}

export async function initWorkspace(root: string, opts: InitOptions = {}): Promise<WorkspacePaths> {
  const p = paths(root);
  const exists_ = await exists(p.root);
  if (exists_ && !opts.force) {
    throw new Error(`.orchestra/ already exists at ${p.root} (use force to overwrite)`);
  }

  await fs.mkdir(p.root, { recursive: true });
  await fs.mkdir(join(p.root, "agents"), { recursive: true });
  await fs.mkdir(p.sessionsDir, { recursive: true });
  await fs.mkdir(p.metricsDir, { recursive: true });
  await fs.mkdir(p.logsDir, { recursive: true });

  const tpl = await resolveTemplatesDir();

  // board.md is generated from defaultBoard() to guarantee the parser/serializer round-trips it.
  await atomicWrite(p.board, serializeBoard(defaultBoard()));

  const copies: [string, string][] = [
    [join(tpl, "memory.md"), p.memory],
    [join(tpl, "changelog.md"), p.changelog],
    [join(tpl, "long_term.md"), p.longTerm],
    [join(tpl, "protocol.md"), p.protocol],
    [join(tpl, "agents", "claude.md"), p.agents.claude],
    [join(tpl, "agents", "codex.md"), p.agents.codex],
    [join(tpl, "agents", "gemini.md"), p.agents.gemini],
  ];
  for (const [src, dst] of copies) {
    const text = await readText(src);
    // memory.md is guarded; others are not.
    const bypass = dst !== p.memory;
    await atomicWrite(dst, text, { bypassGuard: bypass });
  }

  const initialMetrics = JSON.stringify({ claude: 0, codex: 0, gemini: 0 }, null, 2) + "\n";
  await atomicWrite(p.metrics, initialMetrics, { bypassGuard: true });

  return p;
}

export async function readBoard(root: string): Promise<Board> {
  const p = paths(root);
  return parseBoard(await readText(p.board));
}

export async function writeBoard(root: string, board: Board): Promise<void> {
  const p = paths(root);
  await atomicWrite(p.board, serializeBoard(board));
}

export async function appendChangelog(root: string, entry: string): Promise<void> {
  const p = paths(root);
  await appendOnly(p.changelog, entry);
}

/** Reject any rewrite of changelog.md that is not a pure append. */
export async function safeRewriteChangelog(
  root: string,
  proposed: string,
): Promise<void> {
  const p = paths(root);
  await assertPureAppend(p.changelog, proposed);
  await atomicWrite(p.changelog, proposed, { bypassGuard: true });
}
