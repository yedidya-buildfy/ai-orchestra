import { spawn } from "node:child_process";

/**
 * The "view" is a separate tmux session that simply attaches to each agent's
 * underlying tmux session as panes arranged side-by-side. The agents
 * themselves run in their own sessions (claude / codex / gemini) — the view
 * is purely a display layer. Detaching from the view leaves all three agent
 * sessions running.
 */
export const VIEW_SESSION = "orchestra-view";

interface TmuxResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runTmux(args: string[]): Promise<TmuxResult> {
  return new Promise((resolve) => {
    const c = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    c.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    c.on("close", (code) =>
      resolve({ ok: code === 0, stdout, stderr: stderr.trim() }),
    );
    c.on("error", () => resolve({ ok: false, stdout: "", stderr: "spawn failed" }));
  });
}

export async function viewExists(): Promise<boolean> {
  return (await runTmux(["has-session", "-t", VIEW_SESSION])).ok;
}

export interface CreateViewOptions {
  claudeSession: string;
  codexSession: string;
  geminiSession: string;
  /** ms before auto-shrinking codex/gemini panes. 0 disables. */
  autoShrinkMs?: number;
  /** percentage width to give the claude pane after shrink (0-100). */
  claudeWidthPct?: number;
}

export interface CreateViewResult {
  viewSession: string;
  notes: string[];
}

/**
 * Build the side-by-side view session. Pane layout:
 *   [ claude (left, large) | codex (middle, narrow) | gemini (right, narrow) ]
 *
 * Each pane runs `unset TMUX; tmux attach-session -t <agent>` so the user
 * sees the agent's live UI.
 */
export async function createView(opts: CreateViewOptions): Promise<CreateViewResult> {
  const notes: string[] = [];
  const { claudeSession, codexSession, geminiSession } = opts;
  const autoShrinkMs = opts.autoShrinkMs ?? 10_000;
  const claudeWidth = Math.max(20, Math.min(95, opts.claudeWidthPct ?? 70));

  // Tear down any pre-existing view.
  await runTmux(["kill-session", "-t", VIEW_SESSION]);

  // Create the view, pane 0 = claude.
  let r = await runTmux([
    "new-session",
    "-d",
    "-s",
    VIEW_SESSION,
    "sh",
    "-c",
    `unset TMUX; exec tmux attach-session -t ${claudeSession}`,
  ]);
  if (!r.ok) throw new Error(`failed to create view: ${r.stderr}`);

  // Split right -> pane 1 = codex.
  r = await runTmux([
    "split-window",
    "-h",
    "-t",
    `${VIEW_SESSION}:0`,
    "sh",
    "-c",
    `unset TMUX; exec tmux attach-session -t ${codexSession}`,
  ]);
  if (!r.ok) throw new Error(`failed to split for codex: ${r.stderr}`);

  // Split right of pane 1 -> pane 2 = gemini.
  r = await runTmux([
    "split-window",
    "-h",
    "-t",
    `${VIEW_SESSION}:0.1`,
    "sh",
    "-c",
    `unset TMUX; exec tmux attach-session -t ${geminiSession}`,
  ]);
  if (!r.ok) throw new Error(`failed to split for gemini: ${r.stderr}`);

  // Equal split first.
  await runTmux(["select-layout", "-t", VIEW_SESSION, "even-horizontal"]);
  await runTmux(["select-pane", "-t", `${VIEW_SESSION}:0.0`]);
  notes.push("3 panes created (claude | codex | gemini), equal split");

  // Schedule the auto-shrink in a detached background shell so the
  // resize fires after the user has had a chance to glance at all three.
  if (autoShrinkMs > 0) {
    const seconds = Math.ceil(autoShrinkMs / 1000);
    const cmd =
      `( sleep ${seconds} && ` +
      `tmux resize-pane -t ${VIEW_SESSION}:0.0 -x ${claudeWidth}% ) ` +
      `>/dev/null 2>&1 &`;
    const child = spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    child.unref();
    notes.push(`scheduled auto-shrink: claude → ${claudeWidth}% in ${seconds}s`);
  }

  return { viewSession: VIEW_SESSION, notes };
}

/**
 * Toggle visibility of the codex+gemini side panes by zooming the claude pane
 * (tmux's `resize-pane -Z` toggles full-pane zoom). Calling this when zoomed
 * restores the previous layout; calling when not zoomed makes claude full
 * size and hides the others. Same op = `hide` / `show`.
 */
export async function toggleSidekicks(): Promise<{ toggled: boolean; reason: string }> {
  if (!(await viewExists())) {
    return { toggled: false, reason: `view session "${VIEW_SESSION}" not running` };
  }
  await runTmux(["select-pane", "-t", `${VIEW_SESSION}:0.0`]);
  const r = await runTmux(["resize-pane", "-Z", "-t", `${VIEW_SESSION}:0.0`]);
  return { toggled: r.ok, reason: r.ok ? "toggled" : r.stderr };
}

/** Resize claude pane to N% of total view width (default 70). */
export async function resizeClaude(pct = 70): Promise<{ ok: boolean; reason: string }> {
  if (!(await viewExists())) {
    return { ok: false, reason: `view session "${VIEW_SESSION}" not running` };
  }
  const r = await runTmux([
    "resize-pane",
    "-t",
    `${VIEW_SESSION}:0.0`,
    "-x",
    `${pct}%`,
  ]);
  return { ok: r.ok, reason: r.ok ? `claude pane → ${pct}%` : r.stderr };
}

/** Kill the view session (agents themselves are unaffected). */
export async function killView(): Promise<void> {
  await runTmux(["kill-session", "-t", VIEW_SESSION]);
}
