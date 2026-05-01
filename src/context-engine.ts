import { promises as fs } from "node:fs";
import type { AgentName } from "./types.js";
import { buildTokenizers, type Tokenizer, type TokenizerSet, type TokenSource } from "./tokenizer.js";

/** Default context windows in tokens (PRD §9). */
export const CONTEXT_WINDOWS: Record<AgentName, number> = {
  CLAUDE: 200_000,
  CODEX: 200_000,
  GEMINI: 1_000_000,
};

/**
 * Conservative buffer applied to estimates: actual usage tends to exceed
 * the sum of message-token counts due to system prompts, tool schemas,
 * formatting overhead. PRD §8: real_usage ≈ estimated × 1.2.
 */
export const ESTIMATE_BUFFER = 1.2;

export type ThresholdBand = "OK" | "WARNING" | "SUMMARIZE" | "REFRESH" | "FORCE_RESET";

/** PRD §10. Inclusive lower bound, exclusive upper bound (except FORCE_RESET which is unbounded). */
export const THRESHOLDS: { band: ThresholdBand; min: number; max: number }[] = [
  { band: "OK", min: 0, max: 0.7 },
  { band: "WARNING", min: 0.7, max: 0.8 },
  { band: "SUMMARIZE", min: 0.8, max: 0.9 },
  { band: "REFRESH", min: 0.9, max: 0.95 },
  { band: "FORCE_RESET", min: 0.95, max: Infinity },
];

export function bandFor(pct: number): ThresholdBand {
  if (!Number.isFinite(pct) || pct < 0) return "OK";
  for (const t of THRESHOLDS) {
    if (pct >= t.min && pct < t.max) return t.band;
  }
  return "FORCE_RESET";
}

/** Per-agent inputs to the engine for a single measurement tick. */
export interface MeasureInput {
  agent: AgentName;
  /**
   * Layer 1/2: a runtime token count from the agent itself (statusline, usage block).
   * If provided, used verbatim — no buffer applied.
   */
  runtimeTokens?: number;
  /** Layer 3: file paths whose contents count toward the estimate. */
  files?: string[];
  /** Layer 3: in-memory text segments (e.g., recent log window). */
  segments?: string[];
  /** Override window max (defaults to CONTEXT_WINDOWS[agent]). */
  windowMax?: number;
}

export interface UsageSnapshot {
  agent: AgentName;
  tokens: number;
  rawTokens: number;
  windowMax: number;
  pct: number;
  band: ThresholdBand;
  source: TokenSource;
  tokenizer: string;
  bufferApplied: boolean;
  /** Per-component breakdown for debugging. */
  components: { kind: "file" | "segment" | "runtime"; label: string; tokens: number }[];
}

async function readFileSafe(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "";
    throw e;
  }
}

async function tokenize(t: Tokenizer, text: string): Promise<number> {
  const r = t.countTokens(text);
  return typeof r === "number" ? r : await r;
}

export async function measure(
  input: MeasureInput,
  tokenizer: Tokenizer,
): Promise<UsageSnapshot> {
  const windowMax = input.windowMax ?? CONTEXT_WINDOWS[input.agent];
  const components: UsageSnapshot["components"] = [];

  if (typeof input.runtimeTokens === "number" && input.runtimeTokens >= 0) {
    components.push({ kind: "runtime", label: "agent runtime", tokens: input.runtimeTokens });
    const tokens = input.runtimeTokens;
    const pct = tokens / windowMax;
    return {
      agent: input.agent,
      tokens,
      rawTokens: tokens,
      windowMax,
      pct,
      band: bandFor(pct),
      source: "runtime",
      tokenizer: tokenizer.name,
      bufferApplied: false,
      components,
    };
  }

  let raw = 0;
  for (const f of input.files ?? []) {
    const text = await readFileSafe(f);
    const n = await tokenize(tokenizer, text);
    components.push({ kind: "file", label: f, tokens: n });
    raw += n;
  }
  for (let i = 0; i < (input.segments ?? []).length; i++) {
    const s = input.segments![i]!;
    const n = await tokenize(tokenizer, s);
    components.push({ kind: "segment", label: `segment[${i}]`, tokens: n });
    raw += n;
  }

  const buffered = Math.ceil(raw * ESTIMATE_BUFFER);
  const pct = buffered / windowMax;
  return {
    agent: input.agent,
    tokens: buffered,
    rawTokens: raw,
    windowMax,
    pct,
    band: bandFor(pct),
    source: tokenizer.source,
    tokenizer: tokenizer.name,
    bufferApplied: true,
    components,
  };
}

export interface AllSnapshots {
  CLAUDE: UsageSnapshot;
  CODEX: UsageSnapshot;
  GEMINI: UsageSnapshot;
}

export async function measureAll(
  inputs: { CLAUDE: MeasureInput; CODEX: MeasureInput; GEMINI: MeasureInput },
  tokenizers: TokenizerSet = buildTokenizers(),
): Promise<AllSnapshots> {
  const [c, x, g] = await Promise.all([
    measure(inputs.CLAUDE, tokenizers.CLAUDE),
    measure(inputs.CODEX, tokenizers.CODEX),
    measure(inputs.GEMINI, tokenizers.GEMINI),
  ]);
  return { CLAUDE: c, CODEX: x, GEMINI: g };
}
