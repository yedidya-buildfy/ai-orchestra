import type { AgentAdapter } from "./agent-adapter.js";
import type { AgentName } from "./types.js";

/**
 * Auto-warmup: each CLI shows interactive prompts on first run in a fresh
 * directory ("trust this folder?", "update available, install now?", "press
 * enter to continue", etc.). The warmup routine watches the pane's pipe
 * buffer for known patterns and auto-answers, so the user lands in a
 * fully-ready agent without ever having to dismiss prompts manually.
 *
 * Patterns are conservative — only known phrasings — and the loop bails
 * out as soon as no new output appears, so a successfully-warmed agent
 * exits the routine in a couple of seconds.
 */
export interface AutoResponder {
  pattern: RegExp;
  /** Text sent followed by Enter. Empty string = just press Enter. */
  response: string;
  description: string;
}

/** Patterns that apply to all three CLIs (trust prompts, generic continue). */
const SHARED_RESPONDERS: AutoResponder[] = [
  {
    pattern: /trust(ing)?\s+(this\s+)?(folder|directory|workspace|project)/i,
    response: "y",
    description: "trust folder",
  },
  {
    pattern: /do you (trust|want to trust)\s+(the\s+)?(files|authors|owners)/i,
    response: "y",
    description: "trust files",
  },
  {
    pattern: /press\s+(enter|return)\s+to\s+(continue|proceed|start)/i,
    response: "",
    description: "press enter",
  },
];

/** Update prompts: skip in-CLI updates; we use `orc update-clis`. */
const SKIP_UPDATE_RESPONDERS: AutoResponder[] = [
  {
    pattern: /update\s+(now|available|recommended).{0,80}\([yY]\/[nN]\)/i,
    response: "n",
    description: "skip in-CLI update",
  },
  {
    pattern: /install\s+(the\s+)?update.{0,20}\?/i,
    response: "n",
    description: "skip update install",
  },
];

export const CLAUDE_AUTO_RESPONDERS: AutoResponder[] = [
  ...SHARED_RESPONDERS,
  ...SKIP_UPDATE_RESPONDERS,
];

export const CODEX_AUTO_RESPONDERS: AutoResponder[] = [
  ...SHARED_RESPONDERS,
  ...SKIP_UPDATE_RESPONDERS,
  {
    pattern: /allow\s+codex\s+to\s+access/i,
    response: "y",
    description: "codex access permission",
  },
];

export const GEMINI_AUTO_RESPONDERS: AutoResponder[] = [
  ...SHARED_RESPONDERS,
  ...SKIP_UPDATE_RESPONDERS,
  {
    pattern: /accept\s+telemetry|usage\s+statistics/i,
    response: "n",
    description: "decline telemetry",
  },
];

export const RESPONDERS_BY_AGENT: Record<AgentName, AutoResponder[]> = {
  CLAUDE: CLAUDE_AUTO_RESPONDERS,
  CODEX: CODEX_AUTO_RESPONDERS,
  GEMINI: GEMINI_AUTO_RESPONDERS,
};

export interface WarmupResult {
  agent: AgentName;
  responded: { description: string; sent: string; round: number }[];
  rounds: number;
  durationMs: number;
}

export interface WarmupOptions {
  /** Max rounds of buffer-scan + respond. */
  rounds?: number;
  /** Delay between rounds (ms). Gives the CLI time to render the next prompt. */
  delayMs?: number;
  /** Hard timeout for the whole warmup. */
  maxTotalMs?: number;
  /** Initial wait before the first scan, to let the CLI's banner render. */
  initialDelayMs?: number;
  /** Optional custom responders (overrides per-agent default). */
  responders?: AutoResponder[];
}

/**
 * Scan the agent's pipe buffer for known prompts, auto-respond, repeat.
 * Bails out early when a full round produces no new output.
 */
export async function warmupAgent(
  adapter: AgentAdapter,
  opts: WarmupOptions = {},
): Promise<WarmupResult> {
  const responders = opts.responders ?? RESPONDERS_BY_AGENT[adapter.agent];
  const rounds = opts.rounds ?? 10;
  const delayMs = opts.delayMs ?? 1500;
  const maxTotalMs = opts.maxTotalMs ?? 30_000;
  const initialDelayMs = opts.initialDelayMs ?? 1500;

  const start = Date.now();
  const responded: WarmupResult["responded"] = [];
  let lastBufLen = 0;
  let quietRounds = 0;
  let lastResponseRound = -2;

  await sleep(initialDelayMs);

  let r = 0;
  for (; r < rounds; r++) {
    if (Date.now() - start > maxTotalMs) break;

    const buf = (await safeBuffer(adapter)) ?? "";
    const fresh = buf.slice(lastBufLen);
    lastBufLen = buf.length;

    if (!fresh) {
      quietRounds++;
      // If we've been quiet for 2 rounds AND haven't responded recently, exit early.
      if (quietRounds >= 2 && lastResponseRound < r - 1) break;
      await sleep(delayMs);
      continue;
    }
    quietRounds = 0;

    let matched = false;
    for (const rule of responders) {
      if (rule.pattern.test(fresh)) {
        try {
          await adapter.prompt(rule.response);
        } catch {
          // session might have died; bail
          break;
        }
        responded.push({
          description: rule.description,
          sent: rule.response || "<enter>",
          round: r,
        });
        lastResponseRound = r;
        matched = true;
        break;
      }
    }

    await sleep(matched ? delayMs : Math.min(delayMs, 1000));
  }

  return {
    agent: adapter.agent,
    responded,
    rounds: r,
    durationMs: Date.now() - start,
  };
}

async function safeBuffer(adapter: AgentAdapter): Promise<string> {
  try {
    return (await adapter.tmux.readPipeBuffer()) ?? "";
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
