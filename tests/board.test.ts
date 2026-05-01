import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBoard, serializeBoard, defaultBoard } from "../src/board.js";

const here = dirname(fileURLToPath(import.meta.url));
const templateBoard = resolve(here, "..", "templates", "board.md");

describe("board parser/serializer", () => {
  it("default board serialize → parse → serialize is stable", () => {
    const a = serializeBoard(defaultBoard());
    const b = serializeBoard(parseBoard(a));
    expect(b).toBe(a);
  });

  it("template board.md round-trips with zero diff", () => {
    const raw = readFileSync(templateBoard, "utf8");
    const parsed = parseBoard(raw);
    const out = serializeBoard(parsed);
    expect(out).toBe(raw);
  });

  it("hand-written canonical board round-trips", () => {
    const raw = [
      "## Control",
      "TASK_ID: 042",
      "PHASE: IMPLEMENT",
      "TASK_TYPE: FIX",
      "NEXT_AGENT: CODEX",
      "STATUS: ACTIVE",
      "",
      "## Permissions",
      "CODEX:",
      '  mode: WRITE',
      '  scope: ["src/api/*","src/lib/*"]',
      "",
      "GEMINI:",
      "  mode: READ",
      "  scope: []",
      "",
      "## Context Health",
      "CLAUDE: 78%",
      "CODEX: 34%",
      "GEMINI: 21%",
      "",
      "## Objective",
      "Fix ZIP validation bug",
      "",
      "## Claude",
      "Planning the fix.",
      "",
      "## Codex",
      "Investigating src/api/zip.ts",
      "",
      "## Gemini",
      "(empty)",
      "",
      "## Decisions",
      "- Use stricter ZIP regex",
      "",
      "## Changelog",
      "- 2026-05-01 task created",
      "",
    ].join("\n");
    const board = parseBoard(raw);
    expect(board.control.TASK_ID).toBe("042");
    expect(board.permissions.CODEX.mode).toBe("WRITE");
    expect(board.permissions.CODEX.scope).toEqual(["src/api/*", "src/lib/*"]);
    expect(board.contextHealth.CLAUDE).toBeCloseTo(0.78);
    const out = serializeBoard(board);
    expect(out).toBe(raw);
  });

  it("rejects missing required section", () => {
    const bad = "## Control\nTASK_ID: 1\nPHASE: IDLE\nTASK_TYPE: NONE\nNEXT_AGENT: CLAUDE\nSTATUS: IDLE\n";
    expect(() => parseBoard(bad)).toThrow(/missing section/);
  });

  it("rejects invalid permission mode", () => {
    const bad = serializeBoard(defaultBoard()).replace("mode: READ", "mode: SUPER");
    expect(() => parseBoard(bad)).toThrow(/mode invalid/);
  });

  it("preserves multi-line free-text bodies", () => {
    const b = defaultBoard();
    b.objective = "line1\n\nline3";
    b.claude = "thoughts:\n- a\n- b";
    const round = serializeBoard(parseBoard(serializeBoard(b)));
    expect(round).toBe(serializeBoard(b));
  });
});
