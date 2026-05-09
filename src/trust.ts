import { promises as fs, existsSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { atomicWrite } from "./fs-atomic.js";
import type { AgentName } from "./types.js";

/**
 * Resolve the user's home directory, preferring the HOME env var so tests
 * can isolate against a fake home. On macOS os.homedir() reads from the
 * passwd database and ignores HOME, which makes config-file tests
 * impossible without this indirection.
 */
function homedir(): string {
  return process.env["HOME"] ?? osHomedir();
}

/**
 * Pre-trust configuration. Each CLI stores its "trusted folders" state in a
 * different on-disk format; we write the project path into all three so the
 * trust prompt is never shown. Best-effort: if the schema differs from what
 * we expect, the warmup pattern-matcher (src/warmup.ts) still answers the
 * interactive prompt. This module is the proactive layer; warmup is the
 * reactive fallback.
 */
export interface TrustResult {
  agent: AgentName;
  configPath: string;
  changed: boolean;
  detail: string;
}

export async function trustPath(projectPath: string): Promise<TrustResult[]> {
  const abs = resolvePath(projectPath);
  return Promise.all([
    trustClaude(abs),
    trustCodex(abs),
    trustGemini(abs),
  ]);
}

// ---------- Claude Code: ~/.claude.json ----------

/**
 * Claude Code writes per-project state under `projects.<absPath>` in
 * ~/.claude.json. Setting `hasTrustDialogAccepted: true` suppresses the
 * folder-trust prompt for that path.
 */
export async function trustClaude(absPath: string): Promise<TrustResult> {
  const cfgPath = join(homedir(), ".claude.json");
  let json: Record<string, unknown> = {};
  if (existsSync(cfgPath)) {
    try {
      json = JSON.parse(await fs.readFile(cfgPath, "utf8"));
    } catch (e) {
      return {
        agent: "CLAUDE",
        configPath: cfgPath,
        changed: false,
        detail: `parse error: ${(e as Error).message}`,
      };
    }
  }
  const projects = (json.projects ??= {}) as Record<string, Record<string, unknown>>;
  const proj = (projects[absPath] ??= {});
  if (proj.hasTrustDialogAccepted === true && proj.hasCompletedProjectOnboarding === true) {
    return {
      agent: "CLAUDE",
      configPath: cfgPath,
      changed: false,
      detail: "already trusted",
    };
  }
  proj.hasTrustDialogAccepted = true;
  proj.hasCompletedProjectOnboarding = true;
  await atomicWrite(cfgPath, JSON.stringify(json, null, 2) + "\n", { bypassGuard: true });
  return {
    agent: "CLAUDE",
    configPath: cfgPath,
    changed: true,
    detail: `set projects.${shortPath(absPath)}.hasTrustDialogAccepted = true`,
  };
}

// ---------- Gemini CLI: ~/.gemini/trustedFolders.json (0.40+) ----------

/**
 * Gemini CLI ≥ 0.40 keeps trusted folders in a SEPARATE file:
 *   ~/.gemini/trustedFolders.json   (object map: { "/abs/path": "TRUST_FOLDER" })
 * Older versions used a `trustedFolders` array/map inside ~/.gemini/settings.json.
 * We write to BOTH locations so a CLI on either schema sees the trust.
 */
export async function trustGemini(absPath: string): Promise<TrustResult> {
  const dir = join(homedir(), ".gemini");
  await fs.mkdir(dir, { recursive: true });
  const tfPath = join(dir, "trustedFolders.json");
  const settingsPath = join(dir, "settings.json");
  const notes: string[] = [];

  // Primary: trustedFolders.json (Gemini 0.40+).
  let tfMap: Record<string, unknown> = {};
  let tfChanged = false;
  if (existsSync(tfPath)) {
    try {
      const parsed = JSON.parse(await fs.readFile(tfPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        tfMap = parsed as Record<string, unknown>;
      }
    } catch {
      tfMap = {};
    }
  }
  if (tfMap[absPath] !== "TRUST_FOLDER") {
    tfMap[absPath] = "TRUST_FOLDER";
    tfChanged = true;
  }
  if (tfChanged) {
    await atomicWrite(tfPath, JSON.stringify(tfMap, null, 2) + "\n", { bypassGuard: true });
    notes.push(`wrote trustedFolders.json[${shortPath(absPath)}]=TRUST_FOLDER`);
  }

  // Legacy fallback: settings.json (older Geminis).
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    } catch {
      settings = {};
    }
  }
  let settingsChanged = false;
  const tf = settings.trustedFolders;
  if (tf && typeof tf === "object" && !Array.isArray(tf)) {
    const m = tf as Record<string, unknown>;
    if (m[absPath] !== true) {
      m[absPath] = true;
      settingsChanged = true;
    }
  } else if (Array.isArray(tf)) {
    if (!tf.includes(absPath)) {
      tf.push(absPath);
      settingsChanged = true;
    }
  } else {
    settings.trustedFolders = [absPath];
    settingsChanged = true;
  }
  if (settingsChanged) {
    await atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + "\n", {
      bypassGuard: true,
    });
    notes.push("updated settings.json (legacy fallback)");
  }

  const changed = tfChanged || settingsChanged;
  return {
    agent: "GEMINI",
    configPath: tfPath,
    changed,
    detail: changed
      ? notes.join("; ")
      : `already trusted in both trustedFolders.json and settings.json`,
  };
}

// ---------- Codex CLI: ~/.codex/config.toml ----------

/**
 * Codex CLI uses TOML in ~/.codex/config.toml. We append a
 *   [projects."<absPath>"]
 *   trust_level = "trusted"
 * section if not already present. Naive line-level handling — no full TOML
 * parser needed because we never modify existing values.
 */
export async function trustCodex(absPath: string): Promise<TrustResult> {
  const cfgPath = join(homedir(), ".codex", "config.toml");
  let body = "";
  if (existsSync(cfgPath)) {
    try {
      body = await fs.readFile(cfgPath, "utf8");
    } catch (e) {
      return {
        agent: "CODEX",
        configPath: cfgPath,
        changed: false,
        detail: `read error: ${(e as Error).message}`,
      };
    }
  }

  const escapedPath = absPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const sectionHeader = `[projects."${escapedPath}"]`;
  if (body.includes(sectionHeader)) {
    return { agent: "CODEX", configPath: cfgPath, changed: false, detail: "already trusted" };
  }

  const sep = body === "" || body.endsWith("\n") ? "" : "\n";
  const append = `${sep}\n${sectionHeader}\ntrust_level = "trusted"\n`;
  body = body + append;

  await fs.mkdir(join(homedir(), ".codex"), { recursive: true });
  await atomicWrite(cfgPath, body, { bypassGuard: true });
  return {
    agent: "CODEX",
    configPath: cfgPath,
    changed: true,
    detail: `appended [projects."${shortPath(absPath)}"] trust_level = "trusted"`,
  };
}

function shortPath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
