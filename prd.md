# PRD: AI Orchestra (Self-Refreshing, Token-Aware Multi-Agent System)

---

## 1. Objective

לבנות מערכת Multi-Agent מבוססת Markdown שבה:

* Claude Code מנהל את הזרימה (Orchestrator)
* Codex CLI ו־Gemini CLI הם סוכנים מבצעים/מבקרים
* המערכת יודעת:

  * למדוד קונטקסט (approx)
  * לרענן סשנים אוטומטית
  * לשמור זיכרון יציב מחוץ למודלים
  * להמשיך עבודה בלי תלות בזיכרון של המודל

---

## 2. Core Philosophy

```txt
Models forget.
System remembers.
```

```txt
Context = temporary
Markdown = permanent
```

---

## 3. System Architecture

### Components

* Markdown Memory Layer (`.orchestra`)
* Watcher (Node.js)
* tmux Sessions (persistent agents)
* Context Engine (token estimation)
* CLI wrapper (npm package)

---

## 4. Directory Structure

```txt
.orchestra/
  board.md
  memory.md
  changelog.md
  long_term.md
  protocol.md

  agents/
    claude.md
    codex.md
    gemini.md

  sessions/
    codex.json
    gemini.json

  metrics/
    context.json
```

---

## 5. board.md (Single Source of Truth)

```md
## Control
TASK_ID: 001
PHASE: IMPLEMENT
TASK_TYPE: FIX
NEXT_AGENT: CODEX
STATUS: ACTIVE

## Permissions
CODEX:
  mode: WRITE
  scope: ["src/api/*"]

GEMINI:
  mode: READ

## Context Health
CLAUDE: 78%
CODEX: 34%
GEMINI: 21%

## Objective
Fix ZIP validation bug

## Claude
...

## Codex
...

## Gemini
...

## Decisions
...

## Changelog
...
```

---

## 6. Agent Roles

### Claude Code

* Orchestrator
* Plan, decide, merge
* Assign tasks
* Full permissions

### Codex

* Technical execution + review
* Can fix bugs directly (if WRITE)
* Can trigger system actions (refresh)

### Gemini

* UX / UI / architecture
* Can modify frontend / flows (if WRITE)

---

## 7. Permission Model

```md
CODEX:
  mode: READ | WRITE
  scope: ["path/*"]

GEMINI:
  mode: READ | WRITE
  scope: ["path/*"]
```

Rules:

```txt
No WRITE → advisory only
WRITE → may modify files directly
```

---

## 8. Context Measurement System

### Layer 1 — Runtime (Claude only)

* מקור: GSD statusline
* אמין

---

### Layer 2 — Codex usage

אם קיים:

```txt
input_tokens + output_tokens + reasoning_tokens
```

---

### Layer 3 — Token Estimation

חישוב:

```txt
tokens(board.md)
+ tokens(memory.md)
+ tokens(recent messages)
```

---

### Buffer

```txt
real_usage ≈ estimated × 1.2
```

---

### Context Formula

```txt
usage % = total_tokens / max_context_window
```

---

## 9. Model Context Windows

```json
{
  "claude": 200000,
  "codex": 200000,
  "gemini": 1000000
}
```

---

## 10. Context Thresholds

```txt
0–70%   OK
70–80%  WARNING
80–90%  SUMMARIZE
90–95%  REFRESH
95%+    FORCE RESET
```

---

## 11. Refresh System (Core Mechanism)

### Trigger

```txt
- context > 90%
- loop / confusion
- large task finished
```

---

## 12. Claude Refresh (Critical Flow)

### Step 1 — Detection

Codex מזהה:

```txt
CLAUDE > 90%
```

---

### Step 2 — Write command

```md
REFRESH_TARGET: CLAUDE
REASON: context_overflow
```

---

### Step 3 — Watcher executes

```bash
tmux kill-session -t claude
tmux new-session -d -s claude "claude"
```

---

### Step 4 — Rehydrate Claude

Inject:

```txt
protocol.md
memory.md
board.md
objective
```

---

### Result

```txt
Fresh Claude + same task + preserved system memory
```

---

## 13. Agent Refresh Rules

```txt
If context > 90% → recommend refresh
If >95% → force refresh
```

Agents יכולים לבקש:

```md
REFRESH_REQUESTED: TRUE
AGENT: CODEX
REASON: confusion | overflow | stale_context
```

---

## 14. Memory System

### memory.md (Active)

* current state
* decisions
* open issues

### changelog.md

* append-only history

### long_term.md

* completed knowledge
* stable patterns

---

## 15. Memory Compression

```txt
memory.md > 5K–8K words → summarize
move old → long_term.md
```

---

## 16. File Size Limits

```txt
board.md     ≤ 4K words
memory.md    ≤ 6K words
changelog.md append-only
long_term.md unlimited
```

---

## 17. Loading Strategy

```txt
Claude:
  board + memory

Codex:
  board + relevant files

Gemini:
  board + relevant files
```

Never load full:

```txt
changelog.md
long_term.md
```

---

## 18. Execution Modes

### Complex

```txt
Claude → plan
Codex → review
Gemini → review
Claude → merge
```

---

### Simple

```txt
Claude → assign
Codex/Gemini → execute directly
```

---

## 19. Watcher Responsibilities

1. Monitor `board.md`
2. Detect `NEXT_AGENT`
3. Read permissions
4. Compute context health
5. Trigger refresh if needed
6. Send command via tmux
7. Update metrics

---

## 20. tmux Sessions

```txt
claude
codex
gemini
```

Persistent.

---

## 21. Context Engine (Implementation)

### Tokenizer

```ts
tokens = encode(text).length
```

### Sources

```txt
board.md
memory.md
recent logs
```

---

## 22. Metrics File

```json
{
  "claude": 0.72,
  "codex": 0.34,
  "gemini": 0.21
}
```

---

## 23. Safety Rules

```txt
- Only active agent writes
- No permission → no write
- Refresh never deletes memory
- All actions logged
```

---

## 24. Key System Insight

```txt
The system does not scale by context.
It scales by resetting context safely.
```

---

## 25. MVP Scope

כולל:

* board.md orchestration
* NEXT_AGENT flow
* token estimation engine
* context thresholds
* auto refresh (Claude + Codex)
* tmux integration

לא כולל:

* UI dashboard
* parallel agents
* advanced permissions

---

## 26. Final Definition

זו מערכת שבה:

```txt
Agents are temporary workers.
Markdown is the brain.
Watcher is the nervous system.
Refresh is survival.
```

---
