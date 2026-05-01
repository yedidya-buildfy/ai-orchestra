import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace } from "../src/workspace.js";
import { acquireWriterLock, isLocked, WriterLockError } from "../src/lock.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orch-lock-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("writer lock", () => {
  it("can be acquired and released", async () => {
    await initWorkspace(root);
    expect(await isLocked(root)).toBe(false);
    const release = await acquireWriterLock(root);
    expect(await isLocked(root)).toBe(true);
    await release();
    expect(await isLocked(root)).toBe(false);
  });

  it("blocks a second acquirer", async () => {
    await initWorkspace(root);
    const r1 = await acquireWriterLock(root);
    await expect(acquireWriterLock(root, { retries: 0 })).rejects.toBeInstanceOf(
      WriterLockError,
    );
    await r1();
  });

  it("hands off after release", async () => {
    await initWorkspace(root);
    const r1 = await acquireWriterLock(root);
    await r1();
    const r2 = await acquireWriterLock(root);
    await r2();
  });
});
