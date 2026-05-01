import { spawn } from "node:child_process";
import type { AgentName } from "./types.js";

/**
 * Default npm-based update commands per agent CLI. Override per-project via
 * `.orchestra/config.json -> agents.<NAME>.updateCmd` (future).
 */
export const DEFAULT_UPDATE_CMDS: Record<AgentName, string> = {
  CLAUDE: "npm install -g @anthropic-ai/claude-code",
  CODEX: "npm install -g @openai/codex",
  GEMINI: "npm install -g @google/gemini-cli",
};

export interface UpdateResult {
  agent: AgentName;
  command: string;
  ok: boolean;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
}

function tailLines(s: string, n = 10): string {
  return s.split("\n").slice(-n).join("\n").trim();
}

function runShell(command: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: "/bin/sh", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
    child.on("error", (e) => resolve({ ok: false, stdout: "", stderr: e.message }));
  });
}

/** Add `--force` to an `npm install -g` command (idempotent). */
function withForce(command: string): string {
  if (/--force\b/.test(command)) return command;
  if (/\bnpm\s+(install|i)\b.*\s-g\b/.test(command)) {
    return command.replace(/\bnpm\s+(install|i)\b/, "npm $1 --force");
  }
  return command;
}

export async function updateOne(
  agent: AgentName,
  command: string = DEFAULT_UPDATE_CMDS[agent],
): Promise<UpdateResult> {
  const start = Date.now();
  let r = await runShell(command);

  // If npm refuses because a symlink/binary is squatting the path, transparently
  // retry once with --force. EEXIST on a global bin is the canonical case where
  // a user originally installed the tool via brew/another npm package — and
  // they explicitly asked us to update it, so overwriting is the intent.
  if (!r.ok && /EEXIST|already exists/i.test(r.stderr)) {
    const forced = withForce(command);
    if (forced !== command) {
      const r2 = await runShell(forced);
      r = {
        ok: r2.ok,
        stdout: r2.stdout || r.stdout,
        stderr: r2.ok ? `(retried with --force)\n${r2.stderr}` : `${r.stderr}\n--retry-with-force--\n${r2.stderr}`,
      };
    }
  }

  return {
    agent,
    command,
    ok: r.ok,
    stdoutTail: tailLines(r.stdout),
    stderrTail: tailLines(r.stderr),
    durationMs: Date.now() - start,
  };
}

export async function updateAll(
  selected: AgentName[] = ["CLAUDE", "CODEX", "GEMINI"],
  overrides: Partial<Record<AgentName, string>> = {},
): Promise<UpdateResult[]> {
  const out: UpdateResult[] = [];
  for (const a of selected) {
    out.push(await updateOne(a, overrides[a] ?? DEFAULT_UPDATE_CMDS[a]));
  }
  return out;
}
