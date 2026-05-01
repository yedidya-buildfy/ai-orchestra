import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace } from "../src/workspace.js";
import { buildAdapters, YOLO_AGENT_CONFIG } from "../src/agent-adapter.js";

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
    expect(YOLO_AGENT_CONFIG.CODEX.command).toBe("codex --full-auto");
    expect(YOLO_AGENT_CONFIG.GEMINI.command).toBe("gemini --yolo");
  });

  it("buildAdapters with YOLO config produces adapters that hold the right commands", async () => {
    await initWorkspace(root);
    const adapters = buildAdapters(root, YOLO_AGENT_CONFIG);
    expect(adapters.CLAUDE.tmux.command).toContain("--dangerously-skip-permissions");
    expect(adapters.CODEX.tmux.command).toContain("--full-auto");
    expect(adapters.GEMINI.tmux.command).toContain("--yolo");
  });
});
