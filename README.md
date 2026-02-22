# pi-ext

Personal extensions for the [pi coding agent](https://github.com/badlogic/pi-mono).

## Extensions

- `input-stash`: `Ctrl+X` to stash/restore editor input. Stash when input has text, restore when blank.
- `pi-open`: `/open @path/to/file` opens files, `/open <query>` filters recent assistant-mentioned files, and `/open settings` configures commands for `.md/.markdown`, default `.*`, and `Alt+E` edit command (default `nvim`) in `~/.pi/agent/pi-open.json`. Also supports quick-open with `@path/to/file!`, show/open shortcut via `Alt+Shift+S` and `Alt+S`, and edit shortcut via `Alt+Shift+E` and `Alt+E` from current editor input.
- `permission-gate`: Prompts for confirmation before running dangerous bash commands.
- `pi-ask`: Adds `ask_user` for interactive multiple-choice prompts with `Tab` to enter inline typing on the selected option (Claude-style). Also adds `/ask <prompt>` to force a tool-driven option picker flow and nudges the model to prefer this tool for multiple-choice user questions.
- `venice-provider`: Venice.ai dynamic model fetching with basic caching.
