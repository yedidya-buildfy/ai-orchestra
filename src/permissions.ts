import picomatch from "picomatch";
import { relative, isAbsolute, resolve } from "node:path";
import type { AgentName, AgentPermission, Permissions } from "./types.js";

export class PermissionDeniedError extends Error {
  constructor(agent: AgentName, action: "READ" | "WRITE", path: string, reason: string) {
    super(`${agent} ${action} denied for ${path}: ${reason}`);
    this.name = "PermissionDeniedError";
  }
}

export interface PermissionLookup {
  /** Permission for a non-orchestrator agent. */
  forAgent(agent: AgentName): AgentPermission;
}

/**
 * Build a lookup. CLAUDE always has WRITE everywhere (orchestrator);
 * CODEX/GEMINI use what's in board.permissions.
 */
export function buildPermissionLookup(perms: Permissions): PermissionLookup {
  return {
    forAgent(agent) {
      if (agent === "CLAUDE") return { mode: "WRITE", scope: ["**"] };
      return perms[agent];
    },
  };
}

/**
 * Decide whether `agent` may write to `targetPath`, given a workspace `root`.
 * Empty scope = nothing matches (deny). Glob "**" matches everything.
 */
export function canWrite(
  perms: Permissions,
  agent: AgentName,
  targetPath: string,
  root: string,
): { allowed: boolean; reason: string } {
  const lookup = buildPermissionLookup(perms);
  const p = lookup.forAgent(agent);
  if (p.mode !== "WRITE") {
    return { allowed: false, reason: `agent has READ-only permission` };
  }
  if (p.scope.length === 0) {
    return { allowed: false, reason: `agent has empty scope` };
  }
  const rel = toRelative(targetPath, root);
  for (const pattern of p.scope) {
    if (picomatch.isMatch(rel, pattern, { dot: true })) {
      return { allowed: true, reason: `matched ${pattern}` };
    }
  }
  return { allowed: false, reason: `no scope pattern matched ${rel}` };
}

export function assertCanWrite(
  perms: Permissions,
  agent: AgentName,
  targetPath: string,
  root: string,
): void {
  const r = canWrite(perms, agent, targetPath, root);
  if (!r.allowed) {
    throw new PermissionDeniedError(agent, "WRITE", targetPath, r.reason);
  }
}

function toRelative(target: string, root: string): string {
  const abs = isAbsolute(target) ? target : resolve(root, target);
  const r = relative(resolve(root), abs);
  // picomatch expects forward slashes
  return r.split(/[\\/]/).filter(Boolean).join("/");
}
