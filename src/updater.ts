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

export async function updateOne(
  agent: AgentName,
  command: string = DEFAULT_UPDATE_CMDS[agent],
): Promise<UpdateResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(command, {
      shell: "/bin/sh",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("close", (code) =>
      resolve({
        agent,
        command,
        ok: code === 0,
        stdoutTail: tailLines(stdout),
        stderrTail: tailLines(stderr),
        durationMs: Date.now() - start,
      }),
    );
    child.on("error", (e) =>
      resolve({
        agent,
        command,
        ok: false,
        stdoutTail: "",
        stderrTail: e.message,
        durationMs: Date.now() - start,
      }),
    );
  });
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
