import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace, paths, readBoard } from "../src/workspace.js";
import { refreshContext } from "../src/context-writer.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orchestra-cw-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("refreshContext", () => {
  it("updates board.md Context Health and metrics/context.json", async () => {
    await initWorkspace(root);
    const { snapshots, metricsPath } = await refreshContext(root);

    // metrics file is valid JSON with all three percentages and detail
    const m = JSON.parse(readFileSync(metricsPath, "utf8"));
    expect(typeof m.claude).toBe("number");
    expect(typeof m.codex).toBe("number");
    expect(typeof m.gemini).toBe("number");
    expect(m.detail.CLAUDE.tokenizer).toBeDefined();
    expect(typeof m.updatedAt).toBe("string");

    // board reflects same percentages
    const board = await readBoard(root);
    expect(board.contextHealth.CLAUDE).toBeCloseTo(snapshots.CLAUDE.pct);
    expect(board.contextHealth.CODEX).toBeCloseTo(snapshots.CODEX.pct);
    expect(board.contextHealth.GEMINI).toBeCloseTo(snapshots.GEMINI.pct);
  });

  it("runtime overrides flow through to board and metrics", async () => {
    await initWorkspace(root);
    const { snapshots } = await refreshContext(root, {
      runtime: { CLAUDE: 100_000 }, // 50% of 200k
    });
    expect(snapshots.CLAUDE.source).toBe("runtime");
    expect(snapshots.CLAUDE.pct).toBeCloseTo(0.5);
    const board = await readBoard(root);
    expect(board.contextHealth.CLAUDE).toBeCloseTo(0.5);
  });

  it("usage rises after memory.md grows", async () => {
    await initWorkspace(root);
    const before = (await refreshContext(root)).snapshots.CLAUDE.tokens;
    const p = paths(root);
    appendFileSync(p.memory, "\n\n" + "lorem ipsum dolor sit amet ".repeat(200));
    const after = (await refreshContext(root)).snapshots.CLAUDE.tokens;
    expect(after).toBeGreaterThan(before);
  });

  it("board.md remains parseable after multiple refreshes", async () => {
    await initWorkspace(root);
    for (let i = 0; i < 5; i++) {
      await refreshContext(root, { runtime: { CODEX: i * 1000 } });
    }
    const board = await readBoard(root);
    expect(board.control.STATUS).toBe("IDLE"); // unrelated fields preserved
  });
});
