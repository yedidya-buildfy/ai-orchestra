import { describe, it, expect } from "vitest";
import { DEFAULT_UPDATE_CMDS, updateOne, updateAll } from "../src/updater.js";

describe("updater defaults", () => {
  it("has sensible npm install -g commands", () => {
    expect(DEFAULT_UPDATE_CMDS.CLAUDE).toMatch(/npm install -g/);
    expect(DEFAULT_UPDATE_CMDS.CODEX).toMatch(/npm install -g/);
    expect(DEFAULT_UPDATE_CMDS.GEMINI).toMatch(/npm install -g/);
  });
});

describe("updateOne", () => {
  it("captures stdout/stderr/exit-code from the chosen command", async () => {
    const r = await updateOne("CLAUDE", "echo hello-from-test");
    expect(r.ok).toBe(true);
    expect(r.stdoutTail).toContain("hello-from-test");
    expect(r.command).toBe("echo hello-from-test");
  });

  it("reports failure for a non-zero exit", async () => {
    const r = await updateOne("CODEX", "false");
    expect(r.ok).toBe(false);
  });

  it("captures stderr when the command fails", async () => {
    const r = await updateOne("GEMINI", "sh -c 'echo nope >&2; exit 1'");
    expect(r.ok).toBe(false);
    expect(r.stderrTail).toContain("nope");
  });
});

describe("updateAll", () => {
  it("runs all selected agents and accepts overrides", async () => {
    const results = await updateAll(["CLAUDE", "CODEX"], {
      CLAUDE: "echo claude-ok",
      CODEX: "echo codex-ok",
    });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.agent)).toEqual(["CLAUDE", "CODEX"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
