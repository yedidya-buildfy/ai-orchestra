import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWrite,
  appendOnly,
  assertPureAppend,
  countWords,
  FileSizeExceededError,
  AppendOnlyViolationError,
  AppendOnlyPathError,
} from "../src/fs-atomic.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orchestra-fs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("atomicWrite", () => {
  it("writes content and leaves no temp files behind", async () => {
    const f = join(dir, "board.md");
    await atomicWrite(f, "## Control\n", { bypassGuard: true });
    expect(readFileSync(f, "utf8")).toBe("## Control\n");
    expect(readdirSync(dir).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("rejects board.md content above hard cap", async () => {
    const f = join(dir, "board.md");
    const huge = ("word ".repeat(5000)).trim(); // 5000 words > 4000 cap
    await expect(atomicWrite(f, huge)).rejects.toBeInstanceOf(FileSizeExceededError);
  });

  it("survives concurrent writers without corruption", async () => {
    const f = join(dir, "board.md");
    const writers = Array.from({ length: 25 }, (_, i) =>
      atomicWrite(f, `## Control\nTASK_ID: ${i}\n`, { bypassGuard: true }),
    );
    await Promise.all(writers);
    const content = readFileSync(f, "utf8");
    // Whatever wrote last, the file must be a complete valid string from one writer.
    expect(/^## Control\nTASK_ID: \d+\n$/.test(content)).toBe(true);
    expect(readdirSync(dir).filter((n) => n.includes(".tmp"))).toEqual([]);
  });
});

describe("append-only", () => {
  it("appendOnly grows the file", async () => {
    const f = join(dir, "changelog.md");
    await appendOnly(f, "a");
    await appendOnly(f, "b");
    expect(readFileSync(f, "utf8")).toBe("a\nb\n");
  });

  it("assertPureAppend rejects rewrite that drops history", async () => {
    const f = join(dir, "changelog.md");
    await appendOnly(f, "first");
    await expect(assertPureAppend(f, "different content\n")).rejects.toBeInstanceOf(
      AppendOnlyViolationError,
    );
  });

  it("atomicWrite refuses to clobber changelog.md without bypassGuard", async () => {
    const f = join(dir, "changelog.md");
    await appendOnly(f, "history line");
    await expect(atomicWrite(f, "wiped\n")).rejects.toBeInstanceOf(AppendOnlyPathError);
    // bypassGuard escape hatch still works (used by safeRewriteChangelog after assertPureAppend)
    await atomicWrite(f, "history line\nmore\n", { bypassGuard: true });
    expect(readFileSync(f, "utf8")).toBe("history line\nmore\n");
  });

  it("assertPureAppend accepts strict prefix", async () => {
    const f = join(dir, "changelog.md");
    await appendOnly(f, "first");
    await assertPureAppend(f, "first\nsecond\n");
  });
});

describe("countWords", () => {
  it("counts whitespace-separated tokens", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
    expect(countWords("a b  c\nd")).toBe(4);
  });
});
