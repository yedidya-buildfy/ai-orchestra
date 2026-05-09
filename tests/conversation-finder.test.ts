import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  findClaudeSessionId,
  findCodexSessionId,
  findGeminiSessionId,
  findAgentSessions,
} from "../src/conversation-finder.js";

let fakeHome: string;
let originalOrcHome: string | undefined;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "orc-finder-home-"));
  originalOrcHome = process.env.ORC_HOME;
  process.env.ORC_HOME = fakeHome;
});

afterEach(() => {
  if (originalOrcHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = originalOrcHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

function setMtime(path: string, secondsAgo: number): void {
  const t = (Date.now() - secondsAgo * 1000) / 1000;
  utimesSync(path, t, t);
}

describe("findClaudeSessionId", () => {
  it("returns null when the project dir does not exist", async () => {
    const id = await findClaudeSessionId("/Users/foo/no-such-project");
    expect(id).toBeNull();
  });

  it("returns the UUID of the most-recent .jsonl file in the slug dir", async () => {
    const cwd = "/Users/foo/proj";
    const slug = "-Users-foo-proj";
    const dir = join(fakeHome, ".claude", "projects", slug);
    mkdirSync(dir, { recursive: true });
    const oldId = "00000000-0000-0000-0000-000000000001";
    const newId = "11111111-1111-1111-1111-111111111111";
    writeFileSync(join(dir, `${oldId}.jsonl`), "{}\n");
    writeFileSync(join(dir, `${newId}.jsonl`), "{}\n");
    setMtime(join(dir, `${oldId}.jsonl`), 100);
    setMtime(join(dir, `${newId}.jsonl`), 1);
    const id = await findClaudeSessionId(cwd);
    expect(id).toBe(newId);
  });

  it("ignores non-.jsonl files in the project dir", async () => {
    const cwd = "/Users/foo/proj";
    const dir = join(fakeHome, ".claude", "projects", "-Users-foo-proj");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "scratch.txt"), "x");
    expect(await findClaudeSessionId(cwd)).toBeNull();
  });
});

describe("findCodexSessionId", () => {
  it("returns null when no codex sessions match the cwd", async () => {
    expect(await findCodexSessionId("/no/match")).toBeNull();
  });

  it("returns the id from the most-recent rollout whose meta cwd matches", async () => {
    const sessionsRoot = join(fakeHome, ".codex", "sessions", "2026", "05", "10");
    mkdirSync(sessionsRoot, { recursive: true });
    const otherId = "22222222-2222-2222-2222-222222222222";
    const otherFile = join(sessionsRoot, `rollout-2026-05-10T01-00-00-${otherId}.jsonl`);
    writeFileSync(
      otherFile,
      JSON.stringify({ type: "session_meta", payload: { id: otherId, cwd: "/some/other/dir" } }) +
        "\n",
    );
    const ourId = "33333333-3333-3333-3333-333333333333";
    const ourFile = join(sessionsRoot, `rollout-2026-05-10T02-00-00-${ourId}.jsonl`);
    writeFileSync(
      ourFile,
      JSON.stringify({ type: "session_meta", payload: { id: ourId, cwd: "/Users/foo/proj" } }) +
        "\n",
    );
    setMtime(otherFile, 100);
    setMtime(ourFile, 5);
    expect(await findCodexSessionId("/Users/foo/proj")).toBe(ourId);
  });

  it("falls back to filename UUID when meta has no id field", async () => {
    const sessionsRoot = join(fakeHome, ".codex", "sessions", "2026", "05", "10");
    mkdirSync(sessionsRoot, { recursive: true });
    const id = "44444444-4444-4444-4444-444444444444";
    writeFileSync(
      join(sessionsRoot, `rollout-2026-05-10T03-00-00-${id}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { cwd: "/x/y" } }) + "\n",
    );
    expect(await findCodexSessionId("/x/y")).toBe(id);
  });

  it("skips sessions whose cwd does not match", async () => {
    const sessionsRoot = join(fakeHome, ".codex", "sessions", "2026", "05", "10");
    mkdirSync(sessionsRoot, { recursive: true });
    const id = "55555555-5555-5555-5555-555555555555";
    writeFileSync(
      join(sessionsRoot, `rollout-2026-05-10T04-00-00-${id}.jsonl`),
      JSON.stringify({ payload: { id, cwd: "/elsewhere" } }) + "\n",
    );
    expect(await findCodexSessionId("/Users/foo/proj")).toBeNull();
  });
});

describe("findGeminiSessionId", () => {
  it("returns null when there is no slug mapping or chats dir", async () => {
    expect(await findGeminiSessionId("/no/match")).toBeNull();
  });

  it("uses the slug from ~/.gemini/projects.json when present", async () => {
    const cwd = "/Users/foo/myapp";
    const slug = "myapp-friendly";
    mkdirSync(join(fakeHome, ".gemini"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".gemini", "projects.json"),
      JSON.stringify({ projects: { [cwd]: slug } }),
    );
    const chats = join(fakeHome, ".gemini", "tmp", slug, "chats");
    mkdirSync(chats, { recursive: true });
    const fullId = "66666666-6666-6666-6666-666666666666";
    writeFileSync(
      join(chats, "session-2026-05-10T05-00-66666666.jsonl"),
      JSON.stringify({ sessionId: fullId }) + "\n",
    );
    expect(await findGeminiSessionId(cwd)).toBe(fullId);
  });

  it("falls back to SHA-256(cwd) slug when the cwd is not mapped", async () => {
    const cwd = "/Users/foo/unmapped";
    const slug = createHash("sha256").update(cwd).digest("hex");
    const chats = join(fakeHome, ".gemini", "tmp", slug, "chats");
    mkdirSync(chats, { recursive: true });
    const fullId = "77777777-7777-7777-7777-777777777777";
    writeFileSync(
      join(chats, "session-2026-05-10T06-00-77777777.jsonl"),
      JSON.stringify({ sessionId: fullId }) + "\n",
    );
    expect(await findGeminiSessionId(cwd)).toBe(fullId);
  });

  it("picks the most-recent file when multiple sessions exist", async () => {
    const cwd = "/Users/foo/multi";
    const slug = createHash("sha256").update(cwd).digest("hex");
    const chats = join(fakeHome, ".gemini", "tmp", slug, "chats");
    mkdirSync(chats, { recursive: true });
    const oldId = "88888888-8888-8888-8888-888888888888";
    const oldFile = join(chats, "session-2026-04-01T00-00-88888888.jsonl");
    writeFileSync(oldFile, JSON.stringify({ sessionId: oldId }) + "\n");
    const newId = "99999999-9999-9999-9999-999999999999";
    const newFile = join(chats, "session-2026-05-10T00-00-99999999.jsonl");
    writeFileSync(newFile, JSON.stringify({ sessionId: newId }) + "\n");
    setMtime(oldFile, 1000);
    setMtime(newFile, 1);
    expect(await findGeminiSessionId(cwd)).toBe(newId);
  });
});

describe("findAgentSessions", () => {
  it("returns nulls for all agents when nothing exists", async () => {
    const ids = await findAgentSessions("/totally/empty");
    expect(ids).toEqual({ CLAUDE: null, CODEX: null, GEMINI: null });
  });

  it("populates whichever agents have a matching session", async () => {
    const cwd = "/Users/foo/mixed";
    // Only seed claude.
    const slug = "-Users-foo-mixed";
    const dir = join(fakeHome, ".claude", "projects", slug);
    mkdirSync(dir, { recursive: true });
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    writeFileSync(join(dir, `${id}.jsonl`), "{}\n");
    const ids = await findAgentSessions(cwd);
    expect(ids.CLAUDE).toBe(id);
    expect(ids.CODEX).toBeNull();
    expect(ids.GEMINI).toBeNull();
  });
});
