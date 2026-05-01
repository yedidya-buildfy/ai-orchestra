import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  DEFAULT_CONFIG,
  configPath,
  loadConfig,
  validateConfig,
  writeConfig,
} from "../src/config.js";
import { initWorkspace } from "../src/workspace.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orch-cfg-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("config", () => {
  it("returns DEFAULT_CONFIG when no config file exists", async () => {
    await initWorkspace(root);
    const cfg = await loadConfig(root);
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it("merges partial overrides with defaults", async () => {
    await initWorkspace(root);
    mkdirSync(join(root, ".orchestra"), { recursive: true });
    writeFileSync(
      configPath(root),
      JSON.stringify({ agents: { CODEX: { command: "my-codex --flag" } } }),
      "utf8",
    );
    const cfg = await loadConfig(root);
    expect(cfg.agents.CODEX.command).toBe("my-codex --flag");
    expect(cfg.agents.CLAUDE.command).toBe("claude"); // unchanged
    expect(cfg.contextWindows.GEMINI).toBe(1_000_000);
  });

  it("rejects invalid thresholds", () => {
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        thresholds: { ok: 0.9, warning: 0.8, summarize: 0.7, refresh: 0.6 },
      }),
    ).toThrow(ConfigError);
  });

  it("rejects empty agent command", () => {
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        agents: { ...DEFAULT_CONFIG.agents, CLAUDE: { command: "  " } },
      }),
    ).toThrow(ConfigError);
  });

  it("writeConfig validates before writing", async () => {
    await initWorkspace(root);
    await expect(
      writeConfig(root, {
        ...DEFAULT_CONFIG,
        contextWindows: { ...DEFAULT_CONFIG.contextWindows, CLAUDE: -1 },
      }),
    ).rejects.toThrow(ConfigError);
  });

  it("rejects malformed JSON", async () => {
    await initWorkspace(root);
    mkdirSync(join(root, ".orchestra"), { recursive: true });
    writeFileSync(configPath(root), "{ not json", "utf8");
    await expect(loadConfig(root)).rejects.toThrow(/invalid JSON/);
  });
});
