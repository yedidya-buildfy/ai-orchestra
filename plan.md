# Plan: AI Orchestra — Build Roadmap

Companion to `prd.md`. Work is broken into **7 chunkable missions**. Each mission is large enough to be meaningful (a few days of focused work) but self-contained: it ships a working slice, has clear inputs/outputs, and can be verified before moving on. Missions are sequential — later ones depend on earlier ones — but within a mission tasks can be parallelized.

Stack assumption: **Node.js + TypeScript** for the watcher / CLI / context engine, **tmux** for agent sessions, **Markdown files** for state. Production-level from day one (no mocks, no placeholders, real tokenizers, real tmux).

---

## Mission 1 — Foundations & Markdown Memory Layer

**Goal:** A working `.orchestra/` directory with all canonical files, a typed schema for `board.md`, and a robust read/write layer. No agents yet — just the brain on disk.

**Scope**
- npm package skeleton (`ai-orchestra`): TS, ESM, strict mode, vitest, eslint, prettier, tsup build.
- `init` CLI command: scaffolds `.orchestra/` with `board.md`, `memory.md`, `changelog.md`, `long_term.md`, `protocol.md`, `agents/{claude,codex,gemini}.md`, `sessions/`, `metrics/context.json`.
- Markdown parser/serializer for `board.md` sections (`Control`, `Permissions`, `Context Health`, `Objective`, per-agent blocks, `Decisions`, `Changelog`).
- File-size guards per §16: warn at threshold, block writes that would exceed hard caps.
- Atomic file writes (write-temp + rename) so the watcher never reads a half-written board.
- Append-only enforcement for `changelog.md`.

**Deliverables**
- `npx ai-orchestra init` produces a valid workspace.
- `BoardFile` / `MemoryFile` typed read/write API with round-trip tests on real fixtures.
- Lint rule: any code touching `.orchestra/` goes through the API, never raw `fs`.

**Done when:** scaffolding + parse/serialize round-trips a hand-written `board.md` with zero diff, and concurrent writes never corrupt files.

---

## Mission 2 — Context Engine (Token Measurement & Thresholds)

**Goal:** Reliable per-agent context-usage numbers driven by real tokenizers, surfaced into `metrics/context.json` and the `Context Health` block in `board.md`.

**Scope**
- Tokenizer adapters:
  - Claude: `@anthropic-ai/tokenizer` (or current official tokenizer).
  - Codex / GPT-family: `tiktoken` (`o200k_base`).
  - Gemini: official count-tokens approach; fall back to a calibrated char/token ratio when offline.
- Layered measurement per §8:
  1. Runtime source (Claude statusline / Codex usage block) when available.
  2. Estimation = tokens(board) + tokens(memory) + tokens(recent log window).
  3. Apply `× 1.2` safety buffer.
- Context windows table per §9, thresholds per §10 (`OK / WARNING / SUMMARIZE / REFRESH / FORCE_RESET`).
- Writer that updates `Context Health` in `board.md` and `metrics/context.json` atomically.
- CLI: `ai-orchestra context` prints a table of all agents with %, threshold band, and source (runtime vs estimate).

**Done when:** feeding a fixture board + memory yields stable, repeatable percentages across all three tokenizers, and threshold transitions fire deterministically in tests.

---

## Mission 3 — tmux Session Layer & Agent Adapters

**Goal:** Persistent, controllable Claude / Codex / Gemini sessions over tmux, with a uniform adapter interface.

**Scope**
- `TmuxSession` wrapper: `start`, `stop`, `restart`, `send(text)`, `capture(lines)`, `isAlive`.
- Per-agent adapter (`ClaudeAdapter`, `CodexAdapter`, `GeminiAdapter`) implementing a shared `AgentAdapter` interface: `spawn()`, `injectContext(files)`, `prompt(text)`, `readUsage()`.
- Session metadata persisted in `.orchestra/sessions/<agent>.json` (pid, tmux name, start time, last prompt, last usage snapshot).
- Output capture pipeline: tail tmux pane → ring buffer file → consumed by the context engine for Layer-1/2 measurement.
- Health checks + auto-recovery if a session dies unexpectedly (distinct from intentional refresh).

**Done when:** `ai-orchestra agent start <name>` brings up a real CLI in tmux, `prompt` round-trips text, and killing the underlying process is detected and surfaced.

---

## Mission 4 — Watcher & Orchestration Loop

**Goal:** The nervous system. A long-running watcher that reads `board.md`, dispatches the next agent, enforces permissions, and updates metrics.

**Scope**
- File watcher on `.orchestra/` (chokidar, debounced) — reacts to `board.md` changes only after the atomic write completes.
- Orchestration tick:
  1. Parse board.
  2. Read `NEXT_AGENT` + `STATUS`.
  3. Validate permissions (`READ`/`WRITE` + `scope` globs per §7).
  4. Recompute context health (calls Mission 2).
  5. Decide: dispatch / refresh / wait.
  6. Send prompt to the target agent via Mission 3 adapter.
  7. Append a structured entry to `changelog.md`.
- Permission enforcement: scoped path matcher; advisory-only mode rejects file edits at the adapter layer.
- Single-writer rule per §23: a lockfile guarantees only the active agent has write rights at any moment.
- CLI: `ai-orchestra watch` (foreground) and `ai-orchestra daemon` (detached, with logs in `.orchestra/logs/`).

**Done when:** flipping `NEXT_AGENT` in `board.md` deterministically wakes the right agent, permissions are enforced, and every tick produces an auditable changelog line.

---

## Mission 5 — Refresh System (the survival mechanism)

**Goal:** Implement the core insight of the PRD — safe context resets without losing work.

**Scope**
- Refresh triggers per §11/§13: threshold-based (auto), agent-requested (`REFRESH_REQUESTED: TRUE`), orchestrator-decided (loop/confusion heuristics, large-task completion).
- Claude refresh flow per §12: kill tmux session → spawn fresh → rehydrate with `protocol.md + memory.md + board.md + current objective`. Same flow generalized for Codex.
- Pre-refresh snapshot: dump current agent's working notes into `memory.md` (compressed) and `changelog.md` (full) before kill.
- Post-refresh verification: confirm the new session acknowledges the objective before marking refresh complete.
- Memory compression per §15: when `memory.md` crosses the word threshold, summarize older entries into `long_term.md` (using the active orchestrator agent itself — production, not mock).
- Loading strategy per §17 enforced at rehydrate time: never inject `changelog.md` or `long_term.md` wholesale.

**Done when:** an agent at 95% context is auto-refreshed end-to-end; after refresh it resumes the same task with no human intervention; no entry in `memory.md` is ever lost across a refresh.

---

## Mission 6 — Execution Modes & End-to-End Flows

**Goal:** Wire everything into the two execution modes from §18 and prove a real task runs through the system.

**Scope**
- **Complex mode:** Claude plans → Codex reviews → Gemini reviews → Claude merges. Implemented as a state machine over `PHASE` in board.md (`PLAN → REVIEW_CODEX → REVIEW_GEMINI → MERGE → DONE`).
- **Simple mode:** Claude assigns → Codex/Gemini execute directly → Claude confirms.
- Decision log: every phase transition writes a `Decisions` entry with the reasoning agent, inputs hash, and outcome.
- Conflict handling: if Codex and Gemini disagree in REVIEW phases, Claude resolves and the disagreement is preserved in `Decisions`.
- Real end-to-end demo task: "fix a ZIP validation bug" (the PRD's own example) running against a sample repo, with all three real CLIs, no mocks.

**Done when:** the demo task completes through complex mode unattended, decisions are auditable, and re-running it from a fresh `.orchestra/` reproduces a clean changelog.

---

## Mission 7 — Hardening, CLI Polish & Release

**Goal:** Make it a tool other people can install and trust.

**Scope**
- Safety rules per §23 audited end-to-end: single-writer lock, permission enforcement, refresh-never-deletes-memory invariant, every action logged.
- Crash recovery: watcher restart replays the last consistent state from `changelog.md`.
- Observability: `ai-orchestra status` (board snapshot + context table + session health), `ai-orchestra logs <agent>`, `ai-orchestra doctor` (sanity checks: tmux present, CLIs on PATH, tokenizers loadable, file perms).
- Configuration: `.orchestra/config.json` for context windows, thresholds, file caps, agent commands — all overridable, all validated on load.
- Docs: README with quickstart, architecture diagram mirroring §3, troubleshooting, and a "production deployment" section (systemd unit / launchd plist for the daemon, log rotation, backup of `.orchestra/`).
- Pre-publish: semver, changelog, GitHub Actions CI (lint + test + build), npm publish dry-run.

**Done when:** a fresh machine can `npm i -g ai-orchestra && ai-orchestra init && ai-orchestra daemon` and run the Mission 6 demo without manual fixes.

---

## Out of Scope (per PRD §25)

- UI dashboard
- Parallel agents (multiple Codex/Gemini at once)
- Advanced permissions (per-tool, per-time-window, etc.)

These are explicitly deferred. Don't pre-build hooks for them — add when needed.

---

## Mission Dependency Graph

```
M1 ─┬─> M2 ─┐
    └─> M3 ─┼─> M4 ─> M5 ─> M6 ─> M7
```

M2 and M3 are independent after M1 and can be built in parallel.
