import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace, paths } from "../src/workspace.js";
import { atomicWrite, countWords } from "../src/fs-atomic.js";
import { compressMemoryIfNeeded, appendToMemory } from "../src/memory.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orch-mem-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("compressMemoryIfNeeded", () => {
  it("no-op when memory is small", async () => {
    await initWorkspace(root);
    const r = await compressMemoryIfNeeded(root);
    expect(r.compressed).toBe(false);
    expect(r.movedWords).toBe(0);
  });

  it("moves old paragraphs to long_term.md when over the warn threshold", async () => {
    await initWorkspace(root);
    const p = paths(root);
    // Build a memory.md > 5500 words made of many paragraphs.
    const para = (id: number) =>
      `paragraph ${id} ` + "lorem ipsum dolor sit amet ".repeat(40);
    const big = Array.from({ length: 60 }, (_, i) => para(i)).join("\n\n") + "\n";
    await atomicWrite(p.memory, big, { bypassGuard: true });
    expect(countWords(big)).toBeGreaterThan(5500);

    const r = await compressMemoryIfNeeded(root);
    expect(r.compressed).toBe(true);
    expect(r.movedWords).toBeGreaterThan(0);

    const memNow = readFileSync(p.memory, "utf8");
    expect(countWords(memNow)).toBeLessThanOrEqual(5500);
    const ltNow = readFileSync(p.longTerm, "utf8");
    expect(ltNow).toMatch(/Archived from memory.md/);
    // The newest paragraph must remain in memory.md.
    expect(memNow).toContain("paragraph 59");
    // The oldest must have moved to long_term.
    expect(ltNow).toContain("paragraph 0");
  });

  it("appendToMemory adds a timestamped section", async () => {
    await initWorkspace(root);
    await appendToMemory(root, "Test heading", "hello\nworld");
    const text = readFileSync(paths(root).memory, "utf8");
    expect(text).toMatch(/## Test heading @ /);
    expect(text).toMatch(/hello\nworld/);
  });
});
