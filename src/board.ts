import type {
  AgentName,
  AgentPermission,
  Board,
  ContextHealth,
  ControlBlock,
  PermissionMode,
  Permissions,
  Phase,
  Status,
  TaskType,
} from "./types.js";

export class BoardParseError extends Error {
  constructor(msg: string) {
    super(`board.md parse error: ${msg}`);
    this.name = "BoardParseError";
  }
}

const SECTION_ORDER = [
  "Control",
  "Permissions",
  "Context Health",
  "Objective",
  "Claude",
  "Codex",
  "Gemini",
  "Decisions",
  "Changelog",
] as const;

type SectionName = (typeof SECTION_ORDER)[number];

function splitSections(text: string): Map<SectionName, string> {
  const lines = text.split("\n");
  const sections = new Map<SectionName, string>();
  let current: SectionName | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (current !== null) {
      sections.set(current, buf.join("\n"));
    }
  };

  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      const name = m[1] as SectionName;
      if (!SECTION_ORDER.includes(name)) {
        // unknown section — ignore but track to avoid throwing on benign extras
        current = null;
        buf = [];
        continue;
      }
      current = name;
      buf = [];
    } else if (current !== null) {
      buf.push(line);
    }
  }
  flush();

  for (const required of SECTION_ORDER) {
    if (!sections.has(required)) {
      throw new BoardParseError(`missing section: ## ${required}`);
    }
  }
  return sections;
}

function parseControl(body: string): ControlBlock {
  const out: Partial<Record<keyof ControlBlock, string>> = {};
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([A-Z_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1] as keyof ControlBlock] = m[2] ?? "";
  }
  const required: (keyof ControlBlock)[] = [
    "TASK_ID",
    "PHASE",
    "TASK_TYPE",
    "NEXT_AGENT",
    "STATUS",
  ];
  for (const k of required) {
    if (out[k] === undefined) throw new BoardParseError(`Control: missing ${k}`);
  }
  return {
    TASK_ID: out.TASK_ID!,
    PHASE: out.PHASE as Phase,
    TASK_TYPE: out.TASK_TYPE as TaskType,
    NEXT_AGENT: out.NEXT_AGENT as AgentName,
    STATUS: out.STATUS as Status,
  };
}

function parseScopeArray(s: string): string[] {
  const t = s.trim();
  if (t === "[]" || t === "") return [];
  if (!t.startsWith("[") || !t.endsWith("]")) {
    throw new BoardParseError(`scope must be a JSON array, got: ${s}`);
  }
  // Parse as JSON; PRD uses double-quoted strings.
  try {
    const arr = JSON.parse(t);
    if (!Array.isArray(arr) || !arr.every((x) => typeof x === "string")) {
      throw new Error("not a string array");
    }
    return arr;
  } catch (e) {
    throw new BoardParseError(`scope JSON parse failed: ${(e as Error).message}`);
  }
}

function parsePermissions(body: string): Permissions {
  const lines = body.split("\n");
  const perms: Partial<Record<"CODEX" | "GEMINI", Partial<AgentPermission>>> = {};
  let current: "CODEX" | "GEMINI" | null = null;
  for (const raw of lines) {
    const line = raw;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const head = /^(CODEX|GEMINI):\s*$/.exec(trimmed);
    if (head) {
      current = head[1] as "CODEX" | "GEMINI";
      perms[current] = {};
      continue;
    }
    if (!current) continue;
    const kv = /^(mode|scope):\s*(.*)$/.exec(trimmed);
    if (!kv) continue;
    const key = kv[1]!;
    const val = kv[2] ?? "";
    if (key === "mode") {
      if (val !== "READ" && val !== "WRITE") {
        throw new BoardParseError(`Permissions.${current}.mode invalid: ${val}`);
      }
      perms[current]!.mode = val as PermissionMode;
    } else {
      perms[current]!.scope = parseScopeArray(val);
    }
  }
  for (const a of ["CODEX", "GEMINI"] as const) {
    const p = perms[a];
    if (!p || !p.mode || !p.scope) {
      throw new BoardParseError(`Permissions.${a} incomplete`);
    }
  }
  return {
    CODEX: perms.CODEX as AgentPermission,
    GEMINI: perms.GEMINI as AgentPermission,
  };
}

function parseContextHealth(body: string): ContextHealth {
  const out: Partial<Record<AgentName, number>> = {};
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(CLAUDE|CODEX|GEMINI):\s*(\d+(?:\.\d+)?)%$/.exec(line);
    if (!m) continue;
    out[m[1] as AgentName] = Number(m[2]) / 100;
  }
  for (const a of ["CLAUDE", "CODEX", "GEMINI"] as const) {
    if (out[a] === undefined) throw new BoardParseError(`ContextHealth.${a} missing`);
  }
  return out as ContextHealth;
}

function trimSectionBody(body: string): string {
  // Strip a single leading and a single trailing blank line introduced by `## Heading\n`
  // and the newline before the next heading. This preserves internal blank lines.
  let s = body;
  if (s.startsWith("\n")) s = s.slice(1);
  if (s.endsWith("\n")) s = s.slice(0, -1);
  return s;
}

export function parseBoard(text: string): Board {
  const sections = splitSections(text);
  return {
    control: parseControl(sections.get("Control")!),
    permissions: parsePermissions(sections.get("Permissions")!),
    contextHealth: parseContextHealth(sections.get("Context Health")!),
    objective: trimSectionBody(sections.get("Objective")!),
    claude: trimSectionBody(sections.get("Claude")!),
    codex: trimSectionBody(sections.get("Codex")!),
    gemini: trimSectionBody(sections.get("Gemini")!),
    decisions: trimSectionBody(sections.get("Decisions")!),
    changelog: trimSectionBody(sections.get("Changelog")!),
  };
}

function fmtPct(n: number): string {
  // Stable percent formatting:
  //   - integer if exactly whole (e.g. 78%)
  //   - 1 decimal for >=1% non-integer (e.g. 78.5%)
  //   - up to 4 decimals (trailing zeros trimmed) for sub-1% so a 1M-token
  //     window can still meaningfully report 0.012% rather than rounding to 0%
  const pct = n * 100;
  if (pct === 0) return "0%";
  if (pct >= 1) {
    if (Math.abs(pct - Math.round(pct)) < 1e-9) return `${Math.round(pct)}%`;
    return `${pct.toFixed(1)}%`;
  }
  let s = pct.toFixed(4);
  s = s.replace(/0+$/, "");
  if (s.endsWith(".")) s += "0";
  return `${s}%`;
}

function serializePermission(name: "CODEX" | "GEMINI", p: AgentPermission): string {
  const scope = JSON.stringify(p.scope);
  return `${name}:\n  mode: ${p.mode}\n  scope: ${scope}`;
}

export function serializeBoard(b: Board): string {
  const out: string[] = [];

  out.push("## Control");
  out.push(`TASK_ID: ${b.control.TASK_ID}`);
  out.push(`PHASE: ${b.control.PHASE}`);
  out.push(`TASK_TYPE: ${b.control.TASK_TYPE}`);
  out.push(`NEXT_AGENT: ${b.control.NEXT_AGENT}`);
  out.push(`STATUS: ${b.control.STATUS}`);
  out.push("");

  out.push("## Permissions");
  out.push(serializePermission("CODEX", b.permissions.CODEX));
  out.push("");
  out.push(serializePermission("GEMINI", b.permissions.GEMINI));
  out.push("");

  out.push("## Context Health");
  out.push(`CLAUDE: ${fmtPct(b.contextHealth.CLAUDE)}`);
  out.push(`CODEX: ${fmtPct(b.contextHealth.CODEX)}`);
  out.push(`GEMINI: ${fmtPct(b.contextHealth.GEMINI)}`);
  out.push("");

  const freeForm: [string, string][] = [
    ["Objective", b.objective],
    ["Claude", b.claude],
    ["Codex", b.codex],
    ["Gemini", b.gemini],
    ["Decisions", b.decisions],
    ["Changelog", b.changelog],
  ];
  for (const [name, body] of freeForm) {
    out.push(`## ${name}`);
    out.push(body);
    out.push("");
  }

  // join with newlines and ensure exactly one trailing newline
  return out.join("\n").replace(/\n+$/, "\n");
}

export function defaultBoard(): Board {
  return {
    control: {
      TASK_ID: "000",
      PHASE: "IDLE",
      TASK_TYPE: "NONE",
      NEXT_AGENT: "CLAUDE",
      STATUS: "IDLE",
    },
    permissions: {
      CODEX: { mode: "READ", scope: [] },
      GEMINI: { mode: "READ", scope: [] },
    },
    contextHealth: { CLAUDE: 0, CODEX: 0, GEMINI: 0 },
    objective: "(no objective set)",
    claude: "(empty)",
    codex: "(empty)",
    gemini: "(empty)",
    decisions: "(empty)",
    changelog: "(empty)",
  };
}
