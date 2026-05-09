import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace, paths } from "../src/workspace.js";
import { buildBootstrapPrompt, prepareBootstrap } from "../src/bootstrap-prompt.js";

let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "orc-bootstrap-"));
  await initWorkspace(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("buildBootstrapPrompt", () => {
  it("loads the role file from .orchestra/agents/<agent>.md", async () => {
    const claudePrompt = await buildBootstrapPrompt("CLAUDE", root);
    // The default scaffolded role file says "Claude — Orchestrator"
    expect(claudePrompt).toMatch(/Claude — Orchestrator/);

    const codexPrompt = await buildBootstrapPrompt("CODEX", root);
    expect(codexPrompt).toMatch(/Codex — Technical/);

    const geminiPrompt = await buildBootstrapPrompt("GEMINI", root);
    expect(geminiPrompt).toMatch(/Gemini — UX/);
  });

  it("respects user edits to a role file (changes flow into the prompt)", async () => {
    const p = paths(root);
    writeFileSync(
      p.agents.codex,
      "# Codex — Database Migrations Specialist\nRole: do schema work only.\n",
    );
    const codexPrompt = await buildBootstrapPrompt("CODEX", root);
    expect(codexPrompt).toMatch(/Database Migrations Specialist/);
    expect(codexPrompt).toMatch(/schema work only/);
    // The other agents are NOT affected by codex's role file change
    const claudePrompt = await buildBootstrapPrompt("CLAUDE", root);
    expect(claudePrompt).not.toMatch(/Database Migrations Specialist/);
  });

  it("Claude gets the orchestrator addendum (user-facing translator instructions)", async () => {
    const claudePrompt = await buildBootstrapPrompt("CLAUDE", root);
    expect(claudePrompt).toMatch(/You are the user's point of contact/);
    expect(claudePrompt).toMatch(/translate their intent/i);
    expect(claudePrompt).toMatch(/NEXT_AGENT: CODEX/);
    expect(claudePrompt).toMatch(/Do NOT ask the user to "edit board.md"/);
  });

  it("Codex gets the worker addendum, NOT the orchestrator addendum", async () => {
    const codexPrompt = await buildBootstrapPrompt("CODEX", root);
    expect(codexPrompt).toMatch(/silent worker agent/);
    expect(codexPrompt).toMatch(/Wait quietly/);
    // Negative: must NOT contain Claude-specific instructions
    expect(codexPrompt).not.toMatch(/You are the user's point of contact/);
  });

  it("Gemini also gets the worker addendum", async () => {
    const geminiPrompt = await buildBootstrapPrompt("GEMINI", root);
    expect(geminiPrompt).toMatch(/silent worker agent/);
    expect(geminiPrompt).not.toMatch(/You are the user's point of contact/);
  });

  it("includes live memory.md and board.md content (not stale)", async () => {
    const p = paths(root);
    writeFileSync(p.memory, "# Active Memory\n- We discovered the bug is in zip.ts:42\n");
    const prompt = await buildBootstrapPrompt("CLAUDE", root);
    expect(prompt).toMatch(/zip\.ts:42/);
  });

  it("falls back to a default role when the role file is missing or empty", async () => {
    const p = paths(root);
    writeFileSync(p.agents.gemini, "");
    const geminiPrompt = await buildBootstrapPrompt("GEMINI", root);
    // Default fallback is "Gemini — UX / UI / architecture"
    expect(geminiPrompt).toMatch(/Gemini — UX/);
  });

  it("does not crash when protocol.md / memory.md / board.md are missing", async () => {
    // Wipe the .orchestra/ files (simulating a partial workspace) by
    // creating a bare-bones root that workspace.paths() points at.
    const bare = mkdtempSync(join(tmpdir(), "orc-bare-"));
    try {
      // Don't init — paths() is fine even with no files on disk; readOrEmpty
      // returns "" for any missing file.
      const prompt = await buildBootstrapPrompt("CLAUDE", bare);
      // Still produces SOMETHING usable, even if mostly placeholders
      expect(prompt.length).toBeGreaterThan(200);
      expect(prompt).toMatch(/AI Orchestra bootstrap — CLAUDE/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("starts with a clear identity header naming the agent", async () => {
    expect(await buildBootstrapPrompt("CLAUDE", root)).toMatch(
      /^# AI Orchestra bootstrap — CLAUDE/,
    );
    expect(await buildBootstrapPrompt("CODEX", root)).toMatch(
      /^# AI Orchestra bootstrap — CODEX/,
    );
    expect(await buildBootstrapPrompt("GEMINI", root)).toMatch(
      /^# AI Orchestra bootstrap — GEMINI/,
    );
  });
});

describe("prepareBootstrap", () => {
  it("writes the full prompt to .orchestra/sessions/<agent>-bootstrap.md and returns a short directive", async () => {
    const r = await prepareBootstrap("CLAUDE", root);
    // The file exists at the expected path:
    expect(existsSync(r.file)).toBe(true);
    expect(r.file.endsWith("/sessions/claude-bootstrap.md")).toBe(true);
    expect(r.relativePath).toBe(".orchestra/sessions/claude-bootstrap.md");
    // The on-disk content matches what buildBootstrapPrompt produced:
    expect(readFileSync(r.file, "utf8")).toBe(r.fullText + "\n");
    // The short prompt is small (kilobytes-not-tens-of) and references the file:
    expect(r.shortPrompt.length).toBeLessThan(1000);
    expect(r.shortPrompt).toMatch(/Read `\.orchestra\/sessions\/claude-bootstrap\.md`/);
  });

  it("writes a separate file per agent", async () => {
    const claude = await prepareBootstrap("CLAUDE", root);
    const codex = await prepareBootstrap("CODEX", root);
    const gemini = await prepareBootstrap("GEMINI", root);
    expect(claude.file).not.toBe(codex.file);
    expect(codex.file).not.toBe(gemini.file);
    // Each file's content names the right agent in its header:
    expect(readFileSync(claude.file, "utf8")).toMatch(/AI Orchestra bootstrap — CLAUDE/);
    expect(readFileSync(codex.file, "utf8")).toMatch(/AI Orchestra bootstrap — CODEX/);
    expect(readFileSync(gemini.file, "utf8")).toMatch(/AI Orchestra bootstrap — GEMINI/);
  });

  it("overwrites the file on a second call (state refresh)", async () => {
    const first = await prepareBootstrap("CODEX", root);
    const lenFirst = first.fullText.length;
    // Mutate memory.md so the bootstrap content changes:
    writeFileSync(paths(root).memory, "# Active Memory\n\n- new fact since last bootstrap\n");
    const second = await prepareBootstrap("CODEX", root);
    expect(second.fullText.length).not.toBe(lenFirst);
    expect(readFileSync(second.file, "utf8")).toMatch(/new fact since last bootstrap/);
  });
});
