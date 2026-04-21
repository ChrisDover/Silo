# Silo ◧

**Session-locked AI coding terminal. One project. One tool. No drift.**

Silo is an Electron-based terminal emulator purpose-built for AI coding workflows. Each window is locked to one project and one AI tool (Claude Code, Codex CLI, or any CLI tool). Sessions persist across restarts — scrollback, clipboard history, and command history all survive. Designed to run many instances simultaneously with minimal resource usage.

**Core thesis:** AI coding sessions need session isolation (no cross-project drift), zero-cost restarts (close/reboot/resume without losing state), and clipboard as a first-class data bus (every paste and file drop tracked with token counts).

## Requirements

- Node.js 18+
- macOS (arm64) or Linux
- On macOS: Xcode Command Line Tools (`xcode-select --install`) for `node-pty` compilation
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
npm run dist:mac     # macOS DMG
npm run dist:linux   # AppImage + deb
```

## Configuration

Edit `silo.config.json` to customize:

- `scanDirs` — directories Silo scans for projects
- `pinned` — projects that appear at the top of the launcher
- `tools` — AI CLIs available per window (defaults: `claude`, `codex`, `autoresearch`)
- `terminal` — font size, family, scrollback

The shipped config contains placeholder example projects. Replace them with your own.

## Skills

Drop markdown files into `skills/` and reference them from a tool entry via `"skill": "name"`. The skill content is prepended to the first prompt in that session.

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
