# Silo ◧

**Local-first AI agent control room. Gemma supervises, cloud agents escalate.**

Silo is an Electron-based control room for AI coding workflows. It is optimized for Apple Silicon and local models first: a Gemma model running through Ollama acts as the cheap always-on supervisor, while Claude Code, Codex CLI, and other cloud agents are launched only when the work needs them.

**Core thesis:** vibe coders do not need more terminal panes. They need to know what is running, what is blocked, what is dead, what is using resources, what is spending cloud tokens, and what to do next.

## What Silo Does

- Runs many project-locked AI CLI sessions in one lightweight desktop app
- Uses a local Gemma/Ollama supervisor as the primary session doctor
- Tracks session health: running, blocked, failed, dead, idle, or resource-heavy
- Shows process-tree CPU and memory usage per session so runaway agents and child processes are obvious
- Keeps cloud tools as escalation paths instead of the default
- Copies compact cloud handoff packets and can relaunch a session into Codex or Claude Code
- Can launch agents in isolated git worktrees under `~/.silo/worktrees`
- Tracks git changes per session and marks quiet changed sessions as ready for review
- Copies a diff preview with the terminal `Diff` action
- Turns clipboard and dropped files into a Context Vault with token estimates
- Preserves scrollback, command history, context items, and session metadata

## Requirements

- Node.js 18+
- macOS Apple Silicon arm64 preferred, or Linux
- On macOS: Xcode Command Line Tools (`xcode-select --install`) for `node-pty` compilation
- Optional but recommended: Ollama with your local Gemma model, default config uses `gemma4`
- Optional: `claude` and/or `codex` CLIs on your `$PATH`

## Quickstart

```bash
./setup.sh
npm start
```

For development mode:

```bash
npm run dev
```

To build a distributable:

```bash
npm run dist:mac:arm64  # Apple Silicon macOS DMG
npm run dist:linux      # AppImage + deb
```

## Configuration

Edit `silo.config.json` to customize:

- `scanDirs` — directories Silo scans for projects
- `pinned` — projects that appear at the top of the launcher
- `tools` — AI CLIs available per window (defaults: `claude`, `codex`, `autoresearch`)
- `localModel` — local supervisor settings for Ollama/Gemma
- `cloud` — budget and escalation defaults
- `performance` — Apple Silicon/resource monitor defaults
- `terminal` — font size, family, scrollback

The shipped config contains placeholder example projects. Replace them with your own.

Default local model config:

```json
{
  "localModel": {
    "enabled": true,
    "provider": "ollama",
    "model": "gemma4",
    "endpoint": "http://127.0.0.1:11434",
    "askBeforeCloudSpend": true
  }
}
```

If your local model has a different Ollama name, change `model`.

## Worktree Mode

Enable **Isolated worktree** in the tool picker to run a session in:

```text
~/.silo/worktrees/{project}-{session}
```

Silo creates a branch named `silo/{project}-{session}` from `HEAD`. If the selected folder is not a git worktree or creation fails, Silo falls back to the source checkout and records the error on the session.

Worktree sessions show extra actions:

- `Open WT` — open the isolated worktree in Finder
- `Merge WT` — merge the worktree branch into the source checkout
- `Keep WT` — mark the worktree as intentionally kept
- `Delete WT` — stop the session and run `git worktree remove`

`Merge WT` refuses to run if the source checkout has local changes. If git reports a merge conflict, resolve it manually in the source checkout.

`Delete WT` is intentionally conservative. If there are uncommitted changes, git may refuse removal until you commit, stash, or clean them.

## Skills

Drop markdown files into `skills/` and reference them from a tool entry via `"skill": "name"`. The skill content is prepended to the first prompt in that session.

The default Gemma tool uses `skills/gemma-local.md` plus a Silo-generated startup context packet. This makes the local Ollama model explicit about its real boundary: Gemma is running locally, but a raw Ollama model cannot browse or edit your filesystem by itself. Silo provides a bounded snapshot with project path, git status, top files, and key snippets so Gemma can supervise cheaply. Use Codex or Claude Code escalation when the work needs live file reads, edits, tests, or commits.

## Security

Silo scrubs well-known secret patterns from persisted scrollback and clipboard history:

- `sk-{20+}` → `[REDACTED_API_KEY]`
- `Bearer {20+}` → `Bearer [REDACTED_TOKEN]`
- `AKIA{16}` → `[REDACTED_AWS_KEY]`

Sensitive env vars (`GH_TOKEN`, `GITHUB_TOKEN`, `npm_config_token`, etc.) are stripped from the PTY environment before spawning tools.

## Architecture

See [`SILO-BUILD.md`](./SILO-BUILD.md) for the full build specification — architecture, file layout, IPC surface, persistence schema, and design tokens.

## License

MIT
