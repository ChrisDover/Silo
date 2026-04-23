# SILO — Build Specification

> **What this is:** Hand this file to Claude Code. It contains everything needed to build Silo from scratch — architecture, every file spec, security requirements, and design tokens. Run `claude` in an empty directory and paste/reference this file.

## Project Summary

Silo is a local-first AI agent control room for running and supervising many agent sessions on one Mac. Each session is locked to one project, one tool, and optionally one isolated git worktree. Sessions persist across restarts, and Silo keeps the practical operator state visible: what is running, what is blocked, what is dead, what is using resources, what has changed, and what needs human review.

Gemma through Ollama is the default always-on local orchestrator. It is used for cheap supervision, status classification, blocker summaries, and routine handoff preparation. Claude Code, Codex CLI, and other cloud agents remain escalation paths when the work needs stronger reasoning, live file edits, tests, commits, or final review.

**Core thesis:** people operating AI agent companies do not need more terminal panes. They need an operations cockpit that makes parallel agent work legible and controllable: live sessions, dead sessions, blocked sessions, resource burn, token/context pressure, review-ready diffs, and conservative merge controls.

## Product Model

Silo is the operator console. A revenue workflow such as `_MAKO` can be one agent-operated company running through it. Silo itself manages:

- project-locked agent sessions
- local Gemma supervision
- cloud escalation handoffs
- context vault inputs and token estimates
- per-session CPU and memory visibility
- git worktree isolation
- diff/review/merge controls
- persistent crash and runtime logs

The UX should stay operational rather than developer-theatrical. A non-expert operator should be able to answer:

- What is running?
- What is dead?
- What is blocked?
- What should happen next?
- What is consuming resources or cloud budget?
- Which worktree can be reviewed, kept, deleted, or merged?

## Tech Stack

- **Electron** (v28+) — desktop shell, native windows, IPC
- **node-pty** — real PTY for shell + AI tool execution
- **xterm.js** (v5.3+) — terminal rendering with addons (fit, web-links)
- **electron-store** — encrypted JSON persistence
- **No React. No bundler. No build step.** Vanilla JS throughout.

## File Structure

Create this exact structure:

```
silo/
├── package.json
├── silo.config.json
├── setup.sh
├── .gitignore
├── README.md
└── src/
    ├── main.js          ← Electron main process (~400 LOC)
    ├── preload.js       ← Context-isolated IPC bridge (~30 LOC)
    ├── index.html       ← All view shells (~130 LOC)
    ├── styles.css       ← All styling with CSS variables (~350 LOC)
    └── renderer.js      ← UI logic for all views (~420 LOC)
```

---

## package.json

```json
{
  "name": "silo",
  "version": "0.1.0",
  "description": "Session-locked AI coding terminal. One project. One tool. No drift.",
  "main": "src/main.js",
  "scripts": {
    "start": "electron .",
    "dev": "NODE_ENV=development electron .",
    "dist": "electron-builder",
    "dist:mac": "electron-builder --mac",
    "dist:linux": "electron-builder --linux",
    "postinstall": "electron-rebuild"
  },
  "build": {
    "appId": "com.silo.app",
    "productName": "Silo",
    "mac": {
      "category": "public.app-category.developer-tools",
      "target": ["dmg", "zip"]
    },
    "linux": {
      "target": ["AppImage", "deb"],
      "category": "Development"
    }
  },
  "dependencies": {
    "electron-store": "^8.1.0",
    "node-pty": "^1.0.0",
    "xterm": "^5.3.0",
    "xterm-addon-fit": "^0.8.0",
    "xterm-addon-web-links": "^0.9.0",
    "xterm-addon-unicode11": "^0.6.0"
  },
  "devDependencies": {
    "electron": "^28.0.0",
    "electron-builder": "^24.6.4",
    "electron-rebuild": "^3.2.9"
  }
}
```

---

## silo.config.json

This is the user-editable configuration. Ship it as a template with these defaults. See "Configuration Schema" section for field specs.

```json
{
  "scanDirs": ["~/dev", "~/projects", "~/code"],
  "pinned": [
    {
      "name": "example-web",
      "path": "~/dev/example-web",
      "icon": "🌐",
      "desc": "Example web project",
      "defaultTool": "claude"
    },
    {
      "name": "example-api",
      "path": "~/dev/example-api",
      "icon": "🔌",
      "desc": "Example API service",
      "defaultTool": "claude"
    },
    {
      "name": "example-ml",
      "path": "~/dev/example-ml",
      "icon": "🧪",
      "desc": "Example ML / research project",
      "defaultTool": "claude"
    },
    {
      "name": "silo",
      "path": "~/dev/silo",
      "icon": "◧",
      "desc": "AI coding terminal",
      "defaultTool": "claude"
    }
  ],
  "tools": {
    "claude": {
      "label": "Claude Code",
      "command": "claude",
      "icon": "◈",
      "color": "#d97706",
      "description": "Anthropic's agentic coding assistant"
    },
    "codex": {
      "label": "Codex CLI",
      "command": "codex",
      "icon": "◉",
      "color": "#22c55e",
      "description": "OpenAI's coding agent"
    },
    "autoresearch": {
      "label": "AutoResearch",
      "command": "claude",
      "icon": "🔬",
      "color": "#f59e0b",
      "description": "Autonomous ML experiment loop (Karpathy)"
    }
  },
  "terminal": {
    "fontSize": 13,
    "fontFamily": "JetBrains Mono, Fira Code, SF Mono, monospace",
    "scrollback": 10000
  }
}
```

---

## Architecture

### Process Model

| Process | Responsibility | Lifecycle |
|---------|---------------|-----------|
| Main (Node.js) | Window management, PTY spawning, file I/O, session store, project scanning, IPC handlers | App lifetime |
| Renderer (Chromium) | UI rendering, xterm.js terminal, clipboard rail, drag-drop handling | Per window |
| PTY (child process) | Real shell + AI tool execution | Per session window |

Each session window owns exactly one PTY process. When the window closes, the PTY is killed. When resumed, a new PTY is spawned in the same directory with the same tool command.

### View Flow

```
Session Manager → Project Picker → Tool Picker → Terminal
      ↑                                            |
      └──────────── home command / ← button ────────┘
```

Four views, all in a single HTML file. Routing is via `#hash`:
- `#manager` — session dashboard
- `#picker` — not in URL, navigated in-memory
- `#tool` — not in URL, navigated in-memory
- `#session:{id}` — terminal view for a specific session

---

## Session Lifecycle

Sessions move through five states:

1. **Create** → User picks project + tool → Session ID generated (`crypto.randomBytes(8).toString("hex")`), state saved, window opens, PTY spawns, tool command executed
2. **Active** → PTY I/O flowing, scrollback buffered, clipboard tracked, auto-save on every mutation (debounced 800ms)
3. **Suspended** → Window closed → PTY killed, final state saved, session appears in manager with "Resume" badge
4. **Resumed** → New window opens → scrollback replayed to xterm → new PTY spawned → tool re-launched → `── session resumed ──` marker appended
5. **Deleted** → Session data removed from electron-store

### Session Persistence Schema

| Field | Type | Cap | Notes |
|-------|------|-----|-------|
| id | string | — | `crypto.randomBytes(8).toString("hex")` = 16 hex chars |
| project | object | — | `{ name, path, icon }` |
| tool | string | — | Key into tools config |
| t0 | number | — | Creation timestamp (ms) |
| cmds | number | — | Command count (incremented on Enter) |
| scrollback | string | 100KB | Raw terminal output, last 100KB |
| history | string[] | 200 | Command strings, last 200 |
| clipItems | object[] | 15 | Clipboard entries, text capped at 50KB each |
| savedAt | number | — | Last save timestamp |

**Image data from clipboard is NOT persisted** (too large). Text clipboard items are the high-value data.

---

## PTY Spawn Sequence

1. Spawn a login shell (`$SHELL --login` or `/bin/zsh --login`) with `TERM=xterm-256color`
2. Wait 500ms for shell profile to load
3. `cd` into the project directory (path properly escaped with single quotes)
4. Wait 300ms, then execute the tool command from config (e.g., `claude`)

Environment injected: `SILO=1`, `SILO_PROJECT={name}`, `COLORTERM=truecolor`

**On resume:** PTY re-spawns fresh. Scrollback replayed into xterm.js with a `── previous output ──` / `── session resumed ──` marker pair.

---

## Clipboard Rail

Collapsible side panel (250px wide) that tracks every paste and file drop:

- **Paste events** — text over 3 chars and image pastes intercepted and logged
- **File drops** — images read as data URLs, text files read as UTF-8, both added to rail
- **Click to re-copy** — clicking any item copies it back to system clipboard

Each item shows: type badge (TXT/IMG), timestamp (HH:MM:SS), content preview (120 chars), approximate token count (chars ÷ 3.7). Max 15 items, FIFO.

When the rail toggles open/closed, the terminal should refit (`fitAddon.fit()`) after the CSS transition completes (~200ms).

---

## Project Discovery

Two mechanisms:

1. **Pinned** — from `silo.config.json` `pinned` array. Shown at top with ★ section header.
2. **Scanned** — reads directories in `scanDirs`. Any subdirectory containing a marker file is a project. Markers: `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `.git`, `Makefile`, `CMakeLists.txt`, `requirements.txt`, `setup.py`, `pom.xml`, `build.gradle`. Symlinks are skipped.

---

## Security Requirements

**These are non-negotiable. Implement all of them.**

### 1. Command Injection Prevention
- The renderer NEVER sends raw command strings. `pty:restart` accepts a tool KEY (e.g., `"claude"`), not a command.
- Tool commands are ONLY read from `silo.config.json`, validated against `/^[a-zA-Z0-9_\-./\s]+$/` on config load.
- Any tool with shell metacharacters (`;`, `|`, `` ` ``, `$()`, `&&`) in its command is rejected.

### 2. Path Traversal Prevention
- All paths go through `sanitizePath()` which resolves to absolute and confirms under `os.homedir()` or `/tmp`.
- Symlinks in scanned directories are skipped (`fs.lstatSync`).
- Session IDs validated against `/^[a-f0-9]{16}$/`.

### 3. Encrypted Session Store
- `electron-store` uses `encryptionKey` derived from machine identity: `SHA-256(hostname + username + homedir)`.

### 4. Secret Scrubbing
Before persisting scrollback or clipboard text, scrub:
- API keys: `sk-{20+ alphanum}` → `[REDACTED_API_KEY]`
- Key patterns: `key-{20+ alphanum}` → `[REDACTED_KEY]`
- Bearer tokens: `Bearer {20+ chars}` → `Bearer [REDACTED_TOKEN]`
- AWS keys: `AKIA{16 alphanumcaps}` → `[REDACTED_AWS_KEY]`
- Long hex strings: `{48+ hex chars}` → `[REDACTED_HASH]`

### 5. Environment Hardening
Strip from PTY env: `ELECTRON_RUN_AS_NODE`, `ELECTRON_NO_ASAR`, `NODE_OPTIONS`, `npm_config_token`, `GH_TOKEN`, `GITHUB_TOKEN`

### 6. Window Security
All BrowserWindows get:
```js
{
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  navigateOnDragDrop: false,
}
```
Block all navigation: `contents.on("will-navigate", e => e.preventDefault())`
Block all popups: `contents.setWindowOpenHandler(() => ({ action: "deny" }))`
Block all HTTP/HTTPS requests except `fonts.googleapis.com` and `fonts.gstatic.com`.
Block all permission requests except `clipboard-read`.

### 7. Export Safety
- Export paths validated to be under home directory
- Files written with `mode: 0o600` (owner-only)
- Filenames sanitized: `/[^a-zA-Z0-9_-]/g` removed

### 8. Input Validation
- Session IDs: `/^[a-f0-9]{16}$/`
- PTY resize: cols 1-500, rows 1-200, parseInt validated
- PTY write: must be typeof string
- Project names: truncated to 100 chars
- Icons: truncated to 4 chars

---

## IPC Contract (preload.js)

Expose on `window.silo`:

```
// Config
silo.getConfig()                    → { tools, terminal }
silo.scanProjects()                 → [{ name, path, icon, scanned }]
silo.getPinned()                    → [{ name, path, icon, desc }]

// Sessions
silo.listSessions()                → [{ id, project, tool, t0, cmds, clipCount, histCount, savedAt }]
silo.loadSession(id)               → session object or null
silo.saveSession(id, data)         → true
silo.deleteSession(id)             → true
silo.createSession({ project, tool }) → session object (also opens window + spawns PTY)
silo.resumeSession(id)             → session object (opens window or focuses existing)
silo.exportSession(id)             → true (shows native save dialog)

// PTY
silo.writePty(data)                → void (send to pty stdin)
silo.resizePty({ cols, rows })     → void
silo.restartPty(toolKey)           → true (kills old PTY, spawns new with tool from config)
silo.onPtyData(callback)           → cleanup function (PTY stdout)
silo.onPtyExit(callback)           → cleanup function (exit code)

// Window
silo.openManager()                 → void (opens/focuses manager)
silo.platform                      → string (process.platform)
```

---

## Visual Design

### Design Tokens (CSS Variables)

```css
:root {
  --bg-0: #07070e;      /* deepest background */
  --bg-1: #0b0b15;      /* panels */
  --bg-2: #10101c;      /* inputs, cards */
  --bg-3: #161628;      /* hover, active */
  --border: #1a1a2e;    /* all structural lines */
  --border-hi: #3b82f620; /* highlight border */
  --text-0: #e2e4e9;    /* primary text */
  --text-1: #9ca3af;    /* secondary */
  --text-2: #6b7280;    /* tertiary */
  --text-3: #374151;    /* muted */
  --text-4: #252536;    /* ghost */
  --accent: #3b82f6;    /* brand blue */
  --accent-dim: #3b82f612;
  --green: #22c55e;
  --yellow: #eab308;
  --red: #ef4444;
  --purple: #a78bfa;
  --font: 'JetBrains Mono', 'Fira Code', 'SF Mono', 'Cascadia Code', monospace;
}
```

### Aesthetic
- Industrial-minimal dark theme. Cold, utilitarian, information-dense.
- No gradients, no blur, no decorative elements.
- Brand mark: `◧` (Unicode half-filled square)
- Brand name: `SILO` in uppercase with 2.5px letter-spacing
- Font: JetBrains Mono everywhere (load from Google Fonts)
- Scrollbars: 4px wide, border-colored thumb
- All corners: 4-12px radius depending on element size
- Traffic light dots: macOS-style (red/yellow/green) in title bars

### xterm.js Theme
```js
{
  background: "#07070e",
  foreground: "#c8ccd4",
  cursor: "#3b82f6",
  cursorAccent: "#07070e",
  selectionBackground: "rgba(59, 130, 246, 0.18)",
  black: "#1a1a2e", red: "#ef4444", green: "#22c55e", yellow: "#eab308",
  blue: "#60a5fa", magenta: "#a78bfa", cyan: "#22d3ee", white: "#e5e7eb",
  brightBlack: "#6b7280", brightRed: "#f87171", brightGreen: "#4ade80",
  brightYellow: "#fde047", brightBlue: "#93c5fd", brightMagenta: "#c4b5fd",
  brightCyan: "#67e8f9", brightWhite: "#f9fafb",
}
```

### View Specs

**Session Manager:**
- Centered panel, 600px wide, rounded, with shadow
- Header: ◧ brand mark + "SILO" label + session count + "+ New Session" button
- Search bar (shown when >4 sessions)
- Session list: each row shows icon, project name, tool badge (colored), cmd count, clip count, time ago, hover reveals delete ✕ and "Resume" badge
- Footer: "Auto-saves every action" / "Restart anytime — zero state loss"

**Project Picker:**
- Centered panel, 520px wide
- Header: "NEW SESSION" label + "Pick a project to lock this silo" + ← Back button
- Search bar with ↑↓⏎ keyboard hint
- Project list with ★ Pinned / ~/dev section headers
- Keyboard navigation: arrows change selection (highlighted row), Enter selects, Escape goes back
- Active row gets accent color name + bg-3 background + ⏎ badge

**Tool Picker:**
- Centered panel, 440px wide
- Header: "SELECT AI TOOL" + "for {icon} {project}" subtitle
- Tool cards: large icon (40x40 with tinted background), tool name, description, `$ command` shown
- Cards are stacked vertically with 10px gap
- Click selects and launches

**Terminal View (full window):**
- Title bar (36px): ← back button, traffic light dots, center: ◧ + project name + tool badge (colored) + "locked" badge, right: ↻ Restart, ↓ Export, 📋 clipboard toggle
- Body: xterm.js terminal (flex: 1) + clipboard rail (250px, collapsible)
- Status bar (20px): left: ● green dot + project + tool + cmds + clips, right: "saved" (dim green) + elapsed time
- Drag overlay: full-window overlay with ↓ icon, "Drop to add to silo", "Images inline · Text → clipboard"

---

## Terminal Commands (renderer-side only for mockup)

The terminal connects to a real PTY via node-pty. The renderer does NOT implement shell commands — it just pipes stdin/stdout. But these status messages should appear:

- On session start: display Silo banner with project name, tool, path
- On file drop: `📎 filename (size) → clipboard` or `📄 filename (size, ~N tok) → clipboard`
- On paste track: silent (just adds to rail)
- On clip re-copy: `[clip] re-copied N chars`
- On PTY exit: `── exited (code) ── ↻ Restart to relaunch ──`
- On resume: `── previous output ──` ... scrollback ... `── session resumed ──`

---

## Configuration Schema

### Tool Definition
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| label | string | Yes | Display name |
| command | string | Yes | Shell command, validated against safe regex |
| icon | string | Yes | Single character or emoji |
| color | string | Yes | Hex color for badges |
| description | string | No | One-line description |

### Terminal Settings
| Field | Default | Description |
|-------|---------|-------------|
| fontSize | 13 | Terminal font size in pixels |
| fontFamily | JetBrains Mono, Fira Code, SF Mono, monospace | Font stack |
| scrollback | 10000 | Max scrollback lines |

---

## setup.sh

Create a bash setup script that:
1. Checks Node.js ≥18
2. Checks npm exists
3. On macOS, checks Xcode CLI tools (needed for node-pty native compilation)
4. Runs `npm install`
5. Detects which AI CLIs are installed (claude, codex)
6. Prints success message with `npm start` instruction

---

## .gitignore

```
node_modules/
dist/
out/
*.tar.gz
.DS_Store
```

---

## Key Implementation Notes

1. **No React.** DOM manipulation via `document.querySelector` and `innerHTML`. Each view is a function that renders into a container.
2. **Single HTML file** with all four view divs. Toggle visibility with a `.hidden` CSS class.
3. **CSS animations:** Use `@keyframes fadeUp` (opacity 0→1, translateY 5px→0) on view transitions.
4. **Drag region:** Title bars need `-webkit-app-region: drag` for frameless window dragging. Buttons inside need `-webkit-app-region: no-drag`.
5. **xterm.js loading:** Import from `../node_modules/xterm/` and `../node_modules/xterm-addon-fit/` etc. Load CSS from xterm too.
6. **Auto-save debounce:** Save session 800ms after last mutation. Use `clearTimeout`/`setTimeout` pattern.
7. **Clipboard rail refit:** After toggling rail, wait 200ms then call `fitAddon.fit()` so xterm resizes properly.
8. **Session ID generation:** Use `crypto.randomBytes(8).toString("hex")` for 16-char hex IDs, not timestamp-based.
9. **macOS title bar:** Use `titleBarStyle: "hiddenInset"` with `trafficLightPosition: { x: 14, y: 10 }`.

---

## What NOT to Build

- No tabs. Each session is a separate native window.
- No split panes. One terminal per window.
- No shell customization. Silo spawns whatever `$SHELL` the user has.
- No file browser. Use the clipboard rail and drag-drop.
- No settings UI. Edit `silo.config.json` directly.
- No auto-update. Ship as-is, manual updates.
- No telemetry. Nothing phones home.
