import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace } from "../src/workspace.js";
import {
  buildAdapters,
  buildYoloResumeCommand,
  YOLO_AGENT_CONFIG,
} from "../src/agent-adapter.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orch-yolo-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("YOLO_AGENT_CONFIG", () => {
  it("includes the bypass flag for each agent", () => {
    expect(YOLO_AGENT_CONFIG.CLAUDE.command).toBe("claude --dangerously-skip-permissions");
    expect(YOLO_AGENT_CONFIG.CODEX.command).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox",
    );
    expect(YOLO_AGENT_CONFIG.GEMINI.command).toBe("gemini --yolo");
  });

  it("buildAdapters with YOLO config produces adapters that hold the right commands", async () => {
    await initWorkspace(root);
    const adapters = buildAdapters(root, YOLO_AGENT_CONFIG);
    expect(adapters.CLAUDE.tmux.command).toContain("--dangerously-skip-permissions");
    expect(adapters.CODEX.tmux.command).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(adapters.GEMINI.tmux.command).toContain("--yolo");
  });
});

describe("buildYoloResumeCommand", () => {
  it("returns the bare YOLO command when no session id is given", () => {
    expect(buildYoloResumeCommand("CLAUDE", null)).toBe(YOLO_AGENT_CONFIG.CLAUDE.command);
    expect(buildYoloResumeCommand("CODEX", null)).toBe(YOLO_AGENT_CONFIG.CODEX.command);
    expect(buildYoloResumeCommand("GEMINI", null)).toBe(YOLO_AGENT_CONFIG.GEMINI.command);
  });

  it("appends --resume <id> for claude (top-level flag form)", () => {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(buildYoloResumeCommand("CLAUDE", id)).toBe(
      `claude --dangerously-skip-permissions --resume ${id}`,
    );
  });

  it("appends --resume <id> for gemini", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(buildYoloResumeCommand("GEMINI", id)).toBe(`gemini --yolo --resume ${id}`);
  });

  it("uses the `resume <id>` subcommand form for codex with the bypass flag AFTER", () => {
    // codex 0.128+ requires the bypass flag to follow the subcommand —
    // this is the gotcha that earlier `codex --full-auto` setups tripped on.
    const id = "01234567-89ab-cdef-0123-456789abcdef";
    expect(buildYoloResumeCommand("CODEX", id)).toBe(
      `codex resume ${id} --dangerously-bypass-approvals-and-sandbox`,
    );
  });
});
