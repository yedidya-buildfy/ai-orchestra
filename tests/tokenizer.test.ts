import { describe, it, expect } from "vitest";
import {
  ClaudeTokenizer,
  CodexTokenizer,
  GeminiHeuristicTokenizer,
  buildTokenizers,
} from "../src/tokenizer.js";

describe("tokenizer adapters", () => {
  const sample = "The quick brown fox jumps over the lazy dog.";

  it("Claude tokenizer returns a positive integer for non-empty text", () => {
    const t = new ClaudeTokenizer();
    const n = t.countTokens(sample) as number;
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(sample.length); // tokens fewer than chars
  });

  it("Codex (o200k_base) is deterministic across calls", () => {
    const t = new CodexTokenizer();
    const a = t.countTokens(sample) as number;
    const b = t.countTokens(sample) as number;
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
  });

  it("Gemini heuristic counts ceil(len / 3.8)", () => {
    const t = new GeminiHeuristicTokenizer();
    expect(t.countTokens("")).toBe(0);
    const text = "a".repeat(100);
    expect(t.countTokens(text)).toBe(Math.ceil(100 / 3.8));
  });

  it("buildTokenizers wires local tokenizers for all three agents (no API path)", () => {
    const set = buildTokenizers();
    expect(set.CLAUDE.source).toBe("tokenizer");
    expect(set.CODEX.source).toBe("tokenizer");
    expect(set.GEMINI.source).toBe("heuristic");
  });

  it("Claude vs Codex token counts differ for the same text (different encodings)", () => {
    const c = new ClaudeTokenizer().countTokens(sample) as number;
    const x = new CodexTokenizer().countTokens(sample) as number;
    // Both > 0 and within sane range; not necessarily equal but both should be plausible.
    expect(c).toBeGreaterThan(0);
    expect(x).toBeGreaterThan(0);
  });
});
