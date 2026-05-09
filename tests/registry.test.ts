import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSession,
  listSessions,
  loadRegistry,
  registryPath,
  removeSession,
  saveRegistry,
  setSession,
  touchSession,
  type SessionEntry,
} from "../src/registry.js";

let tmpDir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "orc-registry-"));
  originalEnv = process.env.ORC_REGISTRY_PATH;
  process.env.ORC_REGISTRY_PATH = join(tmpDir, "sessions.json");
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.ORC_REGISTRY_PATH;
  else process.env.ORC_REGISTRY_PATH = originalEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

function entry(dir: string, ids: Partial<SessionEntry["agentSessions"]> = {}): SessionEntry {
  const now = new Date().toISOString();
  return {
    dir,
    createdAt: now,
    lastUsed: now,
    agentSessions: { CLAUDE: null, CODEX: null, GEMINI: null, ...ids },
  };
}

describe("registry", () => {
  it("returns an empty registry when no file exists yet", async () => {
    const reg = await loadRegistry();
    expect(reg.sessions).toEqual({});
  });

  it("setSession creates the file and getSession reads it back", async () => {
    await setSession("zip-bug", entry("/tmp/work", { CLAUDE: "uuid-1" }));
    expect(existsSync(registryPath())).toBe(true);
    const e = await getSession("zip-bug");
    expect(e?.dir).toBe("/tmp/work");
    expect(e?.agentSessions.CLAUDE).toBe("uuid-1");
  });

  it("setSession overwrites an existing entry", async () => {
    await setSession("a", entry("/path/old"));
    await setSession("a", entry("/path/new", { CODEX: "uuid-c" }));
    const e = await getSession("a");
    expect(e?.dir).toBe("/path/new");
    expect(e?.agentSessions.CODEX).toBe("uuid-c");
  });

  it("rejects empty/blank session names", async () => {
    await expect(setSession("", entry("/x"))).rejects.toThrow(/non-empty/);
    await expect(setSession("   ", entry("/x"))).rejects.toThrow(/non-empty/);
  });

  it("removeSession returns true when removed, false when missing", async () => {
    await setSession("present", entry("/a"));
    expect(await removeSession("present")).toBe(true);
    expect(await getSession("present")).toBeNull();
    expect(await removeSession("never-existed")).toBe(false);
  });

  it("listSessions sorts by lastUsed desc", async () => {
    await setSession("oldest", {
      ...entry("/a"),
      lastUsed: "2025-01-01T00:00:00Z",
    });
    await setSession("newest", {
      ...entry("/b"),
      lastUsed: "2026-12-31T00:00:00Z",
    });
    await setSession("middle", {
      ...entry("/c"),
      lastUsed: "2026-06-15T00:00:00Z",
    });
    const items = await listSessions();
    expect(items.map((i) => i.name)).toEqual(["newest", "middle", "oldest"]);
  });

  it("touchSession updates lastUsed timestamp", async () => {
    const old = "2020-01-01T00:00:00.000Z";
    await setSession("touchme", { ...entry("/x"), lastUsed: old });
    await touchSession("touchme");
    const e = await getSession("touchme");
    expect(e?.lastUsed).not.toBe(old);
    expect(new Date(e!.lastUsed).getTime()).toBeGreaterThan(new Date(old).getTime());
  });

  it("touchSession is a no-op for missing names (does not throw)", async () => {
    await expect(touchSession("nope")).resolves.toBeUndefined();
  });

  it("recovers from a corrupt registry file by returning empty", async () => {
    const path = registryPath();
    await saveRegistry({ sessions: { ok: entry("/x") } });
    // Corrupt the file
    const fs = await import("node:fs/promises");
    await fs.writeFile(path, "{ this isn't valid JSON", "utf8");
    const reg = await loadRegistry();
    expect(reg.sessions).toEqual({});
    expect(readFileSync(path, "utf8")).toContain("this isn't valid JSON");
  });

  it("registryPath honors XDG_CONFIG_HOME when ORC_REGISTRY_PATH is unset", async () => {
    const xdgDir = mkdtempSync(join(tmpdir(), "orc-xdg-"));
    delete process.env.ORC_REGISTRY_PATH;
    const oldXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdgDir;
    try {
      expect(registryPath()).toBe(join(xdgDir, "orc", "sessions.json"));
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldXdg;
      process.env.ORC_REGISTRY_PATH = join(tmpDir, "sessions.json");
      rmSync(xdgDir, { recursive: true, force: true });
    }
  });
});
