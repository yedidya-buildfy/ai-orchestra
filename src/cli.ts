import { Command } from "commander";
import { resolve, dirname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync as readFileSyncPkg } from "node:fs";
import { initWorkspace, paths, readBoard } from "./workspace.js";
import { refreshContext, type RuntimeOverrides } from "./context-writer.js";
import type { AgentName } from "./types.js";
import {
  buildAdapters,
  buildYoloResumeCommand,
  DEFAULT_AGENT_CONFIG,
  YOLO_AGENT_CONFIG,
} from "./agent-adapter.js";
import { findAgentSessions, type AgentSessionIds } from "./conversation-finder.js";
import { prepareBootstrap } from "./bootstrap-prompt.js";
import {
  getSession,
  listSessions,
  removeSession,
  setSession,
  touchSession,
} from "./registry.js";
import { TmuxSession } from "./tmux.js";
import { Orchestrator } from "./orchestrator.js";
import { refreshAgent, refreshSweep, type RefreshReason } from "./refresh.js";
import { compressMemoryIfNeeded } from "./memory.js";
import {
  applyVerdict,
  startComplexTask,
  startSimpleTask,
  type ExecutionMode,
  type Verdict,
} from "./execution-mode.js";
import { doctor, recoverFromCrash, status, tailLog } from "./observability.js";
import {
  createView,
  killView,
  resizeClaude,
  toggleSidekicks,
  viewExists,
  VIEW_SESSION,
} from "./view.js";
import { warmupAgent } from "./warmup.js";
import { DEFAULT_UPDATE_CMDS, updateAll } from "./updater.js";
import { trustPath } from "./trust.js";
import {
  configPath,
  DEFAULT_CONFIG,
  loadConfig,
  writeConfig,
} from "./config.js";
import { spawn as spawnProc } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, promises as fsp } from "node:fs";
import { join } from "node:path";

const program = new Command();

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/cli.js → ../package.json
    for (const candidate of [pathJoin(here, "..", "package.json"), pathJoin(here, "..", "..", "package.json")]) {
      try {
        const pkg = JSON.parse(readFileSyncPkg(candidate, "utf8"));
        if (typeof pkg.version === "string") return pkg.version;
      } catch {
        // try next
      }
    }
  } catch {
    /* ignore */
  }
  return "0.0.0";
}

type StartOpts = {
  cwd: string;
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  attach: boolean;
  daemon: boolean;
  trust: boolean;
  autoUpdate?: boolean;
  claudeCmd?: string;
  codexCmd?: string;
  geminiCmd?: string;
};

async function runStart(opts: StartOpts): Promise<void> {
  const root = resolve(opts.cwd);

  if (!(await TmuxSession.tmuxAvailable())) {
    process.stderr.write("tmux is not installed or not on PATH\n");
    process.exit(1);
  }

  // Init workspace if missing.
  const p = paths(root);
  if (!existsSync(p.root)) {
    await initWorkspace(root);
    process.stdout.write(`initialized .orchestra/ at ${p.root}\n`);
  }

  // Pre-trust the cwd in each CLI's config file. Idempotent; this
  // suppresses the "trust this folder?" prompt on every future run.
  if (opts.trust) {
    const trustResults = await trustPath(root);
    for (const t of trustResults) {
      if (t.changed) {
        process.stdout.write(`trust ${t.agent}: ${t.detail}\n`);
      }
    }
  }

  // Optional: pull latest CLI versions before spawning.
  if (opts.autoUpdate) {
    process.stdout.write(`updating agent CLIs first (--auto-update)...\n`);
    const ur = await updateAll(["CLAUDE", "CODEX", "GEMINI"]);
    for (const r of ur) {
      const mark = r.ok ? "[ok]" : "[!!]";
      process.stdout.write(`  ${mark} ${r.agent} (${r.durationMs}ms)\n`);
    }
  }

  // Build adapters with YOLO defaults, allowing CLI overrides.
  const cfg = {
    CLAUDE: { command: opts.claudeCmd ?? YOLO_AGENT_CONFIG.CLAUDE.command },
    CODEX: { command: opts.codexCmd ?? YOLO_AGENT_CONFIG.CODEX.command },
    GEMINI: { command: opts.geminiCmd ?? YOLO_AGENT_CONFIG.GEMINI.command },
  };
  const adapters = buildAdapters(root, cfg);

  const wanted: AgentName[] = [];
  if (opts.codex) wanted.push("CODEX");
  if (opts.gemini) wanted.push("GEMINI");
  if (opts.claude) wanted.push("CLAUDE");

  for (const a of wanted) {
    const ad = adapters[a];
    if (await ad.isAlive()) {
      process.stdout.write(`agent ${a} already alive (session ${ad.sessionName})\n`);
      continue;
    }
    try {
      await ad.spawn();
      process.stdout.write(
        `agent ${a} started (session ${ad.sessionName}): ${ad.tmux.command}\n`,
      );
    } catch (e) {
      process.stderr.write(`agent ${a} failed: ${(e as Error).message}\n`);
    }
  }

  // Start the watcher daemon (unless --no-daemon).
  if (opts.daemon) {
    const pidFile = join(p.logsDir, "orchestrator.pid");
    let alreadyRunning = false;
    if (existsSync(pidFile)) {
      const old = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isFinite(old)) {
        try {
          process.kill(old, 0);
          alreadyRunning = true;
        } catch {
          /* stale */
        }
      }
    }
    if (!alreadyRunning) {
      const child = spawnProc(process.execPath, [process.argv[1]!, "watch", "-C", root], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env, ORCHESTRA_DAEMON: "1" },
      });
      child.unref();
      writeFileSync(pidFile, String(child.pid) + "\n", "utf8");
      process.stdout.write(`daemon started (pid ${child.pid})\n`);
    } else {
      process.stdout.write("daemon already running\n");
    }
  }

  // Auto-warmup: dismiss "trust this folder?" / update prompts for any
  // agent we just spawned. Run in parallel; ignore errors so a slow
  // CLI never blocks the rest of the boot sequence.
  const justSpawned = wanted.filter((a) => adapters[a].sessionName);
  if (justSpawned.length > 0) {
    process.stdout.write(`auto-answering setup prompts...\n`);
    const results = await Promise.all(
      justSpawned.map((a) =>
        warmupAgent(adapters[a]).catch((e) => ({
          agent: a,
          responded: [],
          rounds: 0,
          durationMs: 0,
          error: (e as Error).message,
        })),
      ),
    );
    for (const r of results) {
      if (r.responded.length > 0) {
        process.stdout.write(
          `  ${r.agent}: ${r.responded
            .map((x) => `${x.description}=${x.sent}`)
            .join(", ")}\n`,
        );
      } else {
        process.stdout.write(`  ${r.agent}: no prompts detected\n`);
      }
    }
  }

  // Bootstrap prompt: tell each agent who it is, what its role is, and the
  // current state of the .orchestra/ shared files. We write the full bootstrap
  // text to a per-agent file under .orchestra/sessions/ and send each agent a
  // SHORT "please read this file" prompt — sending the full text via send-keys
  // gets buffered as a paste block in Claude Code's TUI (never auto-submits)
  // and can overflow Codex's input box. The short directive sidesteps both.
  // Run all three in parallel with error tolerance — a slow inject shouldn't
  // block boot.
  const bootstrapTargets = wanted.filter((a) => adapters[a].sessionName);
  if (bootstrapTargets.length > 0) {
    process.stdout.write(`sending bootstrap directive to each agent...\n`);
    await Promise.all(
      bootstrapTargets.map(async (a) => {
        try {
          const { relativePath, shortPrompt } = await prepareBootstrap(a, root);
          await adapters[a].prompt(shortPrompt);
          process.stdout.write(`  ${a}: bootstrap → ${relativePath}\n`);
        } catch (e) {
          process.stderr.write(
            `  ${a}: bootstrap failed: ${(e as Error).message}\n`,
          );
        }
      }),
    );
  }

  // Build the side-by-side view if all three are alive.
  const allAlive =
    (await adapters.CLAUDE.isAlive()) &&
    (await adapters.CODEX.isAlive()) &&
    (await adapters.GEMINI.isAlive());

  if (allAlive && opts.attach) {
    try {
      const r = await createView({
        claudeSession: adapters.CLAUDE.sessionName,
        codexSession: adapters.CODEX.sessionName,
        geminiSession: adapters.GEMINI.sessionName,
      });
      for (const n of r.notes) process.stdout.write(`${n}\n`);
    } catch (e) {
      process.stderr.write(`view setup failed: ${(e as Error).message}\n`);
      process.stderr.write(
        `falling back to direct claude attach. agents are running.\n`,
      );
      const fallback = spawnProc(
        "tmux",
        ["attach", "-t", adapters.CLAUDE.sessionName],
        { stdio: "inherit" },
      );
      fallback.on("exit", (code) => process.exit(code ?? 0));
      return;
    }
    process.stdout.write(
      [
        "",
        "attaching to side-by-side view.",
        "  switch panes:    Ctrl-B then arrow keys, or click with mouse",
        "  resize panes:    drag the divider with the mouse",
        "  zoom one pane:   Ctrl-B then z   (toggle full-screen)",
        "  detach:          Ctrl-B then d   (agents keep running)",
        "  re-attach later: orc view",
        "",
      ].join("\n"),
    );
    const tmuxAttach = spawnProc("tmux", ["attach", "-t", VIEW_SESSION], {
      stdio: "inherit",
    });
    tmuxAttach.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  if (opts.attach && opts.claude) {
    // Single-agent path: attach straight to claude.
    process.stdout.write(
      `\nattaching to Claude session (Ctrl-B then d to detach)\n\n`,
    );
    const tmuxAttach = spawnProc(
      "tmux",
      ["attach", "-t", adapters.CLAUDE.sessionName],
      { stdio: "inherit" },
    );
    tmuxAttach.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  process.stdout.write(
    `\nall set. attach manually with:  orc view\n`,
  );
}

program
  .name("orc")
  .description("Self-refreshing multi-agent orchestration over Markdown.")
  .version(readPackageVersion(), "-v, --version", "print the installed version");

program
  .command("init")
  .description(
    "Open this directory as an AI Orchestra workspace. If .orchestra/ already exists, picks up the existing state (board / memory / changelog) and brings the three agents up to it. Otherwise scaffolds a fresh workspace from templates and starts. Use --scaffold-only to create the files without spawning. Use --force to wipe and re-scaffold (DESTRUCTIVE).",
  )
  .option("-f, --force", "wipe an existing .orchestra/ and re-scaffold from templates (destroys board/memory/changelog)", false)
  .option("-C, --cwd <dir>", "directory to initialize in", process.cwd())
  .option("--scaffold-only", "only create/refresh the .orchestra/ files; do not spawn agents", false)
  .option("--no-claude", "skip starting Claude")
  .option("--no-codex", "skip starting Codex")
  .option("--no-gemini", "skip starting Gemini")
  .option("--no-attach", "do not auto-attach to the Claude tmux session")
  .option("--no-daemon", "do not start the watcher daemon")
  .option(
    "--claude-cmd <cmd>",
    "override Claude launch command (default: claude --dangerously-skip-permissions)",
  )
  .option(
    "--codex-cmd <cmd>",
    "override Codex launch command (default: codex --dangerously-bypass-approvals-and-sandbox)",
  )
  .option(
    "--gemini-cmd <cmd>",
    "override Gemini launch command (default: gemini --yolo)",
  )
  .option("--no-trust", "skip pre-trusting the cwd in each CLI's config")
  .option("--auto-update", "run 'update-clis' before spawning so agents start on the latest version")
  .action(async (opts: {
    force: boolean;
    cwd: string;
    scaffoldOnly: boolean;
    claude: boolean;
    codex: boolean;
    gemini: boolean;
    attach: boolean;
    daemon: boolean;
    trust: boolean;
    autoUpdate?: boolean;
    claudeCmd?: string;
    codexCmd?: string;
    geminiCmd?: string;
  }) => {
    const root = resolve(opts.cwd);
    const p = paths(root);
    const wsExists = existsSync(p.root);

    if (wsExists && !opts.force) {
      process.stdout.write(
        `using existing .orchestra/ at ${p.root} (memory + board preserved)\n`,
      );
    } else {
      try {
        await initWorkspace(root, { force: opts.force });
        process.stdout.write(
          opts.force
            ? `re-scaffolded .orchestra/ at ${p.root} (--force)\n`
            : `initialized .orchestra/ at ${p.root}\n`,
        );
      } catch (e) {
        process.stderr.write(`init failed: ${(e as Error).message}\n`);
        process.exit(1);
      }
    }

    if (opts.scaffoldOnly) return;
    const startOpts: StartOpts = {
      cwd: root,
      claude: opts.claude,
      codex: opts.codex,
      gemini: opts.gemini,
      attach: opts.attach,
      daemon: opts.daemon,
      trust: opts.trust,
    };
    if (opts.autoUpdate !== undefined) startOpts.autoUpdate = opts.autoUpdate;
    if (opts.claudeCmd !== undefined) startOpts.claudeCmd = opts.claudeCmd;
    if (opts.codexCmd !== undefined) startOpts.codexCmd = opts.codexCmd;
    if (opts.geminiCmd !== undefined) startOpts.geminiCmd = opts.geminiCmd;
    await runStart(startOpts);
  });

program
  .command("clean")
  .description(
    "DESTRUCTIVE: wipe this workspace's .orchestra/ and re-scaffold it from templates, as if you ran 'orc init' on a fresh directory. Stops the daemon and kills the three agent tmux sessions plus the view first. board.md, memory.md, changelog.md, long_term.md, agents/, protocol.md, and metrics are all reset. Requires --yes.",
  )
  .option("-y, --yes", "skip confirmation; really do it", false)
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .option("--scaffold-only", "after wiping, only re-create files; do not spawn agents", false)
  .action(async (opts: { yes: boolean; cwd: string; scaffoldOnly: boolean }) => {
    const root = resolve(opts.cwd);
    const p = paths(root);

    if (!existsSync(p.root)) {
      process.stderr.write(`no .orchestra/ at ${root} — nothing to clean.\n`);
      process.exit(1);
    }

    if (!opts.yes) {
      process.stderr.write(
        [
          "",
          `orc clean will WIPE .orchestra/ at ${root} and reset to factory templates.`,
          "  - board.md, memory.md, changelog.md, long_term.md will be lost",
          "  - any running agents and the daemon will be killed",
          "  - .orchestra/agents/, protocol.md, metrics, sessions, logs reset to defaults",
          "",
          "Re-run with --yes to confirm.",
          "",
        ].join("\n"),
      );
      process.exit(1);
    }

    // Stop the watcher daemon if running so it doesn't fight us writing
    // to .orchestra/.
    const pidFile = join(p.logsDir, "orchestrator.pid");
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, "SIGTERM");
          process.stdout.write(`stopped daemon (pid ${pid})\n`);
        } catch {
          /* already dead, fine */
        }
      }
    }

    // Kill all three agent tmux sessions plus the view. Each kill is best-
    // effort — a dead/missing session just throws and we move on.
    if (await TmuxSession.tmuxAvailable()) {
      const adapters = buildAdapters(root);
      for (const a of ["CLAUDE", "CODEX", "GEMINI"] as const) {
        try {
          if (await adapters[a].isAlive()) {
            await adapters[a].kill();
            process.stdout.write(`killed ${a} session\n`);
          }
        } catch {
          /* not alive */
        }
      }
      try {
        await killView();
      } catch {
        /* not alive */
      }
    }

    // Wipe everything and re-scaffold.
    await fsp.rm(p.root, { recursive: true, force: true });
    await initWorkspace(root);
    process.stdout.write(`cleaned and re-scaffolded .orchestra/ at ${p.root}\n`);

    if (opts.scaffoldOnly) return;
    await runStart({
      cwd: root,
      claude: true,
      codex: true,
      gemini: true,
      attach: true,
      daemon: true,
      trust: true,
    });
  });

program
  .command("rename <name>")
  .description(
    "Save the current workspace under a name so `orc resume <name>` can re-open it later. Captures the most-recent claude/codex/gemini conversation IDs in this cwd so the three agents resume their actual chats, not just fresh sessions.",
  )
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .action(async (name: string, opts: { cwd: string }) => {
    const root = resolve(opts.cwd);
    if (!existsSync(paths(root).root)) {
      process.stderr.write(
        `no .orchestra/ at ${root} — run 'orc init' here first, then start a session before naming it\n`,
      );
      process.exit(1);
    }
    const ids = await findAgentSessions(root);
    const found = (Object.values(ids) as Array<string | null>).filter((v) => v !== null);
    if (found.length === 0) {
      process.stderr.write(
        `no claude/codex/gemini conversations found in ${root}\n` +
          `  (each CLI must have run at least once in this dir for orc to capture an ID)\n`,
      );
      process.exit(1);
    }
    const existing = await getSession(name);
    const now = new Date().toISOString();
    await setSession(name, {
      dir: root,
      createdAt: existing?.createdAt ?? now,
      lastUsed: now,
      agentSessions: ids,
    });
    process.stdout.write(`saved '${name}' → ${root}\n`);
    for (const a of ["CLAUDE", "CODEX", "GEMINI"] as const) {
      const id = ids[a];
      process.stdout.write(`  ${a.padEnd(7)} ${id ?? "(none — will spawn fresh on resume)"}\n`);
    }
  });

program
  .command("resume <name>")
  .description(
    "Resume a previously named session: cd into its workspace and bring up claude/codex/gemini with each one's --resume flag pointed at the captured conversation IDs.",
  )
  .option("--no-attach", "do not auto-attach to the Claude tmux session")
  .option("--no-daemon", "do not start the watcher daemon")
  .action(async (name: string, opts: { attach: boolean; daemon: boolean }) => {
    const entry = await getSession(name);
    if (!entry) {
      process.stderr.write(
        `no session named '${name}'. run 'orc list' to see available sessions.\n`,
      );
      process.exit(1);
    }
    if (!existsSync(paths(entry.dir).root)) {
      process.stderr.write(
        `session '${name}' was bound to ${entry.dir}, but its .orchestra/ no longer exists.\n` +
          `  fix: cd to a project that has it, or 'orc forget ${name}' if abandoned.\n`,
      );
      process.exit(1);
    }
    const ids: AgentSessionIds = entry.agentSessions;
    process.stdout.write(`resuming '${name}' at ${entry.dir}\n`);
    for (const a of ["CLAUDE", "CODEX", "GEMINI"] as const) {
      const id = ids[a];
      process.stdout.write(`  ${a.padEnd(7)} ${id ? `--resume ${id}` : "(fresh spawn)"}\n`);
    }
    await touchSession(name);
    await runStart({
      cwd: entry.dir,
      claude: true,
      codex: true,
      gemini: true,
      attach: opts.attach,
      daemon: opts.daemon,
      trust: true,
      claudeCmd: buildYoloResumeCommand("CLAUDE", ids.CLAUDE),
      codexCmd: buildYoloResumeCommand("CODEX", ids.CODEX),
      geminiCmd: buildYoloResumeCommand("GEMINI", ids.GEMINI),
    });
  });

program
  .command("list")
  .description("List all named sessions saved with `orc rename`, newest first.")
  .option("--json", "raw JSON output")
  .action(async (opts: { json?: boolean }) => {
    const items = await listSessions();
    if (opts.json) {
      process.stdout.write(JSON.stringify(items, null, 2) + "\n");
      return;
    }
    if (items.length === 0) {
      process.stdout.write("no named sessions yet. use 'orc rename <name>' to save one.\n");
      return;
    }
    const rows: string[][] = [["NAME", "LAST USED", "DIR"]];
    for (const { name, entry } of items) {
      rows.push([name, entry.lastUsed.replace("T", " ").slice(0, 19), entry.dir]);
    }
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
    for (const r of rows) {
      process.stdout.write(r.map((c, i) => c.padEnd(widths[i]!)).join("  ") + "\n");
    }
  });

program
  .command("forget <name>")
  .description("Remove a named session from the registry. Does not touch .orchestra/ files.")
  .action(async (name: string) => {
    const ok = await removeSession(name);
    if (!ok) {
      process.stderr.write(`no session named '${name}'\n`);
      process.exit(1);
    }
    process.stdout.write(`forgot '${name}' (the workspace itself is untouched)\n`);
  });

program
  .command("show")
  .description("Print parsed board.md as JSON.")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .action(async (opts: { cwd: string }) => {
    const root = resolve(opts.cwd);
    try {
      const board = await readBoard(root);
      process.stdout.write(JSON.stringify(board, null, 2) + "\n");
    } catch (e) {
      process.stderr.write(`show failed: ${(e as Error).message}\n`);
      process.exit(1);
    }
  });

program
  .command("paths")
  .description("Print resolved workspace paths as JSON.")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .action((opts: { cwd: string }) => {
    process.stdout.write(JSON.stringify(paths(resolve(opts.cwd)), null, 2) + "\n");
  });

program
  .command("context")
  .description("Measure agent context usage and update board.md + metrics/context.json.")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .option("--runtime-claude <n>", "runtime token count for Claude", parseIntOpt)
  .option("--runtime-codex <n>", "runtime token count for Codex", parseIntOpt)
  .option("--runtime-gemini <n>", "runtime token count for Gemini", parseIntOpt)
  .option("--dry-run", "do not update board.md / metrics; print only")
  .option("--json", "emit raw JSON instead of a table")
  .action(
    async (opts: {
      cwd: string;
      runtimeClaude?: number;
      runtimeCodex?: number;
      runtimeGemini?: number;
      dryRun?: boolean;
      json?: boolean;
    }) => {
      const root = resolve(opts.cwd);
      const runtime: RuntimeOverrides = {};
      if (opts.runtimeClaude !== undefined) runtime.CLAUDE = opts.runtimeClaude;
      if (opts.runtimeCodex !== undefined) runtime.CODEX = opts.runtimeCodex;
      if (opts.runtimeGemini !== undefined) runtime.GEMINI = opts.runtimeGemini;

      try {
        if (opts.dryRun) {
          // dry-run: read-only measurement using same engine path
          const { measureAll } = await import("./context-engine.js");
          const { defaultInputs } = await import("./context-writer.js");
          const { buildTokenizers } = await import("./tokenizer.js");
          const inputs = defaultInputs(root, { runtime });
          const snapshots = await measureAll(inputs, buildTokenizers());
          if (opts.json) {
            process.stdout.write(JSON.stringify(snapshots, null, 2) + "\n");
          } else {
            printContextTable(snapshots);
          }
          return;
        }

        const { snapshots } = await refreshContext(root, { runtime });
        if (opts.json) {
          process.stdout.write(JSON.stringify(snapshots, null, 2) + "\n");
        } else {
          printContextTable(snapshots);
        }
      } catch (e) {
        process.stderr.write(`context failed: ${(e as Error).message}\n`);
        process.exit(1);
      }
    },
  );

function parseIntOpt(v: string): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid integer: ${v}`);
  return n;
}

function printContextTable(snapshots: Record<AgentName, {
  tokens: number;
  windowMax: number;
  pct: number;
  band: string;
  source: string;
  tokenizer: string;
}>): void {
  const header = ["AGENT", "TOKENS", "WINDOW", "USAGE", "BAND", "SOURCE", "TOKENIZER"];
  const rows: string[][] = [header];
  for (const a of ["CLAUDE", "CODEX", "GEMINI"] as const) {
    const s = snapshots[a];
    rows.push([
      a,
      s.tokens.toLocaleString("en-US"),
      s.windowMax.toLocaleString("en-US"),
      `${(s.pct * 100).toFixed(1)}%`,
      s.band,
      s.source,
      s.tokenizer,
    ]);
  }
  const widths = header.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  for (const r of rows) {
    process.stdout.write(r.map((c, i) => c.padEnd(widths[i]!)).join("  ") + "\n");
  }
}

const agent = program.command("agent").description("Agent session management.");

agent
  .command("start <name>")
  .description("Start a tmux session for an agent (claude|codex|gemini).")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .option("--cmd <command>", "override the command run in the session")
  .action(async (name: string, opts: { cwd: string; cmd?: string }) => {
    const upper = name.toUpperCase() as AgentName;
    if (!["CLAUDE", "CODEX", "GEMINI"].includes(upper)) {
      process.stderr.write(`unknown agent: ${name}\n`);
      process.exit(1);
    }
    if (!(await TmuxSession.tmuxAvailable())) {
      process.stderr.write("tmux is not installed or not on PATH\n");
      process.exit(1);
    }
    const root = resolve(opts.cwd);
    const cfg = { ...DEFAULT_AGENT_CONFIG };
    if (opts.cmd) cfg[upper] = { command: opts.cmd };
    const adapters = buildAdapters(root, cfg);
    const ad = adapters[upper];
    try {
      await ad.spawn();
      process.stdout.write(`agent ${upper} started: tmux session "${ad.sessionName}"\n`);
    } catch (e) {
      process.stderr.write(`agent start failed: ${(e as Error).message}\n`);
      process.exit(1);
    }
  });

agent
  .command("stop <name>")
  .description("Kill an agent's tmux session.")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .action(async (name: string, opts: { cwd: string }) => {
    const upper = name.toUpperCase() as AgentName;
    const adapters = buildAdapters(resolve(opts.cwd));
    await adapters[upper].kill();
    process.stdout.write(`agent ${upper} stopped\n`);
  });

agent
  .command("status")
  .description("Print which agent sessions are alive.")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .action(async (opts: { cwd: string }) => {
    const adapters = buildAdapters(resolve(opts.cwd));
    const rows: string[][] = [["AGENT", "ALIVE", "SESSION"]];
    for (const a of ["CLAUDE", "CODEX", "GEMINI"] as const) {
      const alive = await adapters[a].isAlive();
      rows.push([a, alive ? "yes" : "no", adapters[a].sessionName]);
    }
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
    for (const r of rows) {
      process.stdout.write(r.map((c, i) => c.padEnd(widths[i]!)).join("  ") + "\n");
    }
  });

agent
  .command("send <name> <text>")
  .description("Send a prompt to an agent's tmux session.")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .action(async (name: string, text: string, opts: { cwd: string }) => {
    const upper = name.toUpperCase() as AgentName;
    const adapters = buildAdapters(resolve(opts.cwd));
    await adapters[upper].prompt(text);
    process.stdout.write(`sent to ${upper}\n`);
  });

program
  .command("tick")
  .description("Run a single orchestration tick (read board, dispatch if appropriate).")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .option("--dry-run", "do not actually prompt agents")
  .action(async (opts: { cwd: string; dryRun?: boolean }) => {
    const o = new Orchestrator(resolve(opts.cwd), { dryRun: opts.dryRun ?? false });
    const r = await o.tick();
    process.stdout.write(JSON.stringify(r) + "\n");
  });

program
  .command("watch")
  .description("Watch board.md and orchestrate. Foreground; Ctrl-C to stop.")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .option("--dry-run", "do not actually prompt agents")
  .action(async (opts: { cwd: string; dryRun?: boolean }) => {
    const o = new Orchestrator(resolve(opts.cwd), { dryRun: opts.dryRun ?? false });
    await o.watch();
    process.stdout.write(`watching ${resolve(opts.cwd)}/.orchestra/board.md (Ctrl-C to stop)\n`);
    const stop = async () => {
      await o.stop();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    // run a single tick at startup so existing state is processed
    await o.tick();
    // park forever
    await new Promise(() => {});
  });

program
  .command("daemon")
  .description("Start the watcher as a detached background process.")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .option("--dry-run", "do not actually prompt agents")
  .action(async (opts: { cwd: string; dryRun?: boolean }) => {
    const root = resolve(opts.cwd);
    const p = paths(root);
    const pidFile = join(p.logsDir, "orchestrator.pid");
    if (existsSync(pidFile)) {
      const old = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isFinite(old)) {
        try {
          process.kill(old, 0);
          process.stderr.write(`daemon already running (pid ${old})\n`);
          process.exit(1);
        } catch {
          /* stale pid file */
        }
      }
    }
    const logFile = join(p.logsDir, "daemon.log");
    const args = ["watch", "-C", root];
    if (opts.dryRun) args.push("--dry-run");
    const child = spawnProc(process.execPath, [process.argv[1]!, ...args], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, ORCHESTRA_DAEMON: "1" },
    });
    child.unref();
    writeFileSync(pidFile, String(child.pid) + "\n", "utf8");
    process.stdout.write(`daemon started (pid ${child.pid}); logs at ${logFile}\n`);
  });

program
  .command("daemon-stop")
  .description("Stop the background daemon.")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .action((opts: { cwd: string }) => {
    const p = paths(resolve(opts.cwd));
    const pidFile = join(p.logsDir, "orchestrator.pid");
    if (!existsSync(pidFile)) {
      process.stderr.write("no daemon pidfile\n");
      process.exit(1);
    }
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    try {
      process.kill(pid, "SIGTERM");
      process.stdout.write(`stopped pid ${pid}\n`);
    } catch (e) {
      process.stderr.write(`failed: ${(e as Error).message}\n`);
      process.exit(1);
    }
  });

program
  .command("refresh <agent>")
  .description("Refresh an agent: snapshot, kill tmux, respawn, rehydrate.")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .option("-r, --reason <reason>", "refresh reason", "manual")
  .option("--dry-run", "do not actually kill/respawn")
  .action(async (agent: string, opts: { cwd: string; reason: string; dryRun?: boolean }) => {
    const upper = agent.toUpperCase() as AgentName;
    if (!["CLAUDE", "CODEX", "GEMINI"].includes(upper)) {
      process.stderr.write(`unknown agent: ${agent}\n`);
      process.exit(1);
    }
    const refreshOpts: { dryRun?: boolean } = {};
    if (opts.dryRun) refreshOpts.dryRun = true;
    const r = await refreshAgent(resolve(opts.cwd), upper, opts.reason as RefreshReason, refreshOpts);
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  });

program
  .command("refresh-sweep")
  .description("Measure context and refresh any agent over threshold or self-requesting.")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .option("--dry-run", "do not actually kill/respawn")
  .action(async (opts: { cwd: string; dryRun?: boolean }) => {
    const sweepOpts: { dryRun?: boolean } = {};
    if (opts.dryRun) sweepOpts.dryRun = true;
    const r = await refreshSweep(resolve(opts.cwd), sweepOpts);
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  });

program
  .command("compact")
  .description("Move the oldest memory.md paragraphs to long_term.md if memory.md is over its cap. Use this when memory.md has grown noisy and the agents are wasting tokens re-reading old context.")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .action(async (opts: { cwd: string }) => {
    const r = await compressMemoryIfNeeded(resolve(opts.cwd));
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  });

program
  .command("compress-memory", { hidden: true })
  .description("[DEPRECATED] Renamed to `orc compact`. Forwards there.")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .action(async (opts: { cwd: string }) => {
    process.stderr.write(
      "note: 'compress-memory' has been renamed to 'compact'. The old name still works but will be removed in a future version.\n",
    );
    const r = await compressMemoryIfNeeded(resolve(opts.cwd));
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  });

const task = program.command("task").description("Manage tasks (execution modes).");

task
  .command("start <taskId> <objective...>")
  .description("Start a new task. Defaults to complex mode.")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .option("-m, --mode <mode>", "complex | simple", "complex")
  .option("-a, --agent <agent>", "agent for simple mode", "CODEX")
  .action(
    async (
      taskId: string,
      objectiveParts: string[],
      opts: { cwd: string; mode: string; agent: string },
    ) => {
      const root = resolve(opts.cwd);
      const objective = objectiveParts.join(" ");
      if (opts.mode === "simple") {
        const a = opts.agent.toUpperCase() as AgentName;
        await startSimpleTask(root, taskId, a, objective);
      } else {
        await startComplexTask(root, taskId, objective);
      }
      process.stdout.write(`task ${taskId} started in ${opts.mode} mode\n`);
    },
  );

task
  .command("verdict <verdict>")
  .description("Apply a verdict to advance the task phase: approve | reject | needs_changes")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .option("-m, --mode <mode>", "complex | simple", "complex")
  .option("-i, --inputs <inputs>", "free-form 'inputs' string for the decision hash", "")
  .option("--notes <notes>", "decision notes")
  .action(
    async (
      verdict: string,
      opts: { cwd: string; mode: string; inputs: string; notes?: string },
    ) => {
      const v = verdict as Verdict;
      if (!["approve", "reject", "needs_changes"].includes(v)) {
        process.stderr.write(`unknown verdict: ${verdict}\n`);
        process.exit(1);
      }
      const r = await applyVerdict(
        resolve(opts.cwd),
        opts.mode as ExecutionMode,
        v,
        opts.inputs,
        opts.notes,
      );
      process.stdout.write(JSON.stringify(r) + "\n");
    },
  );

program
  .command("trust [path]")
  .description(
    "Pre-trust a path in Claude/Codex/Gemini config files so the 'trust this folder?' prompt never appears.",
  )
  .action(async (pathArg: string | undefined) => {
    const target = resolve(pathArg ?? process.cwd());
    const results = await trustPath(target);
    for (const r of results) {
      const mark = r.changed ? "[+]" : "[=]";
      process.stdout.write(`${mark} ${r.agent.padEnd(7)} ${r.configPath}: ${r.detail}\n`);
    }
  });

program
  .command("warmup [agent]")
  .description(
    "Re-run the trust/update prompt auto-answer for an agent (or all three if omitted).",
  )
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .action(async (agent: string | undefined, opts: { cwd: string }) => {
    const root = resolve(opts.cwd);
    const adapters = buildAdapters(root);
    const targets: AgentName[] = agent
      ? [agent.toUpperCase() as AgentName]
      : ["CLAUDE", "CODEX", "GEMINI"];
    for (const t of targets) {
      if (!(await adapters[t].isAlive())) {
        process.stderr.write(`${t}: not alive — start it first\n`);
        continue;
      }
      const r = await warmupAgent(adapters[t]);
      process.stdout.write(`${t}: ${JSON.stringify(r)}\n`);
    }
  });

program
  .command("update-clis")
  .description("npm-update the agent CLIs (claude, codex, gemini).")
  .option("--claude-only", "update Claude only")
  .option("--codex-only", "update Codex only")
  .option("--gemini-only", "update Gemini only")
  .option("--print", "print the commands instead of running them")
  .action(
    async (opts: {
      claudeOnly?: boolean;
      codexOnly?: boolean;
      geminiOnly?: boolean;
      print?: boolean;
    }) => {
      let selected: AgentName[] = ["CLAUDE", "CODEX", "GEMINI"];
      if (opts.claudeOnly) selected = ["CLAUDE"];
      else if (opts.codexOnly) selected = ["CODEX"];
      else if (opts.geminiOnly) selected = ["GEMINI"];

      if (opts.print) {
        for (const a of selected) {
          process.stdout.write(`${a}: ${DEFAULT_UPDATE_CMDS[a]}\n`);
        }
        return;
      }

      process.stdout.write(`updating: ${selected.join(", ")}...\n`);
      const results = await updateAll(selected);
      let allOk = true;
      for (const r of results) {
        const mark = r.ok ? "[ok]" : "[!!]";
        process.stdout.write(
          `${mark} ${r.agent} (${r.durationMs}ms): ${r.command}\n`,
        );
        if (!r.ok) {
          allOk = false;
          if (r.stderrTail) process.stdout.write(`     ${r.stderrTail}\n`);
        }
      }
      process.stdout.write(
        allOk
          ? "\nall agent CLIs updated. Restart agents with 'orc refresh <name>' or 'orc init'.\n"
          : "\nsome updates failed; see stderr above\n",
      );
      process.exit(allOk ? 0 : 1);
    },
  );

program
  .command("view")
  .description("Attach to the side-by-side view (claude | codex | gemini). Creates it if needed.")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .option("--rebuild", "kill any existing view and recreate it")
  .action(async (opts: { cwd: string; rebuild?: boolean }) => {
    if (!(await TmuxSession.tmuxAvailable())) {
      process.stderr.write("tmux is not installed or not on PATH\n");
      process.exit(1);
    }
    const adapters = buildAdapters(resolve(opts.cwd));
    const allAlive =
      (await adapters.CLAUDE.isAlive()) &&
      (await adapters.CODEX.isAlive()) &&
      (await adapters.GEMINI.isAlive());
    if (!allAlive) {
      process.stderr.write(
        "not all three agent sessions are alive; run 'orc init' or 'orc agent start <name>' first\n",
      );
      process.exit(1);
    }
    if (opts.rebuild || !(await viewExists())) {
      await createView({
        claudeSession: adapters.CLAUDE.sessionName,
        codexSession: adapters.CODEX.sessionName,
        geminiSession: adapters.GEMINI.sessionName,
      });
    }
    const t = spawnProc("tmux", ["attach", "-t", VIEW_SESSION], { stdio: "inherit" });
    t.on("exit", (code) => process.exit(code ?? 0));
  });

program
  .command("hide")
  .description("Hide the codex+gemini panes (zoom claude full-pane). Calling again restores.")
  .action(async () => {
    const r = await toggleSidekicks();
    process.stdout.write(JSON.stringify(r) + "\n");
  });

program
  .command("unhide")
  .description("Reverse of 'hide'. Same underlying tmux toggle.")
  .action(async () => {
    const r = await toggleSidekicks();
    process.stdout.write(JSON.stringify(r) + "\n");
  });

program
  .command("resize-claude <pct>")
  .description("Set claude pane width to N% of view (e.g. 70).")
  .action(async (pct: string) => {
    const n = Number.parseInt(pct, 10);
    if (!Number.isFinite(n) || n <= 0 || n >= 100) {
      process.stderr.write("pct must be an integer 1-99\n");
      process.exit(1);
    }
    const r = await resizeClaude(n);
    process.stdout.write(JSON.stringify(r) + "\n");
  });

program
  .command("view-stop")
  .description("Kill the view session (does not stop the agents).")
  .action(async () => {
    await killView();
    process.stdout.write("view stopped (agents still running)\n");
  });

program
  .command("demo")
  .description("Run the deterministic complex-mode demo (no live agents).")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .action(async (opts: { cwd: string }) => {
    const { runDemo } = await import("./demo.js");
    const r = await runDemo(resolve(opts.cwd));
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  });

program
  .command("doctor")
  .description("Run environment sanity checks.")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .action(async (opts: { cwd: string }) => {
    const r = await doctor(resolve(opts.cwd));
    for (const c of r.checks) {
      const mark = c.ok ? "[ok]" : "[!!]";
      process.stdout.write(`${mark} ${c.name}: ${c.detail}\n`);
    }
    process.stdout.write(r.ok ? "\nall checks passed\n" : "\nsome checks failed\n");
    process.exit(r.ok ? 0 : 1);
  });

program
  .command("status")
  .description("Print board state, context health, and agent session status.")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .option("--json", "raw JSON output")
  .action(async (opts: { cwd: string; json?: boolean }) => {
    const s = await status(resolve(opts.cwd));
    if (opts.json) {
      process.stdout.write(JSON.stringify(s, null, 2) + "\n");
      return;
    }
    process.stdout.write(
      `task ${s.board.taskId}  phase=${s.board.phase}  status=${s.board.status}  next=${s.board.nextAgent}\n`,
    );
    process.stdout.write(`objective: ${s.board.objective}\n\n`);
    process.stdout.write("context health:\n");
    for (const a of ["CLAUDE", "CODEX", "GEMINI"] as const) {
      process.stdout.write(`  ${a.padEnd(7)} ${(s.contextHealth[a] * 100).toFixed(2)}%\n`);
    }
    process.stdout.write("\nagents:\n");
    for (const a of s.agents) {
      process.stdout.write(`  ${a.name.padEnd(7)} alive=${a.alive ? "yes" : "no"}  session=${a.sessionName}\n`);
    }
  });

program
  .command("logs <name>")
  .description("Tail an orchestra log file (e.g. 'orchestrator', 'daemon').")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .option("-n, --lines <n>", "number of lines", "100")
  .action(async (name: string, opts: { cwd: string; lines: string }) => {
    const text = await tailLog(resolve(opts.cwd), name, Number(opts.lines));
    process.stdout.write(text || `(no logs at ${name}.log)\n`);
  });

program
  .command("recover")
  .description("Recover from a crash by reconciling board.md against changelog.md.")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .action(async (opts: { cwd: string }) => {
    const r = await recoverFromCrash(resolve(opts.cwd));
    process.stdout.write(JSON.stringify(r) + "\n");
  });

const config = program.command("config").description("Manage .orchestra/config.json.");
config
  .command("init")
  .description("Write the default config to .orchestra/config.json.")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .option("-f, --force", "overwrite existing config")
  .action(async (opts: { cwd: string; force?: boolean }) => {
    const root = resolve(opts.cwd);
    const path = configPath(root);
    if (existsSync(path) && !opts.force) {
      process.stderr.write(`config exists at ${path} (use --force)\n`);
      process.exit(1);
    }
    await writeConfig(root, DEFAULT_CONFIG);
    process.stdout.write(`config written: ${path}\n`);
  });
config
  .command("show")
  .description("Print resolved config (defaults merged with on-disk overrides).")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .action(async (opts: { cwd: string }) => {
    const cfg = await loadConfig(resolve(opts.cwd));
    process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
  });

program.parseAsync().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
