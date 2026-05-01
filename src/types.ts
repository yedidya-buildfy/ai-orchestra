export type AgentName = "CLAUDE" | "CODEX" | "GEMINI";

export type Phase =
  | "IDLE"
  | "PLAN"
  | "IMPLEMENT"
  | "REVIEW_CODEX"
  | "REVIEW_GEMINI"
  | "MERGE"
  | "DONE";

export type TaskType = "NONE" | "FIX" | "FEATURE" | "REFACTOR" | "REVIEW" | "RESEARCH";

export type Status = "IDLE" | "ACTIVE" | "WAITING" | "BLOCKED" | "DONE";

export type PermissionMode = "READ" | "WRITE";

export interface AgentPermission {
  mode: PermissionMode;
  scope: string[];
}

export interface ControlBlock {
  TASK_ID: string;
  PHASE: Phase;
  TASK_TYPE: TaskType;
  NEXT_AGENT: AgentName;
  STATUS: Status;
}

export interface Permissions {
  CODEX: AgentPermission;
  GEMINI: AgentPermission;
}

export interface ContextHealth {
  CLAUDE: number; // 0..1
  CODEX: number;
  GEMINI: number;
}

export interface Board {
  control: ControlBlock;
  permissions: Permissions;
  contextHealth: ContextHealth;
  objective: string;
  claude: string;
  codex: string;
  gemini: string;
  decisions: string;
  changelog: string;
}

export const FILE_LIMITS = {
  "board.md": { warnWords: 3500, hardWords: 4000 },
  "memory.md": { warnWords: 5500, hardWords: 6000 },
} as const;

export type GuardedFile = keyof typeof FILE_LIMITS;
