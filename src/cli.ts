import { Command } from "commander";
import { resolve, dirname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync as readFileSyncPkg } from "node:fs";
import { initWorkspace, paths, readBoard } from "./workspace.js";
import { refreshContext, type RuntimeOverrides } from "./context-writer.js";
import type { AgentName } from "./types.js";
import {
  buildAdapters,
  DEFAULT_AGENT_CONFIG,
  YOLO_AGENT_CONFIG,
} from "./agent-adapter.js";
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
  configPath,
  DEFAULT_CONFIG,
  loadConfig,
  writeConfig,
} from "./config.js";
import { spawn as spawnProc } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

program
  .name("ai-orchestra")
  .description("Self-refreshing multi-agent orchestration over Markdown.")
  .version(readPackageVersion(), "-v, --version", "print the installed version");

program
  .command("start")
  .description(
    "One-shot launch: bring up all three agents with bypass/yolo flags and attach you to the Claude UI. Codex + Gemini run in the background; the watcher daemon can also be started so the orchestrator dispatches automatically.",
  )
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
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
    "override Codex launch command (default: codex --full-auto)",
  )
  .option(
    "--gemini-cmd <cmd>",
    "override Gemini launch command (default: gemini --yolo)",
  )
  .action(
    async (opts: {
      cwd: string;
      claude: boolean;
      codex: boolean;
      gemini: boolean;
      attach: boolean;
      daemon: boolean;
      claudeCmd?: string;
      codexCmd?: string;
      geminiCmd?: string;
    }) => {
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

      // Attach to Claude's tmux session for the user's UI (unless --no-attach).
      if (opts.attach && opts.claude) {
        process.stdout.write(
          `\nattaching to Claude session (Ctrl-B then d to detach; agents keep running)\n\n`,
        );
        // Replace this process's stdio with tmux attach so the user gets the TTY.
        const tmuxAttach = spawnProc(
          "tmux",
          ["attach", "-t", adapters.CLAUDE.sessionName],
          { stdio: "inherit" },
        );
        tmuxAttach.on("exit", (code) => process.exit(code ?? 0));
        return;
      }

      process.stdout.write(
        `\nall set. attach manually with:  tmux attach -t ${adapters.CLAUDE.sessionName}\n`,
      );
    },
  );

program
  .command("init")
  .description("Scaffold .orchestra/ in the current directory.")
  .option("-f, --force", "overwrite if .orchestra/ already exists", false)
  .option("-C, --cwd <dir>", "directory to initialize in", process.cwd())
  .action(async (opts: { force: boolean; cwd: string }) => {
    const root = resolve(opts.cwd);
    try {
      const p = await initWorkspace(root, { force: opts.force });
      process.stdout.write(`initialized .orchestra/ at ${p.root}\n`);
    } catch (e) {
      process.stderr.write(`init failed: ${(e as Error).message}\n`);
      process.exit(1);
    }
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
  .command("compress-memory")
  .description("Move oldest memory.md paragraphs to long_term.md if over the cap.")
  .option("-C, --cwd <dir>", "workspace root", process.cwd())
  .action(async (opts: { cwd: string }) => {
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
