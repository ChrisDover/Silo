// Silo — Main Process
// Single-window orchestrator: side tabs, background PTYs, session persistence

const { app, BrowserWindow, ipcMain, dialog, session, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const pty = require("node-pty");
const Store = require("electron-store");
const { samplePid } = require("./resource-monitor");
const supervisor = require("./supervisor");
const gitState = require("./git-state");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SESSION_ID_RE = /^[a-f0-9]{16}$/;
const SAFE_COMMAND_RE = /^[a-zA-Z0-9_\-./\s]+$/;
const SHELL_META_RE = /[;|`$()&]/;
const SCROLLBACK_CAP = 100 * 1024; // 100 KB
const HISTORY_CAP = 200;
const CLIP_CAP = 15;
const CLIP_TEXT_CAP = 50 * 1024; // 50 KB per item
const STRIP_ENV_KEYS = [
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ASAR",
  "NODE_OPTIONS",
  "npm_config_token",
  "GH_TOKEN",
  "GITHUB_TOKEN",
];
const PROJECT_MARKERS = [
  "package.json", "Cargo.toml", "pyproject.toml", "go.mod",
  ".git", "Makefile", "CMakeLists.txt", "requirements.txt",
  "setup.py", "pom.xml", "build.gradle",
];

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------
function sanitizePath(p) {
  const expanded = p.replace(/^~/, os.homedir());
  const resolved = path.resolve(expanded);
  const home = os.homedir();
  if (!resolved.startsWith(home) && !resolved.startsWith("/tmp")) {
    throw new Error(`Path outside allowed directories: ${resolved}`);
  }
  return resolved;
}

function scrubSecrets(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED_API_KEY]")
    .replace(/key-[A-Za-z0-9]{20,}/g, "[REDACTED_KEY]")
    .replace(/Bearer\s+[^\s]{20,}/g, "Bearer [REDACTED_TOKEN]")
    .replace(/AKIA[A-Z0-9]{16}/g, "[REDACTED_AWS_KEY]")
    .replace(/[0-9a-f]{48,}/gi, "[REDACTED_HASH]");
}

function validateSessionId(id) {
  if (typeof id !== "string" || !SESSION_ID_RE.test(id)) {
    throw new Error(`Invalid session ID: ${id}`);
  }
  return id;
}

function sanitizeFilename(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, "");
}

function safeBranchName(name) {
  return String(name)
    .replace(/[^a-zA-Z0-9._/-]/g, "-")
    .replace(/\.\./g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "")
    .slice(0, 80) || "silo-worktree";
}

function createGitWorktree(project, sessionId) {
  const sourcePath = sanitizePath(project.path);
  const projectName = sanitizeFilename(project.name || path.basename(sourcePath)) || "project";
  const worktreePath = path.join(os.homedir(), ".silo", "worktrees", `${projectName}-${sessionId}`);
  const safeWorktreePath = sanitizePath(worktreePath);
  const branch = safeBranchName(`silo/${projectName}-${sessionId.slice(0, 8)}`);

  fs.mkdirSync(path.dirname(safeWorktreePath), { recursive: true });

  try {
    execFileSync("git", ["-C", sourcePath, "rev-parse", "--is-inside-work-tree"], {
      stdio: "ignore",
      timeout: 3000,
    });
    execFileSync("git", ["-C", sourcePath, "worktree", "add", "-b", branch, safeWorktreePath, "HEAD"], {
      stdio: "ignore",
      timeout: 30000,
    });
    return {
      enabled: true,
      path: safeWorktreePath,
      sourcePath,
      branch,
      error: null,
    };
  } catch (err) {
    return {
      enabled: false,
      path: sourcePath,
      sourcePath,
      branch: null,
      error: err.message || "Unable to create git worktree",
    };
  }
}

function getSessionOrThrow(id) {
  validateSessionId(id);
  const all = store.get("sessions", {});
  const sess = all[id];
  if (!sess) throw new Error("Session not found");
  return { all, sess };
}

function assertSessionWorktree(sess) {
  if (!sess.worktree || !sess.worktree.enabled || !sess.worktree.path) {
    throw new Error("Session is not using an isolated worktree");
  }
  const wtPath = sanitizePath(sess.worktree.path);
  const root = sanitizePath(path.join(os.homedir(), ".silo", "worktrees"));
  if (!wtPath.startsWith(root + path.sep)) {
    throw new Error("Worktree path is outside Silo worktree root");
  }
  return wtPath;
}

// ---------------------------------------------------------------------------
// Encryption key from machine identity
// ---------------------------------------------------------------------------
function deriveEncryptionKey() {
  const identity = `${os.hostname()}${os.userInfo().username}${os.homedir()}`;
  return crypto.createHash("sha256").update(identity).digest("hex");
}

// ---------------------------------------------------------------------------
// Config loading (user-editable path for packaged app)
// ---------------------------------------------------------------------------
function getUserConfigPath() {
  return path.join(app.getPath("userData"), "silo.config.json");
}

function getBundledConfigPath() {
  return path.join(__dirname, "..", "silo.config.json");
}

function loadConfig() {
  const userPath = getUserConfigPath();
  const bundledPath = getBundledConfigPath();

  if (!fs.existsSync(userPath) && fs.existsSync(bundledPath)) {
    try {
      fs.mkdirSync(path.dirname(userPath), { recursive: true });
      fs.copyFileSync(bundledPath, userPath);
    } catch (_) {}
  }

  const configPath = fs.existsSync(userPath) ? userPath : bundledPath;
  const raw = fs.readFileSync(configPath, "utf-8");
  const cfg = JSON.parse(raw);

  if (cfg.tools) {
    for (const [key, tool] of Object.entries(cfg.tools)) {
      if (!SAFE_COMMAND_RE.test(tool.command)) {
        console.error(`Rejecting tool "${key}": unsafe command "${tool.command}"`);
        delete cfg.tools[key];
        continue;
      }
      if (SHELL_META_RE.test(tool.command)) {
        console.error(`Rejecting tool "${key}": shell metacharacters in command`);
        delete cfg.tools[key];
      }
    }
  }

  return cfg;
}

let config = loadConfig();

// ---------------------------------------------------------------------------
// Skills loading
// ---------------------------------------------------------------------------
function getSkillsDirs() {
  // Check user data dir first, then bundled
  return [
    path.join(app.getPath("userData"), "skills"),
    path.join(__dirname, "..", "skills"),
  ];
}

function loadSkillFile(skillName) {
  if (!skillName || typeof skillName !== "string") return null;
  const safeName = skillName.replace(/[^a-zA-Z0-9_-]/g, "");
  for (const dir of getSkillsDirs()) {
    const filePath = path.join(dir, `${safeName}.md`);
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, "utf-8").trim();
      }
    } catch (_) {}
  }
  return null;
}

function loadSkillMessage(toolConfig) {
  // Skill file takes priority, fall back to inline initMessage
  if (toolConfig.skill) {
    const content = loadSkillFile(toolConfig.skill);
    if (content) return content;
  }
  return toolConfig.initMessage || null;
}

function listSkills() {
  const skills = new Map(); // name -> { name, source, preview }
  for (const dir of getSkillsDirs()) {
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const name = entry.replace(/\.md$/, "");
        if (skills.has(name)) continue; // user dir takes priority
        const content = fs.readFileSync(path.join(dir, entry), "utf-8");
        const preview = content.trim().split("\n")[0].slice(0, 120);
        skills.set(name, { name, preview, source: dir.includes("Application Support") ? "user" : "bundled" });
      }
    } catch (_) {}
  }
  return Array.from(skills.values());
}

// ---------------------------------------------------------------------------
// Session store (encrypted)
// ---------------------------------------------------------------------------
const store = new Store({
  name: "silo-sessions",
  encryptionKey: deriveEncryptionKey(),
});

// ---------------------------------------------------------------------------
// Single window + PTY tracking
// ---------------------------------------------------------------------------
let mainWindow = null;
const sessionPtys = new Map();       // sessionId -> pty process
const sessionScrollback = new Map(); // sessionId -> string (main-process buffer)
const sessionRuntime = new Map();    // sessionId -> runtime health data
let activeTabId = null;              // which session the renderer is currently showing
let monitorTimer = null;

// ---------------------------------------------------------------------------
// PTY helpers
// ---------------------------------------------------------------------------
function buildPtyEnv() {
  const env = { ...process.env };
  STRIP_ENV_KEYS.forEach((k) => delete env[k]);
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.SILO = "1";
  env.SILO_APPLE_SILICON = process.platform === "darwin" && process.arch === "arm64" ? "1" : "0";
  env.OLLAMA_FLASH_ATTENTION = env.OLLAMA_FLASH_ATTENTION || "1";
  return env;
}

function spawnPty(sessionId, projectPath, toolKey, projectName) {
  const toolConfig = config.tools[toolKey];
  if (!toolConfig) throw new Error(`Unknown tool: ${toolKey}`);
  const toolCommand = toolConfig.command;
  const shell = process.env.SHELL || "/bin/zsh";
  const env = buildPtyEnv();
  env.SILO_PROJECT = String(projectName).slice(0, 100);

  const safePath = sanitizePath(projectPath);

  const ptyProc = pty.spawn(shell, ["--login"], {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd: os.homedir(),
    env,
  });

  sessionPtys.set(sessionId, ptyProc);
  sessionScrollback.set(sessionId, "");
  sessionRuntime.set(sessionId, {
    pid: ptyProc.pid,
    startedAt: Date.now(),
    lastOutputAt: Date.now(),
    exited: false,
    exitCode: null,
    resource: { cpu: 0, memMb: 0, state: "new" },
    health: {
      state: "running",
      reason: "The session started.",
      action: "Watch",
      risk: "low",
    },
  });

  // cd into project directory after shell profile loads
  setTimeout(() => {
    if (ptyProc.pid) {
      ptyProc.write(`cd '${safePath.replace(/'/g, "'\\''")}'\r`);
    }
  }, 500);

  // Execute tool command after cd
  setTimeout(() => {
    if (ptyProc.pid) {
      ptyProc.write(`${toolCommand}\r`);
    }
  }, 800);

  // Load skill file or initMessage and send after tool starts
  const initMsg = loadSkillMessage(toolConfig);
  if (initMsg) {
    setTimeout(() => {
      if (ptyProc.pid) {
        ptyProc.write(`${initMsg}\r`);
      }
    }, 3000);
  }

  // PTY output: buffer in main process, forward to renderer only if this is the active tab
  ptyProc.onData((data) => {
    const prev = sessionScrollback.get(sessionId) || "";
    sessionScrollback.set(sessionId, (prev + data).slice(-SCROLLBACK_CAP));
    const runtime = sessionRuntime.get(sessionId);
    if (runtime) {
      runtime.lastOutputAt = Date.now();
      runtime.exited = false;
    }

    if (mainWindow && !mainWindow.isDestroyed() && activeTabId === sessionId) {
      mainWindow.webContents.send("pty:data", sessionId, data);
    }
  });

  ptyProc.onExit(({ exitCode }) => {
    const runtime = sessionRuntime.get(sessionId);
    if (runtime) {
      runtime.exited = true;
      runtime.exitCode = exitCode;
      runtime.health = {
        state: "dead",
        reason: "The process exited.",
        action: "Restart",
        risk: "low",
      };
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("pty:exit", sessionId, exitCode);
      mainWindow.webContents.send("session:status", sessionId, getSessionStatus(sessionId));
    }
    sessionPtys.delete(sessionId);
  });

  return ptyProc;
}

function killPty(sessionId) {
  const p = sessionPtys.get(sessionId);
  if (p) {
    try { p.kill(); } catch (_) {}
    sessionPtys.delete(sessionId);
  }
  const runtime = sessionRuntime.get(sessionId);
  if (runtime) {
    runtime.exited = true;
    runtime.health = {
      state: "dead",
      reason: "The process was stopped.",
      action: "Restart",
      risk: "low",
    };
  }
}

function getSessionStatus(sessionId) {
  const runtime = sessionRuntime.get(sessionId) || {};
  const health = runtime.health || {
    state: sessionPtys.has(sessionId) ? "running" : "idle",
    reason: sessionPtys.has(sessionId) ? "The session is active." : "The session is not running.",
    action: sessionPtys.has(sessionId) ? "Watch" : "Resume",
    risk: "low",
  };
  return {
    id: sessionId,
    running: sessionPtys.has(sessionId),
    pid: runtime.pid || null,
    startedAt: runtime.startedAt || null,
    lastOutputAt: runtime.lastOutputAt || null,
    exited: Boolean(runtime.exited),
    exitCode: runtime.exitCode ?? null,
    resource: runtime.resource || { cpu: 0, memMb: 0, state: "unknown" },
    git: runtime.git || null,
    health: {
      ...health,
      resource: runtime.resource || { cpu: 0, memMb: 0, state: "unknown" },
      git: runtime.git || null,
    },
  };
}

async function refreshSessionStatuses() {
  const all = store.get("sessions", {});
  for (const [id, ptyProc] of sessionPtys) {
    const sess = all[id];
    const runtime = sessionRuntime.get(id) || {};
    const resource = await samplePid(ptyProc.pid);
    const git = sess ? await gitState.getGitSummary(sess.project.path) : null;
    runtime.pid = ptyProc.pid;
    runtime.resource = resource;
    runtime.git = git;
    runtime.health = supervisor.classifySession({
      exited: runtime.exited || resource.state === "dead",
      lastOutputAt: runtime.lastOutputAt,
      scrollback: sessionScrollback.get(id) || (sess && sess.scrollback) || "",
      resource,
      git,
    });
    sessionRuntime.set(id, runtime);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("session:status", id, getSessionStatus(id));
    }
  }
}

function startResourceMonitor() {
  if (monitorTimer) return;
  monitorTimer = setInterval(() => {
    refreshSessionStatuses().catch((err) => console.error("status refresh failed", err));
  }, 3500);
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------
function flushSessionToStore(sessionId, rendererData) {
  const all = store.get("sessions", {});
  const sess = all[sessionId];
  if (!sess) return;

  const scrollback = (rendererData && rendererData.scrollback)
    ? rendererData.scrollback
    : (sessionScrollback.get(sessionId) || sess.scrollback || "");

  sess.scrollback = scrubSecrets(
    typeof scrollback === "string" ? scrollback.slice(-SCROLLBACK_CAP) : ""
  );

  if (rendererData) {
    if (rendererData.history) sess.history = rendererData.history.slice(-HISTORY_CAP);
    if (rendererData.clipItems) {
      sess.clipItems = rendererData.clipItems.slice(-CLIP_CAP).map((item) => ({
        ...item,
        text: item.text ? scrubSecrets(String(item.text).slice(0, CLIP_TEXT_CAP)) : undefined,
      }));
    }
    if (typeof rendererData.cmds === "number") sess.cmds = rendererData.cmds;
  }

  sess.savedAt = Date.now();
  all[sessionId] = sess;
  store.set("sessions", all);
}

function flushAllSessions() {
  for (const [id] of sessionPtys) {
    flushSessionToStore(id, null);
  }
}

// ---------------------------------------------------------------------------
// Window creation (single window)
// ---------------------------------------------------------------------------
function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 750,
    minWidth: 700,
    minHeight: 450,
    backgroundColor: "#07070e",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 10 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
    },
  });

  mainWindow.webContents.on("will-navigate", (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.on("close", () => {
    flushAllSessions();
  });

  mainWindow.on("closed", () => {
    for (const [id] of sessionPtys) killPty(id);
    sessionScrollback.clear();
    sessionRuntime.clear();
    mainWindow = null;
    activeTabId = null;
  });

  return mainWindow;
}

// ---------------------------------------------------------------------------
// Project discovery
// ---------------------------------------------------------------------------
function scanProjects() {
  const results = [];
  const dirs = (config.scanDirs || []).map((d) => d.replace(/^~/, os.homedir()));

  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const stat = fs.lstatSync(path.join(dir, entry.name));
        if (stat.isSymbolicLink()) continue;
      } catch (_) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      const hasMarker = PROJECT_MARKERS.some((m) => {
        try { return fs.existsSync(path.join(fullPath, m)); } catch (_) { return false; }
      });
      if (hasMarker) {
        results.push({
          name: entry.name.slice(0, 100),
          path: fullPath,
          icon: "",
          scanned: true,
        });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

// Config
ipcMain.handle("config:get", () => ({
  tools: config.tools,
  terminal: config.terminal,
  localModel: config.localModel || {},
  cloud: config.cloud || {},
  performance: config.performance || {},
}));

ipcMain.handle("config:scanProjects", () => scanProjects());

ipcMain.handle("config:getPinned", () =>
  (config.pinned || []).map((p) => ({
    name: String(p.name).slice(0, 100),
    path: p.path,
    icon: String(p.icon || "").slice(0, 4),
    desc: p.desc || "",
    defaultTool: p.defaultTool || "",
  }))
);

// Skills
ipcMain.handle("skills:list", () => listSkills());
ipcMain.handle("skills:load", (_e, name) => loadSkillFile(name));

// Folder picker
ipcMain.handle("dialog:pickFolder", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "Choose project folder",
    defaultPath: os.homedir(),
  });
  if (canceled || !filePaths.length) return null;
  const picked = filePaths[0];
  const name = path.basename(picked);
  return { name, path: picked, icon: "", scanned: false };
});

// New project: pick parent dir, create subfolder
ipcMain.handle("dialog:newProject", async (_e, projectName) => {
  if (!projectName || typeof projectName !== "string") return null;
  const safeName = projectName.replace(/[^a-zA-Z0-9_\-. ]/g, "").slice(0, 100);
  if (!safeName) return null;

  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: `Choose where to create "${safeName}"`,
    defaultPath: os.homedir(),
    buttonLabel: "Create Here",
  });
  if (canceled || !filePaths.length) return null;

  const parentDir = filePaths[0];
  const projectDir = path.join(parentDir, safeName);

  // Create the directory if it doesn't exist
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }

  return { name: safeName, path: projectDir, icon: "", scanned: false };
});

// Sessions
ipcMain.handle("session:list", () => {
  const all = store.get("sessions", {});
  return Object.values(all).map((s) => {
    // Extract last meaningful line from scrollback as preview
    let preview = "";
    if (s.scrollback) {
      // Strip ANSI escape codes and get last non-empty lines
      const clean = s.scrollback.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\r/g, "");
      const lines = clean.split("\n").map((l) => l.trim()).filter((l) => l.length > 2);
      preview = (lines[lines.length - 1] || "").slice(0, 120);
    }
    const status = getSessionStatus(s.id);
    return {
      id: s.id,
      project: s.project,
      worktree: s.worktree || null,
      tool: s.tool,
      label: s.label || "",
      t0: s.t0,
      cmds: s.cmds || 0,
      clipCount: (s.clipItems || []).length,
      histCount: (s.history || []).length,
      savedAt: s.savedAt,
      preview,
      status,
      cloudTokens: s.cloudTokens || 0,
      cloudCents: s.cloudCents || 0,
    };
  });
});

ipcMain.handle("session:rename", (_e, id, label) => {
  validateSessionId(id);
  const all = store.get("sessions", {});
  if (!all[id]) return false;
  all[id].label = String(label || "").slice(0, 100);
  store.set("sessions", all);
  return true;
});

ipcMain.handle("session:load", (_e, id) => {
  validateSessionId(id);
  const all = store.get("sessions", {});
  return all[id] || null;
});

ipcMain.handle("session:save", (_e, id, data) => {
  validateSessionId(id);

  if (data.scrollback) {
    data.scrollback = scrubSecrets(
      typeof data.scrollback === "string"
        ? data.scrollback.slice(-SCROLLBACK_CAP)
        : ""
    );
  }
  if (data.history) {
    data.history = data.history.slice(-HISTORY_CAP);
  }
  if (data.clipItems) {
    data.clipItems = data.clipItems.slice(-CLIP_CAP).map((item) => ({
      ...item,
      text: item.text ? scrubSecrets(String(item.text).slice(0, CLIP_TEXT_CAP)) : undefined,
    }));
  }
  data.savedAt = Date.now();

  const all = store.get("sessions", {});
  all[id] = { ...all[id], ...data, id };
  store.set("sessions", all);
  return true;
});

ipcMain.handle("session:delete", (_e, id) => {
  validateSessionId(id);
  const all = store.get("sessions", {});
  delete all[id];
  store.set("sessions", all);
  killPty(id);
  sessionScrollback.delete(id);
  return true;
});

ipcMain.handle("session:create", (_e, { project, tool, worktree }) => {
  const id = crypto.randomBytes(8).toString("hex");
  const toolConfig = config.tools[tool];
  if (!toolConfig) throw new Error(`Unknown tool: ${tool}`);
  const worktreeInfo = worktree ? createGitWorktree(project, id) : null;
  const launchPath = worktreeInfo ? worktreeInfo.path : project.path;

  const sess = {
    id,
    project: {
      name: String(project.name).slice(0, 100),
      path: launchPath,
      sourcePath: worktreeInfo ? worktreeInfo.sourcePath : project.path,
      icon: String(project.icon || "").slice(0, 4),
    },
    worktree: worktreeInfo,
    tool,
    t0: Date.now(),
    cmds: 0,
    scrollback: "",
    history: [],
    clipItems: [],
    savedAt: Date.now(),
  };

  const all = store.get("sessions", {});
  all[id] = sess;
  store.set("sessions", all);

  spawnPty(id, launchPath, tool, project.name);

  return sess;
});

ipcMain.handle("session:resume", (_e, id) => {
  validateSessionId(id);
  const all = store.get("sessions", {});
  const sess = all[id];
  if (!sess) return null;

  // If PTY already running, just return the session
  if (sessionPtys.has(id)) return sess;

  if (!config.tools[sess.tool]) throw new Error(`Unknown tool: ${sess.tool}`);

  // Clear old scrollback — new PTY starts fresh
  sessionScrollback.set(id, "");

  spawnPty(id, sess.project.path, sess.tool, sess.project.name);
  return sess;
});

ipcMain.handle("session:export", async (_e, id) => {
  validateSessionId(id);
  const all = store.get("sessions", {});
  const sess = all[id];
  if (!sess) throw new Error("Session not found");

  const safeName = sanitizeFilename(`silo-${sess.project.name}-${id.slice(0, 8)}`);
  const { filePath } = await dialog.showSaveDialog({
    defaultPath: path.join(os.homedir(), `${safeName}.txt`),
    filters: [{ name: "Text", extensions: ["txt"] }],
  });

  if (!filePath) return false;

  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(os.homedir())) {
    throw new Error("Export path must be under home directory");
  }

  const content = [
    `SILO SESSION EXPORT`,
    `Project: ${sess.project.name}`,
    `Tool: ${sess.tool}`,
    `Created: ${new Date(sess.t0).toISOString()}`,
    `Commands: ${sess.cmds}`,
    `---`,
    sess.scrollback || "(no scrollback)",
    `---`,
    `Command History:`,
    ...(sess.history || []).map((h, i) => `  ${i + 1}. ${h}`),
  ].join("\n");

  fs.writeFileSync(resolved, content, { mode: 0o600 });
  return true;
});

// Tab switching
ipcMain.handle("tab:switch", (_e, id) => {
  validateSessionId(id);
  activeTabId = id;
  // Return the main-process scrollback so renderer can replay it
  return sessionScrollback.get(id) || "";
});

ipcMain.handle("tab:getActive", () => activeTabId);

ipcMain.handle("tab:close", (_e, id) => {
  validateSessionId(id);
  flushSessionToStore(id, null);
  killPty(id);
  sessionScrollback.delete(id);
  if (activeTabId === id) activeTabId = null;
  return true;
});

// List active (running) tabs
ipcMain.handle("tab:listActive", () => {
  return Array.from(sessionPtys.keys());
});

ipcMain.handle("status:list", () => {
  const all = store.get("sessions", {});
  return Object.keys(all).map((id) => getSessionStatus(id));
});

ipcMain.handle("git:summary", async (_e, id) => {
  validateSessionId(id);
  const all = store.get("sessions", {});
  const sess = all[id];
  if (!sess) throw new Error("Session not found");
  return gitState.getGitSummary(sess.project.path);
});

ipcMain.handle("git:diffPreview", async (_e, id) => {
  validateSessionId(id);
  const all = store.get("sessions", {});
  const sess = all[id];
  if (!sess) throw new Error("Session not found");
  return gitState.getDiffPreview(sess.project.path);
});

ipcMain.handle("worktree:open", async (_e, id) => {
  const { sess } = getSessionOrThrow(id);
  const wtPath = assertSessionWorktree(sess);
  await shell.openPath(wtPath);
  return true;
});

ipcMain.handle("worktree:keep", (_e, id) => {
  const { all, sess } = getSessionOrThrow(id);
  assertSessionWorktree(sess);
  sess.worktree.kept = true;
  sess.worktree.keptAt = Date.now();
  sess.savedAt = Date.now();
  all[id] = sess;
  store.set("sessions", all);
  return sess.worktree;
});

ipcMain.handle("worktree:delete", (_e, id) => {
  const { all, sess } = getSessionOrThrow(id);
  const wtPath = assertSessionWorktree(sess);
  killPty(id);

  try {
    execFileSync("git", ["-C", sess.worktree.sourcePath || sess.project.sourcePath, "worktree", "remove", wtPath], {
      stdio: "ignore",
      timeout: 30000,
    });
  } catch (err) {
    throw new Error(`Unable to remove worktree. Commit, stash, or clean changes first. ${err.message}`);
  }

  sess.worktree.enabled = false;
  sess.worktree.deleted = true;
  sess.worktree.deletedAt = Date.now();
  sess.project.path = sess.worktree.sourcePath || sess.project.sourcePath || sess.project.path;
  sess.savedAt = Date.now();
  all[id] = sess;
  store.set("sessions", all);
  return sess.worktree;
});

ipcMain.handle("worktree:merge", async (_e, id) => {
  const { all, sess } = getSessionOrThrow(id);
  const wtPath = assertSessionWorktree(sess);
  const sourcePath = sanitizePath(sess.worktree.sourcePath || sess.project.sourcePath);
  const sourceGit = await gitState.getGitSummary(sourcePath);
  if (sourceGit.ok && sourceGit.changed > 0) {
    throw new Error(`Source checkout is not clean: ${sourceGit.summary}`);
  }

  const branch = sess.worktree.branch;
  if (!branch) throw new Error("Worktree branch is unknown");

  try {
    execFileSync("git", ["-C", wtPath, "status", "--short"], { stdio: "ignore", timeout: 5000 });
    execFileSync("git", ["-C", sourcePath, "merge", "--no-ff", branch], {
      stdio: "ignore",
      timeout: 60000,
    });
  } catch (err) {
    throw new Error(`Merge failed. Resolve manually in the source checkout. ${err.message}`);
  }

  sess.worktree.merged = true;
  sess.worktree.mergedAt = Date.now();
  sess.savedAt = Date.now();
  all[id] = sess;
  store.set("sessions", all);
  return {
    merged: true,
    sourcePath,
    branch,
    mergedAt: sess.worktree.mergedAt,
  };
});

ipcMain.handle("supervisor:doctor", async (_e, id) => {
  validateSessionId(id);
  const all = store.get("sessions", {});
  const sess = all[id];
  if (!sess) throw new Error("Session not found");
  const health = getSessionStatus(id).health;
  return supervisor.doctor({
    session: sess,
    health,
    scrollback: sessionScrollback.get(id) || sess.scrollback || "",
    localModel: config.localModel || {},
  });
});

ipcMain.handle("supervisor:contextPacket", async (_e, id, budget) => {
  validateSessionId(id);
  const all = store.get("sessions", {});
  const sess = all[id];
  if (!sess) throw new Error("Session not found");
  return supervisor.buildContextPacket({
    session: sess,
    health: getSessionStatus(id).health,
    scrollback: sessionScrollback.get(id) || sess.scrollback || "",
    git: await gitState.getGitSummary(sess.project.path),
    budget,
  });
});

// Synchronous save from renderer's beforeunload
ipcMain.on("session:saveSync", (e, id, data) => {
  try {
    validateSessionId(id);
    flushSessionToStore(id, data);
    e.returnValue = true;
  } catch (_) {
    e.returnValue = false;
  }
});

// PTY — now takes explicit sessionId from renderer
ipcMain.on("pty:write", (_e, sessionId, data) => {
  if (typeof data !== "string" || typeof sessionId !== "string") return;
  const p = sessionPtys.get(sessionId);
  if (p) p.write(data);
});

ipcMain.on("pty:resize", (_e, sessionId, { cols, rows }) => {
  const c = Math.max(1, Math.min(500, parseInt(cols, 10) || 120));
  const r = Math.max(1, Math.min(200, parseInt(rows, 10) || 30));
  if (typeof sessionId !== "string") return;
  const p = sessionPtys.get(sessionId);
  if (p) p.resize(c, r);
});

ipcMain.handle("pty:restart", (_e, sessionId, toolKey) => {
  validateSessionId(sessionId);
  if (typeof toolKey !== "string") throw new Error("Invalid tool key");
  const toolConfig = config.tools[toolKey];
  if (!toolConfig) throw new Error(`Unknown tool: ${toolKey}`);

  killPty(sessionId);

  const all = store.get("sessions", {});
  const sess = all[sessionId];
  if (!sess) throw new Error("Session not found");

  sess.tool = toolKey;
  sess.savedAt = Date.now();
  all[sessionId] = sess;
  store.set("sessions", all);

  spawnPty(sessionId, sess.project.path, toolKey, sess.project.name);
  return true;
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => {
    cb(perm === "clipboard-read");
  });

  session.defaultSession.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, cb) => {
    const url = details.url;
    if (
      url.startsWith("file://") ||
      url.startsWith("devtools://") ||
      url.includes("fonts.googleapis.com") ||
      url.includes("fonts.gstatic.com")
    ) {
      cb({});
    } else {
      cb({ cancel: true });
    }
  });

  createMainWindow();
  startResourceMonitor();
});

app.on("before-quit", () => {
  flushAllSessions();
  if (monitorTimer) clearInterval(monitorTimer);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});
