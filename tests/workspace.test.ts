import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initWorkspace,
  paths,
  readBoard,
  writeBoard,
  appendChangelog,
} from "../src/workspace.js";
import { parseBoard, serializeBoard } from "../src/board.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orchestra-ws-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("initWorkspace", () => {
  it("creates the full .orchestra/ tree", async () => {
    const p = await initWorkspace(root);
    expect(statSync(p.board).isFile()).toBe(true);
    expect(statSync(p.memory).isFile()).toBe(true);
    expect(statSync(p.changelog).isFile()).toBe(true);
    expect(statSync(p.longTerm).isFile()).toBe(true);
    expect(statSync(p.protocol).isFile()).toBe(true);
    expect(statSync(p.agents.claude).isFile()).toBe(true);
    expect(statSync(p.agents.codex).isFile()).toBe(true);
    expect(statSync(p.agents.gemini).isFile()).toBe(true);
    expect(statSync(p.metrics).isFile()).toBe(true);
    expect(statSync(p.sessionsDir).isDirectory()).toBe(true);
    expect(statSync(p.logsDir).isDirectory()).toBe(true);
  });

  it("the produced board.md round-trips through parse/serialize", async () => {
    await initWorkspace(root);
    const p = paths(root);
    const raw = readFileSync(p.board, "utf8");
    expect(serializeBoard(parseBoard(raw))).toBe(raw);
  });

  it("refuses to overwrite without force", async () => {
    await initWorkspace(root);
    await expect(initWorkspace(root)).rejects.toThrow(/already exists/);
  });

  it("force overwrites cleanly", async () => {
    await initWorkspace(root);
    await initWorkspace(root, { force: true });
    const board = await readBoard(root);
    expect(board.control.STATUS).toBe("IDLE");
  });

  it("metrics file is valid JSON with the three agents", async () => {
    const p = await initWorkspace(root);
    const m = JSON.parse(readFileSync(p.metrics, "utf8"));
    expect(m).toEqual({ claude: 0, codex: 0, gemini: 0 });
  });
});

describe("board read/write", () => {
  it("round-trips through writeBoard/readBoard", async () => {
    await initWorkspace(root);
    const b = await readBoard(root);
    b.control.TASK_ID = "123";
    b.control.PHASE = "IMPLEMENT";
    b.objective = "do the thing";
    b.permissions.CODEX = { mode: "WRITE", scope: ["src/**"] };
    await writeBoard(root, b);
    const b2 = await readBoard(root);
    expect(b2.control.TASK_ID).toBe("123");
    expect(b2.control.PHASE).toBe("IMPLEMENT");
    expect(b2.objective).toBe("do the thing");
    expect(b2.permissions.CODEX).toEqual({ mode: "WRITE", scope: ["src/**"] });
  });
});

describe("changelog append-only", () => {
  it("appendChangelog adds entries", async () => {
    const p = await initWorkspace(root);
    await appendChangelog(root, "first entry");
    await appendChangelog(root, "second entry");
    const text = readFileSync(p.changelog, "utf8");
    expect(text.endsWith("first entry\nsecond entry\n")).toBe(true);
  });
});
