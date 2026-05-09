import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite, exists, readText } from "./fs-atomic.js";
import type { AgentName } from "./types.js";

/**
 * The named-session registry stored at `~/.config/orc/sessions.json`. This is
 * a pure name → workspace mapping (plus per-agent conversation IDs captured
 * at `orc rename` time) so that `orc resume <name>` can re-spawn the three
 * CLIs in the right cwd with the right `--resume <id>` flags. The registry
 * is global to the user, not per-project.
 */
export interface SessionEntry {
  /** Absolute workspace root that hosts the .orchestra/ this name was bound to. */
  dir: string;
  /** ISO timestamp of first save. */
  createdAt: string;
  /** ISO timestamp of the most recent rename or resume. */
  lastUsed: string;
  /**
   * Session IDs of each underlying CLI conversation as observed at rename
   * time. A null means we couldn't find one for that agent (the orchestra
   * session simply didn't have it running yet, or the file lookup failed);
   * `orc resume` will spawn that agent fresh in that case.
   */
  agentSessions: Record<AgentName, string | null>;
}

export interface Registry {
  /** Map name → entry. Names are case-sensitive and must be non-empty. */
  sessions: Record<string, SessionEntry>;
}

const EMPTY_REGISTRY: Registry = { sessions: {} };

/**
 * Resolve the registry file path. Honors `XDG_CONFIG_HOME` for unix-y users
 * who keep their dotfiles outside of `~`. Tests override via `ORC_REGISTRY_PATH`.
 */
export function registryPath(): string {
  const override = process.env.ORC_REGISTRY_PATH;
  if (override) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "orc", "sessions.json");
}

export async function loadRegistry(): Promise<Registry> {
  const path = registryPath();
  if (!(await exists(path))) return { sessions: {} };
  const raw = await readText(path);
  if (!raw.trim()) return { sessions: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt registry — fall back to empty rather than throw, so a single
    // bad write never bricks the user's CLI. They can `orc list` to see it's
    // empty and `orc rename` will recreate.
    return { sessions: {} };
  }
  if (!parsed || typeof parsed !== "object" || !("sessions" in parsed)) {
    return { sessions: {} };
  }
  const sessions = (parsed as { sessions: unknown }).sessions;
  if (!sessions || typeof sessions !== "object") return { sessions: {} };
  return { sessions: sessions as Record<string, SessionEntry> };
}

export async function saveRegistry(reg: Registry): Promise<void> {
  await atomicWrite(registryPath(), JSON.stringify(reg, null, 2) + "\n", {
    bypassGuard: true,
  });
}

export async function getSession(name: string): Promise<SessionEntry | null> {
  const reg = await loadRegistry();
  return reg.sessions[name] ?? null;
}

export async function setSession(name: string, entry: SessionEntry): Promise<void> {
  if (!name.trim()) throw new Error("session name must be non-empty");
  const reg = await loadRegistry();
  reg.sessions[name] = entry;
  await saveRegistry(reg);
}

export async function removeSession(name: string): Promise<boolean> {
  const reg = await loadRegistry();
  if (!(name in reg.sessions)) return false;
  delete reg.sessions[name];
  await saveRegistry(reg);
  return true;
}

export async function listSessions(): Promise<Array<{ name: string; entry: SessionEntry }>> {
  const reg = await loadRegistry();
  return Object.entries(reg.sessions)
    .map(([name, entry]) => ({ name, entry }))
    .sort((a, b) => b.entry.lastUsed.localeCompare(a.entry.lastUsed));
}

/**
 * Mark a session as just-used (refreshes `lastUsed` to now). Called from the
 * `resume` command so `orc list` shows the most recently active sessions on
 * top.
 */
export async function touchSession(name: string): Promise<void> {
  const reg = await loadRegistry();
  const e = reg.sessions[name];
  if (!e) return;
  e.lastUsed = new Date().toISOString();
  await saveRegistry(reg);
}
