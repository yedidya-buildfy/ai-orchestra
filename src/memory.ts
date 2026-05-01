import { promises as fs } from "node:fs";
import { atomicWrite, appendOnly, countWords } from "./fs-atomic.js";
import { paths } from "./workspace.js";
import { FILE_LIMITS } from "./types.js";

/**
 * Memory compression: when memory.md crosses its hard cap, peel off the
 * oldest paragraphs and append them to long_term.md. The result keeps
 * memory.md under the cap without losing information.
 *
 * Compression is deterministic — we do not call out to any LLM here. Per
 * PRD §15 the orchestrator agent itself can choose to summarize further on
 * its next turn; this routine only ensures the system stays correct under
 * size pressure regardless of agent activity.
 */
export interface CompressionResult {
  compressed: boolean;
  movedWords: number;
  remainingWords: number;
}

const PARA_SPLIT = /\n\n+/;

export async function compressMemoryIfNeeded(root: string): Promise<CompressionResult> {
  const p = paths(root);
  const text = await fs.readFile(p.memory, "utf8").catch(() => "");
  const words = countWords(text);
  const warn = FILE_LIMITS["memory.md"].warnWords;
  if (words <= warn) {
    return { compressed: false, movedWords: 0, remainingWords: words };
  }

  const paras = text.split(PARA_SPLIT);
  if (paras.length < 2) {
    // Nothing to split — single huge paragraph; force-truncate by sentences.
    return forceTruncate(root, text, words);
  }

  // Heuristic: keep paragraphs from the end until we're under `warn`, move rest.
  const kept: string[] = [];
  const moved: string[] = [];
  let keptWords = 0;
  for (let i = paras.length - 1; i >= 0; i--) {
    const para = paras[i]!;
    const w = countWords(para);
    if (keptWords + w <= warn || kept.length === 0) {
      kept.unshift(para);
      keptWords += w;
    } else {
      moved.unshift(para);
    }
  }
  const remaining = kept.join("\n\n");
  const archive = moved.join("\n\n");

  if (!archive) {
    return { compressed: false, movedWords: 0, remainingWords: words };
  }

  const stamp = new Date().toISOString();
  await appendOnly(
    p.longTerm,
    `\n## Archived from memory.md @ ${stamp}\n\n${archive}\n`,
  );
  await atomicWrite(p.memory, ensureTrailingNewline(remaining));
  return {
    compressed: true,
    movedWords: countWords(archive),
    remainingWords: countWords(remaining),
  };
}

async function forceTruncate(
  root: string,
  text: string,
  words: number,
): Promise<CompressionResult> {
  const p = paths(root);
  const limit = FILE_LIMITS["memory.md"].warnWords;
  const allWords = text.split(/\s+/);
  const headCount = allWords.length - limit;
  const head = allWords.slice(0, headCount).join(" ");
  const tail = allWords.slice(headCount).join(" ");
  const stamp = new Date().toISOString();
  await appendOnly(
    p.longTerm,
    `\n## Archived from memory.md (force-truncate) @ ${stamp}\n\n${head}\n`,
  );
  await atomicWrite(p.memory, ensureTrailingNewline(tail));
  return {
    compressed: true,
    movedWords: countWords(head),
    remainingWords: countWords(tail),
  };
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}

/** Append a section to memory.md (creating if needed). */
export async function appendToMemory(root: string, heading: string, body: string): Promise<void> {
  const p = paths(root);
  const existing = await fs.readFile(p.memory, "utf8").catch(() => "");
  const stamp = new Date().toISOString();
  const next =
    (existing.endsWith("\n") ? existing : existing + "\n") +
    `\n## ${heading} @ ${stamp}\n\n${body.trimEnd()}\n`;
  await atomicWrite(p.memory, next);
}
