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

// ---------- Gemini CLI: ~/.gemini/settings.json ----------

/**
 * Gemini CLI keeps a `trustedFolders` array (or object map) in
 * ~/.gemini/settings.json. We maintain it as an array of absolute paths.
 * If the file already uses an object map (newer schema), we set the path
 * key to `true` instead.
 */
export async function trustGemini(absPath: string): Promise<TrustResult> {
  const cfgPath = join(homedir(), ".gemini", "settings.json");
  let json: Record<string, unknown> = {};
  if (existsSync(cfgPath)) {
    try {
      json = JSON.parse(await fs.readFile(cfgPath, "utf8"));
    } catch (e) {
      return {
        agent: "GEMINI",
        configPath: cfgPath,
        changed: false,
        detail: `parse error: ${(e as Error).message}`,
      };
    }
  }

  const tf = json.trustedFolders;
  if (tf && typeof tf === "object" && !Array.isArray(tf)) {
    // Object-map schema: { "/path": true, ... }
    const map = tf as Record<string, unknown>;
    if (map[absPath] === true) {
      return { agent: "GEMINI", configPath: cfgPath, changed: false, detail: "already trusted (map)" };
    }
    map[absPath] = true;
  } else if (Array.isArray(tf)) {
    if (tf.includes(absPath)) {
      return { agent: "GEMINI", configPath: cfgPath, changed: false, detail: "already trusted (array)" };
    }
    tf.push(absPath);
  } else {
    json.trustedFolders = [absPath];
  }

  await fs.mkdir(join(homedir(), ".gemini"), { recursive: true });
  await atomicWrite(cfgPath, JSON.stringify(json, null, 2) + "\n", { bypassGuard: true });
  return {
    agent: "GEMINI",
    configPath: cfgPath,
    changed: true,
    detail: `added ${shortPath(absPath)} to trustedFolders`,
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
