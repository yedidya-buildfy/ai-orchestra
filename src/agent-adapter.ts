import { promises as fs } from "node:fs";
import { join } from "node:path";
import { TmuxSession, type TmuxSessionOptions } from "./tmux.js";
import type { AgentName } from "./types.js";
import { paths } from "./workspace.js";

/**
 * Result of attempting to read the agent's own runtime token usage from
 * its CLI output. Different CLIs report differently; each adapter parses
 * its own format.
 */
export interface RuntimeUsage {
  tokens: number;
  /** Free-form description of where the count came from. */
  source: string;
}

export interface AgentAdapter {
  readonly agent: AgentName;
  readonly sessionName: string;
  readonly tmux: TmuxSession;

  /** Bring up the agent's CLI in tmux. No-op if already alive. */
  spawn(): Promise<void>;
  /** Tear down the tmux session. */
  kill(): Promise<void>;
  /** Send a prompt to the agent. */
  prompt(text: string): Promise<void>;
  /** Send rehydration context (protocol/memory/board/objective). */
  injectContext(files: { label: string; content: string }[]): Promise<void>;
  /** Try to read a runtime token count from the most recent CLI output. */
  readUsage(): Promise<RuntimeUsage | null>;
  /** Whether the underlying tmux session is alive. */
  isAlive(): Promise<boolean>;
}

export interface AgentConfig {
  /** Shell command to launch the CLI. */
  command: string;
  /** Working directory for the session. */
  cwd?: string;
  /** Custom tmux session name override. */
  sessionName?: string;
  /** Extra env. */
  env?: Record<string, string>;
}

export interface AdapterFactoryConfig {
  CLAUDE: AgentConfig;
  CODEX: AgentConfig;
  GEMINI: AgentConfig;
}

export const DEFAULT_AGENT_CONFIG: AdapterFactoryConfig = {
  CLAUDE: { command: "claude" },
  CODEX: { command: "codex" },
  GEMINI: { command: "gemini" },
};

/** Base implementation common to all three adapters. */
abstract class BaseAdapter implements AgentAdapter {
  readonly agent: AgentName;
  readonly sessionName: string;
  readonly tmux: TmuxSession;
  protected readonly metadataPath: string;

  constructor(agent: AgentName, root: string, config: AgentConfig) {
    this.agent = agent;
    this.sessionName = config.sessionName ?? agent.toLowerCase();
    const p = paths(root);
    const pipeFile = join(p.sessionsDir, `${this.sessionName}.pipe.log`);
    this.metadataPath = join(p.sessionsDir, `${this.sessionName}.json`);
    const tmuxOpts: TmuxSessionOptions = {
      name: this.sessionName,
      command: config.command,
      pipeFile,
    };
    if (config.cwd !== undefined) tmuxOpts.cwd = config.cwd;
    if (config.env !== undefined) tmuxOpts.env = config.env;
    this.tmux = new TmuxSession(tmuxOpts);
  }

  async isAlive(): Promise<boolean> {
    return this.tmux.isAlive();
  }

  async spawn(): Promise<void> {
    if (await this.tmux.isAlive()) return;
    await this.tmux.start();
    await this.persistMetadata({ startedAt: new Date().toISOString() });
  }

  async kill(): Promise<void> {
    await this.tmux.stop();
    await this.persistMetadata({ stoppedAt: new Date().toISOString() });
  }

  async prompt(text: string): Promise<void> {
    if (!(await this.tmux.isAlive())) {
      throw new Error(`adapter ${this.agent}: session not alive`);
    }
    await this.tmux.send(text);
    await this.persistMetadata({
      lastPromptAt: new Date().toISOString(),
      lastPromptPreview: text.slice(0, 200),
    });
  }

  async injectContext(files: { label: string; content: string }[]): Promise<void> {
    const blocks = files.map(
      (f) =>
        `=== ${f.label} ===\n${f.content.trimEnd()}\n=== end ${f.label} ===`,
    );
    const payload =
      [
        "# AI Orchestra rehydration",
        "Read the following blocks as your operating context.",
        "",
        ...blocks,
      ].join("\n") + "\n";
    await this.prompt(payload);
  }

  abstract readUsage(): Promise<RuntimeUsage | null>;

  protected async persistMetadata(patch: Record<string, unknown>): Promise<void> {
    const existing = await this.readMetadata();
    const next = {
      agent: this.agent,
      sessionName: this.sessionName,
      command: this.tmux.command,
      ...existing,
      ...patch,
    };
    await fs.writeFile(this.metadataPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  }

  protected async readMetadata(): Promise<Record<string, unknown>> {
    try {
      const raw = await fs.readFile(this.metadataPath, "utf8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  }
}

// ---------- Per-agent parsers ----------

/**
 * Claude Code prints a statusline near the bottom of its UI that includes
 * "tokens: XXk / 200k" or similar. This regex is intentionally tolerant of
 * formatting drift: any "tokens: <num>" or "<num>/<num> tokens" pattern is
 * accepted.
 */
const CLAUDE_USAGE_RX = [
  /tokens?:\s*([\d,]+)\s*\/\s*([\d,]+)/i,
  /([\d,]+)\s*\/\s*([\d,]+)\s*tokens?/i,
];

export class ClaudeAdapter extends BaseAdapter {
  constructor(root: string, config: AgentConfig = DEFAULT_AGENT_CONFIG.CLAUDE) {
    super("CLAUDE", root, config);
  }
  async readUsage(): Promise<RuntimeUsage | null> {
    const buf = await this.tmux.readPipeBuffer();
    return parseFraction(buf, CLAUDE_USAGE_RX, "claude statusline");
  }
}

/**
 * Codex CLI emits a usage block like:
 *   input_tokens: 1234
 *   output_tokens: 56
 *   reasoning_tokens: 78
 * After a turn completes. We sum all three when present.
 */
const CODEX_USAGE_LINE = /(input|output|reasoning)_tokens?:\s*([\d,]+)/gi;

export class CodexAdapter extends BaseAdapter {
  constructor(root: string, config: AgentConfig = DEFAULT_AGENT_CONFIG.CODEX) {
    super("CODEX", root, config);
  }
  async readUsage(): Promise<RuntimeUsage | null> {
    const buf = await this.tmux.readPipeBuffer();
    if (!buf) return null;
    // Keep only the last occurrence of each token kind so we ignore echoed
    // commands and stale prior turns.
    const last: Record<string, number> = {};
    let m: RegExpExecArray | null;
    CODEX_USAGE_LINE.lastIndex = 0;
    while ((m = CODEX_USAGE_LINE.exec(buf)) !== null) {
      const kind = m[1]!.toLowerCase();
      last[kind] = Number(m[2]!.replace(/,/g, ""));
    }
    if (Object.keys(last).length === 0) return null;
    const total = Object.values(last).reduce((a, b) => a + b, 0);
    return { tokens: total, source: "codex usage block" };
  }
}

/**
 * Gemini CLI may print "Tokens used: N" or similar after each turn.
 * If absent, return null and let Layer-3 estimate take over.
 */
const GEMINI_USAGE_RX = [
  /tokens used:\s*([\d,]+)/i,
  /token count:\s*([\d,]+)/i,
  /^([\d,]+)\s*tokens?/im,
];

export class GeminiAdapter extends BaseAdapter {
  constructor(root: string, config: AgentConfig = DEFAULT_AGENT_CONFIG.GEMINI) {
    super("GEMINI", root, config);
  }
  async readUsage(): Promise<RuntimeUsage | null> {
    const buf = await this.tmux.readPipeBuffer();
    if (!buf) return null;
    for (const rx of GEMINI_USAGE_RX) {
      const m = rx.exec(buf);
      if (m) {
        const n = Number(m[1]!.replace(/,/g, ""));
        if (Number.isFinite(n)) return { tokens: n, source: "gemini cli output" };
      }
    }
    return null;
  }
}

function parseFraction(
  buf: string,
  patterns: RegExp[],
  source: string,
): RuntimeUsage | null {
  if (!buf) return null;
  // Iterate from the end of the buffer to prefer the most recent number.
  // Easiest implementation: search all matches and take the last.
  let last: { tokens: number } | null = null;
  for (const rx of patterns) {
    const flags = rx.flags.includes("g") ? rx.flags : rx.flags + "g";
    const re = new RegExp(rx.source, flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(buf)) !== null) {
      const num = Number(m[1]!.replace(/,/g, ""));
      if (Number.isFinite(num)) last = { tokens: num };
    }
  }
  return last ? { tokens: last.tokens, source } : null;
}

// ---------- Factory ----------

export function buildAdapters(
  root: string,
  config: AdapterFactoryConfig = DEFAULT_AGENT_CONFIG,
): { CLAUDE: ClaudeAdapter; CODEX: CodexAdapter; GEMINI: GeminiAdapter } {
  return {
    CLAUDE: new ClaudeAdapter(root, config.CLAUDE),
    CODEX: new CodexAdapter(root, config.CODEX),
    GEMINI: new GeminiAdapter(root, config.GEMINI),
  };
}
