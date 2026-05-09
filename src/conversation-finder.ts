import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, basename, extname } from "node:path";
import { createHash } from "node:crypto";

/**
 * Resolve the user's home directory. Honors `ORC_HOME` (testing escape hatch)
 * before falling back to `os.homedir()`. Vitest workers don't reliably honor
 * runtime `HOME` env-var changes, so an explicit override is safer than
 * monkey-patching the env.
 */
function home(): string {
  return process.env.ORC_HOME ?? homedir();
}

/**
 * For each of the three wrapped CLIs (claude / codex / gemini), find the
 * UUID of the conversation that most-recently ran in the given workspace
 * `cwd`. Returns null if no matching conversation file is found. Used by
 * `orc rename` to capture the IDs that `orc resume` will later replay.
 *
 * Each CLI stores conversations in its own format and slug scheme:
 *   - claude: `~/.claude/projects/<slashes-replaced-with-dashes>/<uuid>.jsonl`
 *   - codex:  `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`,
 *             cwd is in the first JSONL line's session_meta.cwd field —
 *             we walk newest-first and match
 *   - gemini: `~/.gemini/tmp/<slug>/chats/session-<ts>-<short>.jsonl` where
 *             slug comes from `~/.gemini/projects.json`, falling back to
 *             SHA-256 of the absolute path; full UUID is inside the file
 *             (`sessionId` field)
 */

interface FileWithMtime {
  path: string;
  mtimeMs: number;
}

async function statMtime(path: string): Promise<number> {
  try {
    const st = await fs.stat(path);
    return st.mtimeMs;
  } catch {
    return 0;
  }
}

async function listFiles(dir: string, ext = ".jsonl"): Promise<FileWithMtime[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: FileWithMtime[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (extname(e.name) !== ext) continue;
    const path = join(dir, e.name);
    out.push({ path, mtimeMs: await statMtime(path) });
  }
  return out;
}

async function readFirstLine(path: string): Promise<string | null> {
  try {
    // Files are typically small (~30-100KB) so reading whole file is fine
    // for our use; this avoids the complexity of stream-line iterators and
    // works for both .jsonl and single-object .json files.
    const buf = await fs.readFile(path, "utf8");
    const nl = buf.indexOf("\n");
    return nl < 0 ? buf : buf.slice(0, nl);
  } catch {
    return null;
  }
}

// ─── claude ─────────────────────────────────────────────────────────────

function claudeSlug(cwd: string): string {
  // Claude Code uses cwd with `/` replaced by `-`. The absolute path
  // `/Users/foo/proj` becomes `-Users-foo-proj`. We don't strip the leading
  // dash — that's part of the canonical slug.
  return cwd.replace(/\//g, "-");
}

export async function findClaudeSessionId(cwd: string): Promise<string | null> {
  const dir = join(home(), ".claude", "projects", claudeSlug(cwd));
  const files = await listFiles(dir, ".jsonl");
  if (files.length === 0) return null;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const id = basename(files[0]!.path, ".jsonl");
  return id || null;
}

// ─── codex ──────────────────────────────────────────────────────────────

async function walkCodexSessions(): Promise<FileWithMtime[]> {
  const root = join(home(), ".codex", "sessions");
  const out: FileWithMtime[] = [];
  let years: string[];
  try {
    years = (await fs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
  for (const y of years) {
    let months: string[];
    try {
      months = (await fs.readdir(join(root, y), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .reverse();
    } catch {
      continue;
    }
    for (const m of months) {
      let days: string[];
      try {
        days = (await fs.readdir(join(root, y, m), { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort()
          .reverse();
      } catch {
        continue;
      }
      for (const d of days) {
        const dir = join(root, y, m, d);
        out.push(...(await listFiles(dir, ".jsonl")));
      }
    }
  }
  return out;
}

interface CodexMeta {
  type?: string;
  payload?: { id?: string; cwd?: string };
  cwd?: string;
  id?: string;
}

export async function findCodexSessionId(cwd: string): Promise<string | null> {
  const files = await walkCodexSessions();
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files) {
    const line = await readFirstLine(f.path);
    if (!line) continue;
    let parsed: CodexMeta;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const sessionCwd = parsed.payload?.cwd ?? parsed.cwd;
    if (sessionCwd !== cwd) continue;
    const id = parsed.payload?.id ?? parsed.id;
    if (typeof id === "string" && id.length > 0) return id;
    // Fall back to extracting UUID from filename if meta has no id field
    const m = basename(f.path).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (m) return m[1]!;
  }
  return null;
}

// ─── gemini ─────────────────────────────────────────────────────────────

interface GeminiProjectsJson {
  projects?: Record<string, string>;
}

async function geminiSlug(cwd: string): Promise<string> {
  // Gemini CLI's projectRegistry: read ~/.gemini/projects.json for an
  // explicit mapping; fall back to SHA-256 hex of the absolute cwd.
  const mapPath = join(home(), ".gemini", "projects.json");
  try {
    const raw = await fs.readFile(mapPath, "utf8");
    const obj = JSON.parse(raw) as GeminiProjectsJson;
    const slug = obj.projects?.[cwd];
    if (typeof slug === "string" && slug.length > 0) return slug;
  } catch {
    // fall through to hash
  }
  return createHash("sha256").update(cwd).digest("hex");
}

interface GeminiSessionMeta {
  sessionId?: string;
}

export async function findGeminiSessionId(cwd: string): Promise<string | null> {
  const slug = await geminiSlug(cwd);
  const dir = join(home(), ".gemini", "tmp", slug, "chats");
  // Both .jsonl (current) and .json (legacy) files can appear.
  const files = [
    ...(await listFiles(dir, ".jsonl")),
    ...(await listFiles(dir, ".json")),
  ];
  if (files.length === 0) return null;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files) {
    const line = await readFirstLine(f.path);
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as GeminiSessionMeta;
      if (typeof parsed.sessionId === "string" && parsed.sessionId.length > 0) {
        return parsed.sessionId;
      }
    } catch {
      // not JSON or not the meta line — skip
    }
  }
  return null;
}

// ─── unified ────────────────────────────────────────────────────────────

export interface AgentSessionIds {
  CLAUDE: string | null;
  CODEX: string | null;
  GEMINI: string | null;
}

/**
 * Find the most-recent session ID for each agent that ran in `cwd`. Run all
 * three lookups in parallel; any individual failure yields null for that
 * agent without affecting the others.
 */
export async function findAgentSessions(cwd: string): Promise<AgentSessionIds> {
  const [CLAUDE, CODEX, GEMINI] = await Promise.all([
    findClaudeSessionId(cwd).catch(() => null),
    findCodexSessionId(cwd).catch(() => null),
    findGeminiSessionId(cwd).catch(() => null),
  ]);
  return { CLAUDE, CODEX, GEMINI };
}
