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
npm i -g ai-orchestra
ai-orchestra init
```

Requirements: Node ≥ 20, tmux, and the `claude`, `codex`, and `gemini` CLIs
on `PATH` (the agents themselves use your existing subscriptions; this tool
does **not** call any API directly).

## Quickstart

```bash
ai-orchestra init                  # scaffold .orchestra/
ai-orchestra doctor                # sanity-check environment
ai-orchestra demo                  # walk a deterministic complex-mode task
ai-orchestra agent start claude    # spawn the Claude session in tmux
ai-orchestra context               # measure + display per-agent usage
ai-orchestra task start 001 "Fix ZIP validation bug"
ai-orchestra daemon                # run the watcher in the background
ai-orchestra status                # board / context / agents at a glance
```

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
<!-- ~/Library/LaunchAgents/com.user.ai-orchestra.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.user.ai-orchestra</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/ai-orchestra</string>
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
launchctl load ~/Library/LaunchAgents/com.user.ai-orchestra.plist
```

### Linux — systemd

```ini
# /etc/systemd/system/ai-orchestra.service
[Unit]
Description=AI Orchestra watcher
After=network.target

[Service]
Type=simple
User=youruser
ExecStart=/usr/local/bin/ai-orchestra watch -C /path/to/your/project
Restart=on-failure
RestartSec=2
StandardOutput=append:/path/to/your/project/.orchestra/logs/systemd.out
StandardError=append:/path/to/your/project/.orchestra/logs/systemd.err

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now ai-orchestra
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
| `daemon already running (pid …)` | `ai-orchestra daemon-stop` (or remove stale `.orchestra/logs/orchestrator.pid` if process is gone) |
| `Permission denied` on file write | check the agent's `Permissions.scope` glob in `board.md` |
| Watcher loops on its own writes | hash-based dedup is built in; see `Orchestrator.lastSelfWriteHash` |
| Agent stuck after refresh | `ai-orchestra recover` reconciles `board.md` against `changelog.md` |

## License

MIT
