import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustClaude, trustCodex, trustGemini, trustPath } from "../src/trust.js";

let fakeHome: string;
let origHome: string | undefined;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "orch-trust-home-"));
  origHome = process.env["HOME"];
  process.env["HOME"] = fakeHome;
});
afterEach(() => {
  if (origHome !== undefined) process.env["HOME"] = origHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("trustClaude", () => {
  it("creates ~/.claude.json with hasTrustDialogAccepted on first call", async () => {
    const r = await trustClaude("/projects/myapp");
    expect(r.changed).toBe(true);
    const json = JSON.parse(readFileSync(join(fakeHome, ".claude.json"), "utf8"));
    expect(json.projects["/projects/myapp"].hasTrustDialogAccepted).toBe(true);
  });

  it("is idempotent — second call returns changed=false", async () => {
    await trustClaude("/projects/myapp");
    const r = await trustClaude("/projects/myapp");
    expect(r.changed).toBe(false);
    expect(r.detail).toMatch(/already trusted/);
  });

  it("preserves existing keys in ~/.claude.json", async () => {
    writeFileSync(
      join(fakeHome, ".claude.json"),
      JSON.stringify({ someExistingKey: 42, projects: { "/other": { hasTrustDialogAccepted: true } } }),
    );
    await trustClaude("/projects/myapp");
    const json = JSON.parse(readFileSync(join(fakeHome, ".claude.json"), "utf8"));
    expect(json.someExistingKey).toBe(42);
    expect(json.projects["/other"].hasTrustDialogAccepted).toBe(true);
    expect(json.projects["/projects/myapp"].hasTrustDialogAccepted).toBe(true);
  });
});

describe("trustGemini", () => {
  it("creates ~/.gemini/settings.json with trustedFolders array", async () => {
    const r = await trustGemini("/projects/myapp");
    expect(r.changed).toBe(true);
    const json = JSON.parse(readFileSync(join(fakeHome, ".gemini", "settings.json"), "utf8"));
    expect(json.trustedFolders).toEqual(["/projects/myapp"]);
  });

  it("appends to an existing trustedFolders array", async () => {
    mkdirSync(join(fakeHome, ".gemini"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".gemini", "settings.json"),
      JSON.stringify({ trustedFolders: ["/already/here"], otherKey: "x" }),
    );
    await trustGemini("/projects/myapp");
    const json = JSON.parse(readFileSync(join(fakeHome, ".gemini", "settings.json"), "utf8"));
    expect(json.trustedFolders).toEqual(["/already/here", "/projects/myapp"]);
    expect(json.otherKey).toBe("x");
  });

  it("supports the object-map schema for trustedFolders", async () => {
    mkdirSync(join(fakeHome, ".gemini"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".gemini", "settings.json"),
      JSON.stringify({ trustedFolders: { "/already/here": true } }),
    );
    await trustGemini("/projects/myapp");
    const json = JSON.parse(readFileSync(join(fakeHome, ".gemini", "settings.json"), "utf8"));
    expect(json.trustedFolders["/already/here"]).toBe(true);
    expect(json.trustedFolders["/projects/myapp"]).toBe(true);
  });

  it("idempotent on the same path", async () => {
    await trustGemini("/projects/myapp");
    const r = await trustGemini("/projects/myapp");
    expect(r.changed).toBe(false);
  });
});

describe("trustCodex", () => {
  it("appends a [projects.\"<path>\"] section to ~/.codex/config.toml", async () => {
    const r = await trustCodex("/projects/myapp");
    expect(r.changed).toBe(true);
    const body = readFileSync(join(fakeHome, ".codex", "config.toml"), "utf8");
    expect(body).toContain('[projects."/projects/myapp"]');
    expect(body).toContain('trust_level = "trusted"');
  });

  it("idempotent — second call leaves config unchanged", async () => {
    await trustCodex("/projects/myapp");
    const before = readFileSync(join(fakeHome, ".codex", "config.toml"), "utf8");
    const r = await trustCodex("/projects/myapp");
    expect(r.changed).toBe(false);
    const after = readFileSync(join(fakeHome, ".codex", "config.toml"), "utf8");
    expect(after).toBe(before);
  });

  it("preserves existing config.toml content", async () => {
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".codex", "config.toml"),
      `[user]\nname = "alice"\n`,
    );
    await trustCodex("/projects/myapp");
    const body = readFileSync(join(fakeHome, ".codex", "config.toml"), "utf8");
    expect(body).toContain(`name = "alice"`);
    expect(body).toContain(`[projects."/projects/myapp"]`);
  });
});

describe("trustPath (all three)", () => {
  it("returns one result per agent", async () => {
    const results = await trustPath("/projects/myapp");
    expect(results.map((r) => r.agent).sort()).toEqual(["CLAUDE", "CODEX", "GEMINI"]);
    expect(results.every((r) => r.changed)).toBe(true);
  });
});
