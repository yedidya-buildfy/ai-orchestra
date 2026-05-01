import lockfile from "proper-lockfile";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { paths } from "./workspace.js";

/**
 * Single-writer guarantee: only one process at a time may dispatch / write
 * the board. Backed by proper-lockfile (a directory-based lock that survives
 * crashes via stale-detection).
 */
export class WriterLockError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "WriterLockError";
  }
}

export interface ReleaseLock {
  (): Promise<void>;
}

export async function acquireWriterLock(
  root: string,
  opts: { staleMs?: number; retries?: number } = {},
): Promise<ReleaseLock> {
  const p = paths(root);
  // proper-lockfile locks an existing file. Ensure target exists.
  await fs.mkdir(dirname(p.lockfile), { recursive: true });
  try {
    await fs.access(p.lockfile);
  } catch {
    await fs.writeFile(p.lockfile, "", "utf8");
  }
  try {
    const release = await lockfile.lock(p.lockfile, {
      stale: opts.staleMs ?? 60_000,
      retries: opts.retries ?? 0,
      realpath: false,
    });
    return async () => {
      await release();
    };
  } catch (e) {
    throw new WriterLockError(
      `could not acquire writer lock at ${p.lockfile}: ${(e as Error).message}`,
    );
  }
}

export async function isLocked(root: string): Promise<boolean> {
  const p = paths(root);
  try {
    return await lockfile.check(p.lockfile, { realpath: false });
  } catch {
    return false;
  }
}
