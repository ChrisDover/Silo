// Silo — Preload (context-isolated IPC bridge)
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("silo", {
  // Config
  getConfig: () => ipcRenderer.invoke("config:get"),
  scanProjects: () => ipcRenderer.invoke("config:scanProjects"),
  getPinned: () => ipcRenderer.invoke("config:getPinned"),

  // Skills
  listSkills: () => ipcRenderer.invoke("skills:list"),
  loadSkill: (name) => ipcRenderer.invoke("skills:load", name),

  // Folder picker
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  newProject: (name) => ipcRenderer.invoke("dialog:newProject", name),

  // Sessions
  listSessions: () => ipcRenderer.invoke("session:list"),
  loadSession: (id) => ipcRenderer.invoke("session:load", id),
  saveSession: (id, data) => ipcRenderer.invoke("session:save", id, data),
  deleteSession: (id) => ipcRenderer.invoke("session:delete", id),
  createSession: (opts) => ipcRenderer.invoke("session:create", opts),
  resumeSession: (id) => ipcRenderer.invoke("session:resume", id),
  exportSession: (id) => ipcRenderer.invoke("session:export", id),
  renameSession: (id, label) => ipcRenderer.invoke("session:rename", id, label),

  // Tabs
  switchTab: (id) => ipcRenderer.invoke("tab:switch", id),
  getActiveTab: () => ipcRenderer.invoke("tab:getActive"),
  closeTab: (id) => ipcRenderer.invoke("tab:close", id),
  listActiveTabs: () => ipcRenderer.invoke("tab:listActive"),

  // PTY — explicit sessionId
  writePty: (sessionId, data) => ipcRenderer.send("pty:write", sessionId, data),
  resizePty: (sessionId, size) => ipcRenderer.send("pty:resize", sessionId, size),
  restartPty: (sessionId, toolKey) => ipcRenderer.invoke("pty:restart", sessionId, toolKey),
  onPtyData: (cb) => {
    const handler = (_e, sessionId, data) => cb(sessionId, data);
    ipcRenderer.on("pty:data", handler);
    return () => ipcRenderer.removeListener("pty:data", handler);
  },
  onPtyExit: (cb) => {
    const handler = (_e, sessionId, code) => cb(sessionId, code);
    ipcRenderer.on("pty:exit", handler);
    return () => ipcRenderer.removeListener("pty:exit", handler);
  },

  // Sync save for beforeunload
  flushSave: (id, data) => ipcRenderer.sendSync("session:saveSync", id, data),

  // Platform
  platform: process.platform,
});
