import { promises as fs } from "node:fs";
import { dirname, join, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { FILE_LIMITS, type GuardedFile } from "./types.js";

export class FileSizeExceededError extends Error {
  constructor(file: string, words: number, limit: number) {
    super(`File ${file} would exceed hard cap: ${words} > ${limit} words`);
    this.name = "FileSizeExceededError";
  }
}

export class AppendOnlyViolationError extends Error {
  constructor(file: string) {
    super(`File ${file} is append-only; non-append rewrite rejected`);
    this.name = "AppendOnlyViolationError";
  }
}

export class AppendOnlyPathError extends Error {
  constructor(file: string) {
    super(
      `File ${file} is append-only; use appendOnly() or safeRewriteChangelog() instead of atomicWrite()`,
    );
    this.name = "AppendOnlyPathError";
  }
}

const APPEND_ONLY_BASENAMES = new Set(["changelog.md"]);

export function isAppendOnlyPath(filePath: string): boolean {
  return APPEND_ONLY_BASENAMES.has(basename(filePath));
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function guardFor(filePath: string): GuardedFile | null {
  const name = basename(filePath);
  if (name === "board.md" || name === "memory.md") return name;
  return null;
}

export interface AtomicWriteOptions {
  /** Skip size guard. Use only for non-guarded files. */
  bypassGuard?: boolean;
}

/** Atomic write: write to sibling temp, fsync, rename over target. */
export async function atomicWrite(
  filePath: string,
  contents: string,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  if (!opts.bypassGuard && isAppendOnlyPath(filePath)) {
    throw new AppendOnlyPathError(filePath);
  }
  const guard = guardFor(filePath);
  if (guard && !opts.bypassGuard) {
    const limit = FILE_LIMITS[guard].hardWords;
    const words = countWords(contents);
    if (words > limit) {
      throw new FileSizeExceededError(filePath, words, limit);
    }
  }

  await fs.mkdir(dirname(filePath), { recursive: true });
  const tmp = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(contents, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, filePath);
}

/** Append text to a file. Used for changelog.md to enforce append-only semantics. */
export async function appendOnly(filePath: string, text: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
  const toAppend = text.endsWith("\n") ? text : text + "\n";
  await fs.appendFile(filePath, toAppend, "utf8");
}

/**
 * Verify a proposed full-rewrite of an append-only file is actually a pure append:
 * the new content must start with the existing content byte-for-byte.
 * Use this if a caller insists on rewrite; otherwise prefer appendOnly().
 */
export async function assertPureAppend(
  filePath: string,
  proposedContent: string,
): Promise<void> {
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (!proposedContent.startsWith(existing)) {
    throw new AppendOnlyViolationError(filePath);
  }
}

export async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function checkSizeWarning(
  filePath: string,
  contents: string,
): { warn: boolean; words: number; warnAt?: number } {
  const guard = guardFor(filePath);
  if (!guard) return { warn: false, words: countWords(contents) };
  const limits = FILE_LIMITS[guard];
  const words = countWords(contents);
  return { warn: words >= limits.warnWords, words, warnAt: limits.warnWords };
}
