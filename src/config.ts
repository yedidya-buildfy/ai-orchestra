import { promises as fs } from "node:fs";
import { join } from "node:path";
import { atomicWrite, exists } from "./fs-atomic.js";
import type { AgentName } from "./types.js";

export interface OrchestraConfig {
  agents: Record<AgentName, { command: string; cwd?: string; env?: Record<string, string> }>;
  contextWindows: Record<AgentName, number>;
  thresholds: { ok: number; warning: number; summarize: number; refresh: number };
  fileLimits: {
    boardWords: { warn: number; hard: number };
    memoryWords: { warn: number; hard: number };
  };
  daemon: { autoRefresh: boolean; tickIntervalMs: number };
}

export const DEFAULT_CONFIG: OrchestraConfig = {
  agents: {
    CLAUDE: { command: "claude" },
    CODEX: { command: "codex" },
    GEMINI: { command: "gemini" },
  },
  contextWindows: { CLAUDE: 200_000, CODEX: 200_000, GEMINI: 1_000_000 },
  thresholds: { ok: 0.7, warning: 0.8, summarize: 0.9, refresh: 0.95 },
  fileLimits: {
    boardWords: { warn: 3500, hard: 4000 },
    memoryWords: { warn: 5500, hard: 6000 },
  },
  daemon: { autoRefresh: true, tickIntervalMs: 1000 },
};

export class ConfigError extends Error {
  constructor(msg: string) {
    super(`config error: ${msg}`);
    this.name = "ConfigError";
  }
}

export function configPath(root: string): string {
  return join(root, ".orchestra", "config.json");
}

export async function loadConfig(root: string): Promise<OrchestraConfig> {
  const p = configPath(root);
  if (!(await exists(p))) return DEFAULT_CONFIG;
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (e) {
    throw new ConfigError(`could not read ${p}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`invalid JSON: ${(e as Error).message}`);
  }
  return mergeConfig(DEFAULT_CONFIG, parsed as Partial<OrchestraConfig>);
}

export async function writeConfig(root: string, cfg: OrchestraConfig): Promise<void> {
  validateConfig(cfg);
  await atomicWrite(configPath(root), JSON.stringify(cfg, null, 2) + "\n", { bypassGuard: true });
}

export function validateConfig(cfg: OrchestraConfig): void {
  for (const a of ["CLAUDE", "CODEX", "GEMINI"] as const) {
    const ag = cfg.agents[a];
    if (!ag || typeof ag.command !== "string" || !ag.command.trim()) {
      throw new ConfigError(`agents.${a}.command required`);
    }
    if (typeof cfg.contextWindows[a] !== "number" || cfg.contextWindows[a] <= 0) {
      throw new ConfigError(`contextWindows.${a} must be > 0`);
    }
  }
  const t = cfg.thresholds;
  if (!(0 < t.ok && t.ok < t.warning && t.warning < t.summarize && t.summarize < t.refresh && t.refresh <= 1)) {
    throw new ConfigError("thresholds must be strictly increasing within (0,1]");
  }
  if (cfg.fileLimits.boardWords.warn >= cfg.fileLimits.boardWords.hard) {
    throw new ConfigError("fileLimits.boardWords.warn must be < .hard");
  }
  if (cfg.fileLimits.memoryWords.warn >= cfg.fileLimits.memoryWords.hard) {
    throw new ConfigError("fileLimits.memoryWords.warn must be < .hard");
  }
}

function mergeConfig(base: OrchestraConfig, patch: Partial<OrchestraConfig>): OrchestraConfig {
  const merged: OrchestraConfig = {
    agents: { ...base.agents, ...(patch.agents ?? {}) } as OrchestraConfig["agents"],
    contextWindows: {
      ...base.contextWindows,
      ...(patch.contextWindows ?? {}),
    } as OrchestraConfig["contextWindows"],
    thresholds: { ...base.thresholds, ...(patch.thresholds ?? {}) },
    fileLimits: {
      boardWords: { ...base.fileLimits.boardWords, ...(patch.fileLimits?.boardWords ?? {}) },
      memoryWords: { ...base.fileLimits.memoryWords, ...(patch.fileLimits?.memoryWords ?? {}) },
    },
    daemon: { ...base.daemon, ...(patch.daemon ?? {}) },
  };
  validateConfig(merged);
  return merged;
}
