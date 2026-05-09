# AI Orchestra

Self-refreshing, token-aware multi-agent orchestration. Claude Code, Codex CLI,
and Gemini CLI run side-by-side as **subscription-backed agents in tmux**,
coordinated by a Markdown brain on disk.

```
Models forget.
System remembers.
```

## Why

Long-running agent sessions degrade as their context fills up. AI Orchestra
moves the durable state to Markdown files (`.orchestra/`), measures token
usage continuously, and refreshes any agent that crosses a threshold —
killing the tmux session and respawning it with a clean rehydration prompt
built from `protocol.md + memory.md + board.md`. No agent memory is ever
lost; everything important is snapshotted to disk before a kill.

## Install

```bash
npm i -g @yedidya-dan/ai-orchestra
orc init
```

Requirements: Node ≥ 20, tmux, and the `claude`, `codex`, and `gemini` CLIs
on `PATH` (the agents themselves use your existing subscriptions; this tool
does **not** call any API directly).

> **Heads up — `1.0.0` is a breaking release.** The CLI binary was renamed
> from `ai-orchestra` to `orc`, and `orc init` now scaffolds **and** brings
> the agents up by default. Use `orc init --scaffold-only` for the old
> behavior. Upgrading from `0.x`? Run
> `npm uninstall -g @yedidya-dan/ai-orchestra && npm i -g @yedidya-dan/ai-orchestra`
> to clean up the old `ai-orchestra` symlink.

## Quickstart — one command

```bash
cd ~/projects/myapp
orc init
```

That single command:
1. Scaffolds `.orchestra/` if it isn't there yet.
2. Spawns **Codex** (`codex --full-auto`) and **Gemini** (`gemini --yolo`) in background tmux sessions.
3. Spawns **Claude** (`claude --dangerously-skip-permissions`) in tmux.
4. Starts the watcher daemon so the orchestrator dispatches automatically.
5. Attaches you to the Claude tmux session — you see Claude Code's UI directly.

Detach with `Ctrl-B d` (the agents keep running). Re-attach later with `tmux attach -t claude`.

Useful flags:
```bash
orc start --no-attach     # spawn everything but stay in your shell
orc start --no-daemon     # no auto-dispatch loop
orc start --no-codex      # leave Codex out of this run
orc start --claude-cmd 'claude'  # don't pass the bypass flag
```

## Manual quickstart (if you want finer control)

```bash
orc init --scaffold-only  # scaffold .orchestra/ without spawning agents
orc doctor                # sanity-check environment
orc demo                  # walk a deterministic complex-mode task
orc agent start claude    # spawn the Claude session in tmux
orc context               # measure + display per-agent usage
orc task start 001 "Fix ZIP validation bug"
orc daemon                # run the watcher in the background
orc status                # board / context / agents at a glance
```

## Talk to Claude, not to the files

Starting in 1.2.0, every agent is bootstrapped on spawn (and on every refresh)
with a prompt that includes its role file (`.orchestra/agents/<agent>.md`),
the current `protocol.md` / `memory.md` / `board.md`, and an addendum that
tells it whether it is the user's point of contact or a silent worker.

In practice that means:

- **Claude is your only interface.** When you tell Claude "fix the zip bug"
  or "review the new dashboard layout", Claude itself updates `board.md`
  (sets `NEXT_AGENT`, `STATUS=ACTIVE`, the objective) and the watcher daemon
  forwards the dispatch to Codex or Gemini. You never edit those files.
- **Codex and Gemini wait quietly.** They wake up on dispatch, do their
  block, and go back to waiting. You don't type into their panes.
- **Roles are configurable.** Edit `.orchestra/agents/claude.md` (or
  `codex.md` / `gemini.md`) to redefine what each agent should focus on —
  the change shows up in the next bootstrap or refresh, no restart needed.
- **Refreshes preserve continuity.** When an agent crosses the token band
  and gets refreshed, it comes back having re-read the live shared files,
  so anything the team did while it was killed is reflected in its working
  context.

## Named sessions — pick up where you left off

Each agent's CLI keeps its own conversation history (Claude in `~/.claude/projects/…`,
Codex in `~/.codex/sessions/…`, Gemini in `~/.gemini/tmp/…`). `orc rename` snapshots
the most-recent UUID for each one in your current workspace, and `orc resume` re-spawns
all three with their respective `--resume <id>` flag — so the agents come back with
their actual chat history, not just the `.orchestra/` memory.

```bash
# from your project, after a session has run for a while:
orc rename "fixing-zip-bug"

# days later, from any directory:
orc list
# NAME            LAST USED            DIR
# fixing-zip-bug  2026-05-09 22:14:00  /Users/me/projects/myapp

orc resume "fixing-zip-bug"   # cd's into the workspace and brings everyone back
orc forget "fixing-zip-bug"   # remove the registry entry (workspace untouched)
```

The registry lives at `~/.config/orc/sessions.json` (or `$XDG_CONFIG_HOME/orc/sessions.json`).
If a CLI hadn't been run yet at rename time, that agent simply gets a fresh spawn on resume —
the `.orchestra/` memory still rehydrates context.

## Architecture

```
.orchestra/
  board.md          single source of truth (Control / Permissions / Context Health / per-agent / Decisions / Changelog)
  memory.md         active working memory
  changelog.md      append-only audit log
  long_term.md      compressed history overflow
  protocol.md       agent operating rules
  agents/           per-agent profile files
  sessions/         tmux session metadata + pipe buffers
  metrics/          context.json (per-agent percentages + detail)
  logs/             orchestrator.log, daemon.log
```

Three layers of context measurement:
1. **Runtime** — token counts captured from each CLI's own output (Claude statusline, Codex `*_tokens` block, Gemini token reporting).
2. **Estimation** — local tokenizers (`@anthropic-ai/tokenizer`, `js-tiktoken o200k_base`, char/3.8 heuristic for Gemini) run over `board.md + memory.md + recent log window`.
3. **Buffer** — estimated × 1.2 (real usage tends to exceed message-token sums).

Threshold bands (PRD §10):

| Usage | Band | Action |
|---|---|---|
| 0–70% | OK | continue |
| 70–80% | WARNING | watch |
| 80–90% | SUMMARIZE | compress memory |
| 90–95% | REFRESH | recommend restart |
| 95%+ | FORCE_RESET | mandatory restart |

## Commands

| | |
|---|---|
| `init` / `paths` / `show` | scaffolding + introspection |
| `rename <name>` / `resume <name>` / `list` / `forget <name>` | named sessions — capture per-CLI conversation IDs and replay them later |
| `context [--runtime-* N] [--dry-run] [--json]` | measure + persist context health |
| `agent start|stop|status|send` | tmux session lifecycle |
| `tick` / `watch` / `daemon` / `daemon-stop` | orchestration loop |
| `refresh <agent> [--reason …]` / `refresh-sweep` / `compress-memory` | survival mechanism |
| `task start <id> "objective"` / `task verdict <approve\|reject\|needs_changes>` | execution-mode state machine |
| `demo` | deterministic end-to-end walkthrough |
| `doctor` / `status` / `logs <name>` / `recover` | observability + crash recovery |
| `config init` / `config show` | configuration overrides |

## Permissions

Each non-orchestrator agent has a `mode` and `scope` in `board.md`:

```md
## Permissions
CODEX:
  mode: WRITE
  scope: ["src/api/*"]

GEMINI:
  mode: READ
```

`READ` = advisory only. `WRITE` is enforced via picomatch globs against the
workspace root. Empty scope = nothing matches. Claude (orchestrator) always
has WRITE everywhere.

## Refresh flow (the survival mechanism)

```
1. detect: context > 95% OR agent self-requests OR orchestrator decides
2. snapshot: dump agent free-text block + last 50 lines of pane output → memory.md
3. compress: if memory.md > cap, archive oldest paragraphs → long_term.md
4. kill tmux session
5. spawn fresh tmux session running the configured CLI
6. inject: protocol.md + memory.md + board.md + objective
7. verify: check the new session is alive
8. log: changelog START + DONE entries with timestamp + reason + verified
```

## Production deployment

### macOS — launchd

```xml
<!-- ~/Library/LaunchAgents/com.user.orc.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.user.orc</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/orc</string>
    <string>watch</string>
    <string>-C</string>
    <string>/path/to/your/project</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/path/to/your/project/.orchestra/logs/launchd.out</string>
  <key>StandardErrorPath</key><string>/path/to/your/project/.orchestra/logs/launchd.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.user.orc.plist
```

### Linux — systemd

```ini
# /etc/systemd/system/orc.service
[Unit]
Description=AI Orchestra watcher
After=network.target

[Service]
Type=simple
User=youruser
ExecStart=/usr/local/bin/orc watch -C /path/to/your/project
Restart=on-failure
RestartSec=2
StandardOutput=append:/path/to/your/project/.orchestra/logs/systemd.out
StandardError=append:/path/to/your/project/.orchestra/logs/systemd.err

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now orc
```

### Log rotation

`.orchestra/logs/*.log` files grow unbounded. Pipe through your platform's log
rotator. Example logrotate snippet:

```
/path/to/your/project/.orchestra/logs/*.log {
  weekly
  rotate 8
  size 10M
  copytruncate
  missingok
  notifempty
}
```

### Backup

`.orchestra/` is the durable brain. Back it up. Critical files:
- `board.md`, `memory.md` — current state
- `changelog.md`, `long_term.md` — history (append-only / write-mostly)
- `metrics/`, `sessions/` — derived but cheap to recompute

## Troubleshooting

| Symptom | Fix |
|---|---|
| `tmux is not installed` | `brew install tmux` / `apt install tmux` |
| `daemon already running (pid …)` | `orc daemon-stop` (or remove stale `.orchestra/logs/orchestrator.pid` if process is gone) |
| `Permission denied` on file write | check the agent's `Permissions.scope` glob in `board.md` |
| Watcher loops on its own writes | hash-based dedup is built in; see `Orchestrator.lastSelfWriteHash` |
| Agent stuck after refresh | `orc recover` reconciles `board.md` against `changelog.md` |

## License

MIT
