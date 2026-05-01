import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bandFor,
  CONTEXT_WINDOWS,
  ESTIMATE_BUFFER,
  measure,
  measureAll,
  THRESHOLDS,
} from "../src/context-engine.js";
import { GeminiHeuristicTokenizer, CodexTokenizer, ClaudeTokenizer } from "../src/tokenizer.js";

describe("threshold bands (PRD §10)", () => {
  it("covers all five bands at canonical points", () => {
    expect(bandFor(0)).toBe("OK");
    expect(bandFor(0.5)).toBe("OK");
    expect(bandFor(0.7)).toBe("WARNING");
    expect(bandFor(0.79)).toBe("WARNING");
    expect(bandFor(0.8)).toBe("SUMMARIZE");
    expect(bandFor(0.89)).toBe("SUMMARIZE");
    expect(bandFor(0.9)).toBe("REFRESH");
    expect(bandFor(0.949)).toBe("REFRESH");
    expect(bandFor(0.95)).toBe("FORCE_RESET");
    expect(bandFor(1.5)).toBe("FORCE_RESET");
  });

  it("five bands are defined", () => {
    expect(THRESHOLDS.map((t) => t.band)).toEqual([
      "OK",
      "WARNING",
      "SUMMARIZE",
      "REFRESH",
      "FORCE_RESET",
    ]);
  });
});

describe("context windows (PRD §9)", () => {
  it("matches PRD values", () => {
    expect(CONTEXT_WINDOWS.CLAUDE).toBe(200_000);
    expect(CONTEXT_WINDOWS.CODEX).toBe(200_000);
    expect(CONTEXT_WINDOWS.GEMINI).toBe(1_000_000);
  });
});

describe("measure() — estimation path", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orchestra-ctx-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies ×1.2 buffer to estimated tokens", async () => {
    const tok = new GeminiHeuristicTokenizer();
    const f = join(dir, "x.md");
    writeFileSync(f, "a".repeat(380)); // 380 chars / 3.8 = 100 tokens raw
    const snap = await measure({ agent: "GEMINI", files: [f] }, tok);
    expect(snap.rawTokens).toBe(100);
    expect(snap.tokens).toBe(Math.ceil(100 * ESTIMATE_BUFFER)); // 120
    expect(snap.bufferApplied).toBe(true);
    expect(snap.source).toBe("heuristic");
  });

  it("missing file is treated as empty", async () => {
    const tok = new CodexTokenizer();
    const snap = await measure(
      { agent: "CODEX", files: [join(dir, "nonexistent.md")], segments: ["hello world"] },
      tok,
    );
    expect(snap.rawTokens).toBeGreaterThan(0);
    const filesEntry = snap.components.find((c) => c.kind === "file");
    expect(filesEntry?.tokens).toBe(0);
  });

  it("merges files + segments into total", async () => {
    const tok = new ClaudeTokenizer();
    const f = join(dir, "y.md");
    writeFileSync(f, "alpha beta gamma");
    const snap = await measure(
      { agent: "CLAUDE", files: [f], segments: ["delta epsilon"] },
      tok,
    );
    const sum = snap.components.reduce((acc, c) => acc + c.tokens, 0);
    expect(snap.rawTokens).toBe(sum);
  });
});

describe("measure() — runtime path", () => {
  it("uses runtimeTokens verbatim and skips buffer", async () => {
    const tok = new GeminiHeuristicTokenizer();
    const snap = await measure(
      { agent: "CLAUDE", runtimeTokens: 50_000, files: ["unused"] },
      tok,
    );
    expect(snap.tokens).toBe(50_000);
    expect(snap.rawTokens).toBe(50_000);
    expect(snap.bufferApplied).toBe(false);
    expect(snap.source).toBe("runtime");
    expect(snap.pct).toBeCloseTo(50_000 / CONTEXT_WINDOWS.CLAUDE);
    expect(snap.band).toBe("OK");
  });

  it("runtime numbers cross thresholds correctly", async () => {
    const tok = new GeminiHeuristicTokenizer();
    const at95 = await measure(
      { agent: "CODEX", runtimeTokens: Math.floor(0.95 * CONTEXT_WINDOWS.CODEX) },
      tok,
    );
    expect(at95.band).toBe("FORCE_RESET");

    const at90 = await measure(
      { agent: "CODEX", runtimeTokens: Math.floor(0.91 * CONTEXT_WINDOWS.CODEX) },
      tok,
    );
    expect(at90.band).toBe("REFRESH");
  });
});

describe("measureAll", () => {
  it("returns one snapshot per agent", async () => {
    const all = await measureAll({
      CLAUDE: { agent: "CLAUDE", segments: ["hello claude"] },
      CODEX: { agent: "CODEX", segments: ["hello codex"] },
      GEMINI: { agent: "GEMINI", segments: ["hello gemini"] },
    });
    expect(all.CLAUDE.agent).toBe("CLAUDE");
    expect(all.CODEX.agent).toBe("CODEX");
    expect(all.GEMINI.agent).toBe("GEMINI");
  });
});
