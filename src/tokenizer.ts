import { countTokens as anthropicCount } from "@anthropic-ai/tokenizer";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import type { AgentName } from "./types.js";

/**
 * Tokenizer interface. All implementations in this system are local
 * (no network, no API key) because the agents themselves run as
 * subscription-backed CLIs in tmux — token APIs would be a second
 * billing path we don't want.
 *
 * Real token counts for running agents come from Layer 1 (runtime)
 * captured from each CLI's own output: Claude's statusline, Codex's
 * usage block, Gemini's response token reporting. These tokenizers
 * are the Layer 3 estimation fallback used when no runtime number
 * is available yet.
 */
export interface Tokenizer {
  readonly name: string;
  /** A label describing how the count is produced. */
  readonly source: TokenSource;
  countTokens(text: string): Promise<number> | number;
}

/**
 * How a token count was produced:
 * - "tokenizer": real local tokenizer (Anthropic, tiktoken)
 * - "heuristic": calibrated char ratio fallback (used for Gemini, which
 *               has no public offline tokenizer)
 * - "runtime": value reported by the running agent CLI itself
 *              (statusline, usage block) — wired in M3.
 */
export type TokenSource = "tokenizer" | "heuristic" | "runtime";

// ---------- Claude ----------

export class ClaudeTokenizer implements Tokenizer {
  readonly name = "claude/anthropic-tokenizer";
  readonly source: TokenSource = "tokenizer";
  countTokens(text: string): number {
    return anthropicCount(text);
  }
}

// ---------- Codex / GPT family ----------

const O200K = "o200k_base";

export class CodexTokenizer implements Tokenizer {
  readonly name = "codex/o200k_base";
  readonly source: TokenSource = "tokenizer";
  private enc: Tiktoken;
  constructor() {
    this.enc = getEncoding(O200K);
  }
  countTokens(text: string): number {
    return this.enc.encode(text).length;
  }
}

// ---------- Gemini ----------

/**
 * Calibrated heuristic for Gemini 1.5 / 2.x: ~4 chars per token for mixed
 * English/code content. Slightly conservative — overcounting is safer than
 * undercounting for context budgeting.
 */
const GEMINI_CHARS_PER_TOKEN = 3.8;

export class GeminiHeuristicTokenizer implements Tokenizer {
  readonly name = "gemini/heuristic-chars-per-token";
  readonly source: TokenSource = "heuristic";
  countTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / GEMINI_CHARS_PER_TOKEN);
  }
}

// ---------- Factory ----------

export interface TokenizerSet {
  CLAUDE: Tokenizer;
  CODEX: Tokenizer;
  GEMINI: Tokenizer;
}

export function buildTokenizers(): TokenizerSet {
  return {
    CLAUDE: new ClaudeTokenizer(),
    CODEX: new CodexTokenizer(),
    GEMINI: new GeminiHeuristicTokenizer(),
  };
}

export function tokenizerFor(set: TokenizerSet, agent: AgentName): Tokenizer {
  return set[agent];
}
