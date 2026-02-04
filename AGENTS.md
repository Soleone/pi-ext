# Pi Extension Development

This repo develops extensions for the [pi coding agent](https://github.com/badlogic/pi-mono).

## Mono Repo Reference

The pi mono repo is expected locally at `~/workspace/opensource/pi-mono`.

Before starting work, read its `AGENTS.md` for up-to-date rules on code quality, commands, style, git, and tooling.
Those rules apply here too -- do not duplicate them.

For extension development, read these from the mono repo:
- `packages/coding-agent/docs/extensions.md` -- full extension API, events, tools, UI, rendering, examples
- `packages/coding-agent/docs/tui.md` -- TUI component API for custom UI
- `packages/coding-agent/docs/themes.md` -- theme colors and styling

The following are available for when you need them, but don't read them right away because they cost a lot of contex:
- `packages/coding-agent/examples/extensions/` -- working extension examples
- `packages/coding-agent/src/core/extensions/types.ts` -- all extension types

For SDK usage:
- `packages/coding-agent/docs/sdk.md` -- programmatic API

## Task Management

Use `bd` (beads) for task tracking. See `~/.claude/skills/beads/SKILL.md` for the full CLI reference.

- When creating or updating issues with multi-line descriptions, use actual newlines in the shell command (not `\n`).
- Use p2 as default priority unless context gives another impression.

Key commands:
- `bd ready --sort priority --json` -- see unblocked work at session start
- `bd list --status open --json` -- list all open issues
- `bd show <id> --json` -- show issue details
- `bd update <id> -s in_progress --json` -- mark a task as started
- `bd close <id> -r "reason" --json` -- close a completed task
- `bd create "title" -t task --json` -- create a new task
- `bd sync` -- sync issues to git before ending a session
