import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { AgentName } from "./types.js";
import { paths } from "./workspace.js";

/**
 * Build the "everything an agent needs to know" prompt — the single message
 * sent to a tmux session whenever it starts (initial `orc init`, named
 * `orc resume`, or refresh after a token-band crossing). Loads the live
 * `.orchestra/` files so the agent always wakes up to current state, never
 * a stale snapshot:
 *   - `.orchestra/agents/<agent>.md`  — that agent's role definition
 *   - `.orchestra/protocol.md`        — system-wide rules
 *   - `.orchestra/memory.md`          — active shared memory
 *   - `.orchestra/board.md`           — control state, decisions, per-agent blocks
 *
 * Each agent gets a different *addendum* on top of the shared body. The most
 * load-bearing addendum is Claude's: it teaches the model that it is the
 * user's only point of contact and must translate plain-language requests
 * into board.md updates rather than asking the user to edit files manually.
 */

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return "";
  }
}

function defaultRole(agent: AgentName): string {
  switch (agent) {
    case "CLAUDE":
      return "# Claude — Orchestrator\nRole: plan, decide, merge, assign tasks. Full permissions.";
    case "CODEX":
      return "# Codex — Technical execution & review\nRole: implement, review, fix bugs.";
    case "GEMINI":
      return "# Gemini — UX / UI / architecture\nRole: review and shape UX/UI/architecture.";
  }
}

async function loadRole(root: string, agent: AgentName): Promise<string> {
  const p = paths(root);
  const key = agent.toLowerCase() as keyof typeof p.agents;
  const text = await readOrEmpty(p.agents[key]);
  return text.trim().length > 0 ? text.trimEnd() : defaultRole(agent);
}

/**
 * Claude is the ONLY agent the user talks to. This addendum teaches it the
 * conversational-orchestrator pattern: translate user intent into board.md
 * updates, summarize agent output back to plain language, never expose the
 * file plumbing to the user.
 */
const CLAUDE_ORCHESTRATOR_ADDENDUM = `
# You are the user's point of contact

The user talks to you in plain language. They do NOT know about \`.orchestra/\`,
\`board.md\`, phases, or NEXT_AGENT. They should never have to. Your job is to
translate their intent into orchestra actions and translate orchestra output
back into plain language.

## When the user asks you to do something

1. Decide whether the request is:
   (a) something you should do yourself (planning, explanation, light work
       that doesn't need code-execution or UX review)
   (b) something to delegate to **Codex** (write/fix code, run tests,
       refactor, anything where Codex's "implement & review" role fits)
   (c) something to delegate to **Gemini** (UX review, UI structure,
       architecture sanity checks, design decisions)
   (d) ambiguous → ask one short clarifying question

2. If you delegate, do it by editing \`.orchestra/board.md\` directly:
   - Set \`PHASE: PLAN\`, \`STATUS: ACTIVE\`, \`NEXT_AGENT: CODEX\` (or \`GEMINI\`)
   - Write the user's intent (clarified) into the **Objective** section
   - Save the file
   The watcher daemon picks up the change and forwards the dispatch prompt
   to that agent automatically. You do not have to send anything yourself.

3. Tell the user in ONE short sentence what you just did. Never paste the
   board.md contents at them.

4. When the delegated agent finishes (their output appears in their block in
   board.md), summarize the outcome back to the user — again, in plain
   language, not raw board contents. If they need to make a decision
   (approve/reject), present the choice plainly and wait.

## Boundaries

- Do NOT ask the user to "edit board.md" or "update memory.md". You handle
  the files; they handle the conversation.
- Do NOT show raw \`.orchestra/\` paths or filenames to the user unless they
  explicitly ask about the system internals.
- If \`.orchestra/agents/claude.md\` (your role file) describes a different
  scope than what the user is asking for, follow the role file and tell the
  user that's outside your remit.
`;

/**
 * Codex and Gemini are silent workers. They do not get user prompts; they
 * receive dispatches via board.md. This addendum sets that expectation
 * explicitly so they don't try to start a conversation with the tmux pane.
 */
const WORKER_ADDENDUM = `
# You are a silent worker agent

The user does NOT type into this pane. You receive tasks from the orchestrator
(Claude) via dispatches that arrive as full prompts including \`board.md\`,
\`memory.md\`, and \`protocol.md\` snapshots, plus an Objective.

While you are not actively dispatched:
- Do nothing. Wait quietly.
- Do not produce output, do not narrate.
- If you receive what looks like idle keypresses or accidental input, ignore
  it.

When you are dispatched (you'll see a "# Dispatch to <YOU>" header):
- Read the protocol, memory, board, and objective inside the dispatch.
- Act ONLY when \`NEXT_AGENT\` names you and \`STATUS\` is \`ACTIVE\`.
- Write your output by appending to your own per-agent block in board.md.
- Set \`STATUS: WAITING\` when done so the orchestrator can route the next
  step.
`;

export async function buildBootstrapPrompt(
  agent: AgentName,
  root: string,
): Promise<string> {
  const p = paths(root);
  const [role, protocol, memory, board] = await Promise.all([
    loadRole(root, agent),
    readOrEmpty(p.protocol),
    readOrEmpty(p.memory),
    readOrEmpty(p.board),
  ]);

  const addendum = agent === "CLAUDE" ? CLAUDE_ORCHESTRATOR_ADDENDUM : WORKER_ADDENDUM;

  return [
    `# AI Orchestra bootstrap — ${agent}`,
    "",
    "You have just (re)started inside an AI Orchestra workspace. The blocks",
    "below are your current operating context. They are loaded fresh from",
    "disk, so memory.md and board.md reflect everything that has happened up",
    "to this moment — not a snapshot from when you last ran.",
    "",
    "## Your role",
    role.trimEnd(),
    "",
    addendum.trim(),
    "",
    "## protocol.md",
    protocol.trimEnd() || "(empty)",
    "",
    "## memory.md",
    memory.trimEnd() || "(empty — no prior context yet)",
    "",
    "## board.md",
    board.trimEnd() || "(empty)",
    "",
    "Act according to your role and the protocol. If you are CLAUDE, the",
    "user may now speak to you in plain language. If you are CODEX or",
    "GEMINI, wait for a dispatch.",
  ].join("\n");
}

/**
 * Write the full bootstrap prompt to `.orchestra/sessions/<agent>-bootstrap.md`
 * and return both the absolute path and a SHORT directive prompt that asks the
 * agent to read the file. We send the short directive via `adapter.prompt()`
 * instead of pasting the full text into the tmux pane: a multi-KB blob in
 * Claude Code's TUI gets buffered as paste blocks that never auto-submit, and
 * the same blob can overflow Codex's interactive input. A 1–2 line "read this
 * file" instruction is small enough to clear both pitfalls and the agents,
 * running in YOLO mode, can read the file freely.
 */
export async function prepareBootstrap(
  agent: AgentName,
  root: string,
): Promise<{ file: string; relativePath: string; shortPrompt: string; fullText: string }> {
  const fullText = await buildBootstrapPrompt(agent, root);
  const p = paths(root);
  await fs.mkdir(p.sessionsDir, { recursive: true });
  const fname = `${agent.toLowerCase()}-bootstrap.md`;
  const file = join(p.sessionsDir, fname);
  await fs.writeFile(file, fullText + "\n", "utf8");
  const relativePath = `.orchestra/sessions/${fname}`;
  const shortPrompt =
    `[orc] Read \`${relativePath}\` now — it contains your role, the AI Orchestra protocol, ` +
    `and the current memory/board snapshot. After reading, follow its instructions. ` +
    `If you're CLAUDE, the user will speak to you next in plain language. ` +
    `If you're CODEX or GEMINI, simply acknowledge and wait quietly for a dispatch.`;
  return { file, relativePath, shortPrompt, fullText };
}
