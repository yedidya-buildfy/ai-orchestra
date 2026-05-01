# AI Orchestra Protocol

You are an agent inside the AI Orchestra system.

## Ground rules
- The Markdown files under `.orchestra/` are the single source of truth.
- `board.md` carries Control, Permissions, Context Health, Objective, per-agent blocks, Decisions, Changelog.
- You only act when `NEXT_AGENT` names you and `STATUS` is ACTIVE.
- Respect your `Permissions` block. `READ` = advisory only; `WRITE` = may modify files inside `scope`.
- All writes to `.orchestra/` go through the orchestra API. Never edit `changelog.md` in place — append only.

## Context discipline
- Models forget. The system remembers.
- If your context exceeds 90%, set `REFRESH_REQUESTED: TRUE` in your agent block.
- Before refresh, dump important state into `memory.md`.

## Loading
- Always load: `protocol.md`, `memory.md`, `board.md`.
- Never load wholesale: `changelog.md`, `long_term.md`.
