// Silo — Renderer Process
// Single-window orchestrator: side tabs, background PTYs, tab switching

(function () {
  "use strict";

  // ── State ──────────────────────────────────────────────────────────────
  let config = null;
  let term = null;
  let fitAddon = null;
  let cleanupPtyData = null;
  let cleanupPtyExit = null;
  let saveTimer = null;
  let elapsedTimer = null;

  // Active tab state
  let activeTabId = null;
  let scrollbackBuffer = "";
  let clipItems = [];
  let cmdHistory = [];
  let cmdCount = 0;

  // All open tabs: Map<sessionId, { session, scrollback, clipItems, cmdHistory, cmdCount }>
  const openTabs = new Map();

  // Picker state
  let selectedProject = null;
  let pickerIndex = 0;
  let allProjects = [];

  // ── Views ──────────────────────────────────────────────────────────────
  const views = {
    home: document.getElementById("view-home"),
    picker: document.getElementById("view-picker"),
    tool: document.getElementById("view-tool"),
    terminal: document.getElementById("view-terminal"),
  };

  function showView(name) {
    for (const [, el] of Object.entries(views)) {
      el.classList.add("hidden");
    }
    const target = views[name];
    if (target) target.classList.remove("hidden");
  }

  // ── Helpers ────────────────────────────────────────────────────────────
  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function readableTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (isToday) return `Today ${time}`;
    if (isYesterday) return `Yesterday ${time}`;
    return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
  }

  function elapsed(t0) {
    const s = Math.floor((Date.now() - t0) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${m}:${String(sec).padStart(2, "0")}`;
  }

  function tokenEstimate(text) {
    return Math.round((text || "").length / 3.7);
  }

  function timeStamp() {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── Debounced auto-save ────────────────────────────────────────────────
  function scheduleSave() {
    if (!activeTabId) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (!activeTabId) return;
      await window.silo.saveSession(activeTabId, {
        scrollback: scrollbackBuffer,
        history: cmdHistory,
        clipItems,
        cmds: cmdCount,
      });
      const el = document.getElementById("status-saved");
      if (el) el.textContent = "saved";
    }, 800);
  }

  // ── Tab state management ───────────────────────────────────────────────
  function stashCurrentTab() {
    if (!activeTabId || !openTabs.has(activeTabId)) return;
    const tab = openTabs.get(activeTabId);
    tab.scrollback = scrollbackBuffer;
    tab.clipItems = [...clipItems];
    tab.cmdHistory = [...cmdHistory];
    tab.cmdCount = cmdCount;
  }

  function restoreTabState(id) {
    const tab = openTabs.get(id);
    if (tab) {
      scrollbackBuffer = tab.scrollback || "";
      clipItems = tab.clipItems || [];
      cmdHistory = tab.cmdHistory || [];
      cmdCount = tab.cmdCount || 0;
    } else {
      scrollbackBuffer = "";
      clipItems = [];
      cmdHistory = [];
      cmdCount = 0;
    }
  }

  // ── Side tab rendering ─────────────────────────────────────────────────
  function renderSideTabs() {
    const list = document.getElementById("tab-list");
    list.innerHTML = "";

    for (const [id, tab] of openTabs) {
      const sess = tab.session;
      const toolCfg = (config && config.tools[sess.tool]) || {};
      const color = toolCfg.color || "#6b7280";
      const icon = sess.project.icon || toolCfg.icon || "◧";
      const isActive = id === activeTabId;

      const el = document.createElement("div");
      el.className = `side-tab${isActive ? " active" : ""}`;
      el.dataset.id = id;
      el.innerHTML = `
        <span class="side-tab-icon" style="color:${color}">${icon}</span>
        <span class="side-tab-status${tab.exited ? " exited" : ""}"></span>
        <button class="side-tab-close" data-close="${id}">✕</button>
        <div class="side-tab-tooltip">
          <div class="side-tab-tooltip-name">${escapeHtml(sess.project.name)}</div>
          <div class="side-tab-tooltip-tool">${toolCfg.label || sess.tool}</div>
        </div>
      `;

      el.addEventListener("click", (e) => {
        if (e.target.closest(".side-tab-close")) return;
        switchToTab(id);
      });

      const closeBtn = el.querySelector(".side-tab-close");
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTab(id);
      });

      list.appendChild(el);
    }
  }

  // ── Tab operations ─────────────────────────────────────────────────────
  async function switchToTab(id) {
    if (id === activeTabId) return;

    // Stash current tab
    stashCurrentTab();

    // Tell main process which tab is active
    const mainScrollback = await window.silo.switchTab(id);

    activeTabId = id;
    restoreTabState(id);

    // If local scrollback is empty but main has data, use main's
    if (!scrollbackBuffer && mainScrollback) {
      scrollbackBuffer = mainScrollback;
      const tab = openTabs.get(id);
      if (tab) tab.scrollback = mainScrollback;
    }

    showView("terminal");
    renderSideTabs();
    setupTerminalForTab(id);
  }

  async function closeTab(id) {
    // Save before closing
    const tab = openTabs.get(id);
    if (tab) {
      if (id === activeTabId) stashCurrentTab();
      await window.silo.saveSession(id, {
        scrollback: tab.scrollback || "",
        history: tab.cmdHistory || [],
        clipItems: tab.clipItems || [],
        cmds: tab.cmdCount || 0,
      });
    }

    await window.silo.closeTab(id);
    openTabs.delete(id);

    if (activeTabId === id) {
      activeTabId = null;
      // Switch to another tab or show home
      const remaining = Array.from(openTabs.keys());
      if (remaining.length > 0) {
        await switchToTab(remaining[remaining.length - 1]);
      } else {
        showView("home");
        await renderHome();
      }
    }

    renderSideTabs();
  }

  // ── Terminal setup ─────────────────────────────────────────────────────
  function setupTerminalForTab(id) {
    const tab = openTabs.get(id);
    if (!tab) return;
    const sess = tab.session;
    const toolCfg = (config && config.tools[sess.tool]) || {};

    // Header
    document.getElementById("term-project-name").textContent = sess.project.name;
    const badge = document.getElementById("term-tool-badge");
    badge.textContent = toolCfg.label || sess.tool;
    badge.style.background = `${toolCfg.color || "#6b7280"}20`;
    badge.style.color = toolCfg.color || "#6b7280";

    // Status bar
    document.getElementById("status-project").textContent = sess.project.name;
    document.getElementById("status-tool").textContent = toolCfg.label || sess.tool;
    updateStatusCounts();

    // Ensure xterm exists
    ensureTerminal();

    // Clear and replay scrollback
    term.clear();
    term.reset();
    if (scrollbackBuffer) {
      term.write(scrollbackBuffer);
    }

    // Refit and lock to bottom
    fitAddon.fit();
    term.scrollToBottom();

    // Resize PTY to match
    const { cols, rows } = term;
    window.silo.resizePty(id, { cols, rows });

    // Update elapsed timer
    clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => {
      const el = document.getElementById("status-elapsed");
      if (el && activeTabId) {
        const t = openTabs.get(activeTabId);
        if (t) el.textContent = elapsed(t.session.t0);
      }
    }, 1000);

    // Clipboard rail
    renderClipRail();

    term.focus();
  }

  function ensureTerminal() {
    if (term) return;

    const container = document.getElementById("terminal-container");
    container.innerHTML = "";

    const termConfig = (config && config.terminal) || {};
    term = new Terminal({
      fontFamily: termConfig.fontFamily || "JetBrains Mono, monospace",
      fontSize: termConfig.fontSize || 13,
      scrollback: termConfig.scrollback || 10000,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
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
      },
    });

    fitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    const unicode11Addon = new Unicode11Addon.Unicode11Addon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(unicode11Addon);
    term.unicode.activeVersion = "11";

    term.open(container);
    fitAddon.fit();

    // Keep terminal pinned to bottom unless user scrolls up intentionally
    let userScrolledUp = false;
    term.onScroll(() => {
      const buf = term.buffer.active;
      const atBottom = buf.viewportY >= buf.baseY;
      userScrolledUp = !atBottom;
    });
    // When new content arrives, snap back to bottom
    term.onWriteParsed(() => {
      userScrolledUp = false;
    });
    // After any reflow/resize, restore bottom position
    term.onRender(() => {
      if (!userScrolledUp) {
        term.scrollToBottom();
      }
    });

    // Shift+Enter: send kitty keyboard protocol sequence so Claude Code treats it as newline
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        if (activeTabId) window.silo.writePty(activeTabId, "\x1b[13;2u");
        return false;
      }
      return true;
    });

    // Terminal input → PTY (routed to active tab)
    term.onData((data) => {
      if (!activeTabId) return;
      window.silo.writePty(activeTabId, data);
      if (data === "\r" || data === "\n") {
        cmdCount++;
        updateStatusCounts();
        scheduleSave();
      }
    });

    // Resize — refit terminal, keep scroll at bottom
    term.onResize(({ cols, rows }) => {
      if (activeTabId) window.silo.resizePty(activeTabId, { cols, rows });
    });
    window.addEventListener("resize", () => {
      if (fitAddon) {
        fitAddon.fit();
        term.scrollToBottom();
      }
    });

    // PTY data from main process → terminal (only for active tab)
    cleanupPtyData = window.silo.onPtyData((sessionId, data) => {
      // Buffer in local tab state
      const tab = openTabs.get(sessionId);
      if (tab) {
        tab.scrollback = ((tab.scrollback || "") + data).slice(-102400);
      }

      // Write to terminal only if this is the active tab
      if (sessionId === activeTabId) {
        scrollbackBuffer += data;
        if (scrollbackBuffer.length > 102400) {
          scrollbackBuffer = scrollbackBuffer.slice(-102400);
        }
        term.write(data);
        scheduleSave();
      }
    });

    cleanupPtyExit = window.silo.onPtyExit((sessionId, code) => {
      const tab = openTabs.get(sessionId);
      if (tab) tab.exited = true;
      renderSideTabs();
      if (sessionId === activeTabId && term) {
        term.write(`\r\n\x1b[2m── exited (${code}) ── ↻ Restart to relaunch ──\x1b[0m\r\n`);
      }
    });

    // Setup paste/drag tracking
    setupPasteTracking();
    setupDragDrop();
  }

  // ── Status bar ─────────────────────────────────────────────────────────
  function updateStatusCounts() {
    const cmdsEl = document.getElementById("status-cmds");
    const clipsEl = document.getElementById("status-clips");
    if (cmdsEl) cmdsEl.textContent = `${cmdCount} cmds`;
    if (clipsEl) clipsEl.textContent = `${clipItems.length} clips`;
  }

  // ── Clipboard rail ─────────────────────────────────────────────────────
  function renderClipRail() {
    const countEl = document.getElementById("clip-count");
    if (countEl) countEl.textContent = String(clipItems.length);

    const container = document.getElementById("clip-items");
    if (!container) return;

    container.innerHTML = clipItems
      .slice()
      .reverse()
      .map(
        (item, i) => `<div class="clip-item" data-idx="${clipItems.length - 1 - i}">
        <div class="clip-item-header">
          <span class="clip-type-badge">${item.type === "img" ? "IMG" : "TXT"}</span>
          <span class="clip-time">${item.time || ""}</span>
        </div>
        <div class="clip-preview">${escapeHtml((item.text || "").slice(0, 120))}</div>
        <div class="clip-tokens">~${tokenEstimate(item.text)} tok</div>
      </div>`
      )
      .join("");

    container.querySelectorAll(".clip-item").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.dataset.idx, 10);
        const item = clipItems[idx];
        if (item && item.text) {
          navigator.clipboard.writeText(item.text).then(() => {
            if (term) term.write(`\r\n\x1b[2m[clip] re-copied ${item.text.length} chars\x1b[0m\r\n`);
          });
        }
      });
    });

    updateStatusCounts();
  }

  function addClipItem(type, text) {
    clipItems.push({
      type,
      text: (text || "").slice(0, 51200),
      time: timeStamp(),
    });
    if (clipItems.length > 15) clipItems.shift();
    renderClipRail();
    scheduleSave();
  }

  function setupPasteTracking() {
    document.addEventListener("paste", (e) => {
      if (!activeTabId) return;
      const text = e.clipboardData.getData("text/plain");
      if (text && text.length > 3) addClipItem("txt", text);
      for (const item of e.clipboardData.items) {
        if (item.type.startsWith("image/")) addClipItem("img", `[image: ${item.type}]`);
      }
    });
  }

  function setupDragDrop() {
    const overlay = document.getElementById("drag-overlay");
    const termView = document.getElementById("view-terminal");
    let dragCounter = 0;

    termView.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dragCounter++;
      overlay.classList.remove("hidden");
    });
    termView.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) { dragCounter = 0; overlay.classList.add("hidden"); }
    });
    termView.addEventListener("dragover", (e) => e.preventDefault());
    termView.addEventListener("drop", (e) => {
      e.preventDefault();
      dragCounter = 0;
      overlay.classList.add("hidden");

      for (const file of e.dataTransfer.files) {
        const size = file.size < 1024 ? `${file.size}B` : `${Math.round(file.size / 1024)}KB`;
        if (file.type.startsWith("image/")) {
          addClipItem("img", `[image: ${file.name}]`);
          if (term) term.write(`\r\n\x1b[2m📎 ${file.name} (${size}) → clipboard\x1b[0m\r\n`);
        } else {
          const reader = new FileReader();
          reader.onload = () => {
            const text = reader.result;
            addClipItem("txt", text);
            if (term) term.write(`\r\n\x1b[2m📄 ${file.name} (${size}, ~${tokenEstimate(text)} tok) → clipboard\x1b[0m\r\n`);
          };
          reader.readAsText(file);
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HOME VIEW (Session Manager)
  // ═══════════════════════════════════════════════════════════════════════
  async function renderHome() {
    showView("home");
    config = config || (await window.silo.getConfig());

    const sessions = await window.silo.listSessions();
    const activeTabs = await window.silo.listActiveTabs();

    const searchWrap = document.getElementById("manager-search-wrap");
    const searchInput = document.getElementById("manager-search");
    if (sessions.length > 4) {
      searchWrap.classList.remove("hidden");
    } else {
      searchWrap.classList.add("hidden");
    }

    function renderList(filter) {
      const filtered = filter
        ? sessions.filter((s) => s.project.name.toLowerCase().includes(filter.toLowerCase()))
        : sessions;

      const list = document.getElementById("session-list");
      if (filtered.length === 0) {
        list.innerHTML = `<div class="empty-state"><div class="empty-icon">◧</div><div class="empty-text">${
          filter ? "No matching sessions" : "No sessions yet — start one"
        }</div></div>`;
        return;
      }

      filtered.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));

      list.innerHTML = filtered
        .map((s) => {
          const toolCfg = (config.tools && config.tools[s.tool]) || {};
          const badgeColor = toolCfg.color || "#6b7280";
          const isRunning = activeTabs.includes(s.id);
          const displayName = s.label || s.project.name;
          const preview = s.preview ? escapeHtml(s.preview) : "";
          return `<div class="session-row" data-id="${s.id}">
            <div class="session-icon">${s.project.icon || "◧"}</div>
            <div class="session-info">
              <div class="session-name">${escapeHtml(displayName)}${s.label ? ` <span style="color:var(--text-3);font-weight:400;font-size:11px">${escapeHtml(s.project.name)}</span>` : ""}</div>
              <div class="session-meta">
                <span class="session-tool-badge" style="background:${badgeColor}20;color:${badgeColor}">${toolCfg.label || s.tool}</span>
                <span>${s.cmds} cmds</span>
                <span>${readableTime(s.savedAt || s.t0)}</span>
                ${isRunning ? '<span style="color:var(--green)">● running</span>' : ""}
              </div>
              ${preview ? `<div class="session-preview">${preview}</div>` : ""}
            </div>
            <span class="session-resume">${isRunning ? "Switch" : "Resume"}</span>
            <button class="session-rename" data-rename="${s.id}" title="Rename session">✎</button>
            <button class="session-delete" data-delete="${s.id}" title="Delete session">✕</button>
          </div>`;
        })
        .join("");

      list.querySelectorAll(".session-row").forEach((row) => {
        row.addEventListener("click", (e) => {
          if (e.target.closest(".session-delete") || e.target.closest(".session-rename")) return;
          openSession(row.dataset.id);
        });
      });
      list.querySelectorAll(".session-rename").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const id = btn.dataset.rename;
          const s = sessions.find((x) => x.id === id);
          const current = s ? (s.label || s.project.name) : "";
          const label = prompt("Session name:", current);
          if (label !== null) {
            await window.silo.renameSession(id, label);
            renderHome();
          }
        });
      });
      list.querySelectorAll(".session-delete").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const id = btn.dataset.delete;
          if (openTabs.has(id)) {
            await closeTab(id);
          } else {
            await window.silo.deleteSession(id);
          }
          renderHome();
        });
      });
    }

    renderList("");
    searchInput.value = "";
    searchInput.oninput = () => renderList(searchInput.value);
  }

  // Open or switch to a session
  async function openSession(id) {
    config = config || (await window.silo.getConfig());

    // Already open as tab — just switch
    if (openTabs.has(id)) {
      await switchToTab(id);
      return;
    }

    // Resume it — new PTY spawns fresh, don't replay old scrollback
    const sess = await window.silo.resumeSession(id);
    if (!sess) return;

    openTabs.set(id, {
      session: sess,
      scrollback: "",
      clipItems: sess.clipItems || [],
      cmdHistory: sess.history || [],
      cmdCount: sess.cmds || 0,
      exited: false,
    });

    renderSideTabs();
    await switchToTab(id);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PROJECT PICKER
  // ═══════════════════════════════════════════════════════════════════════
  async function renderPicker() {
    showView("picker");
    config = config || (await window.silo.getConfig());
    const [pinned, scanned] = await Promise.all([
      window.silo.getPinned(),
      window.silo.scanProjects(),
    ]);

    // Build active projects from open tabs (deduplicated by path)
    const activeProjects = [];
    const seenPaths = new Set();
    for (const [, tab] of openTabs) {
      const p = tab.session.project;
      if (!seenPaths.has(p.path)) {
        seenPaths.add(p.path);
        activeProjects.push({ ...p, active: true });
      }
    }

    allProjects = [
      ...activeProjects,
      ...pinned.map((p) => ({ ...p, pinned: true })).filter((p) => !seenPaths.has(p.path)),
      ...scanned.filter((s) => !pinned.some((p) => p.name === s.name) && !seenPaths.has(s.path)),
    ];
    pickerIndex = 0;

    const searchInput = document.getElementById("picker-search");
    searchInput.value = "";
    searchInput.focus();

    function renderList(filter) {
      const filtered = filter
        ? allProjects.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()))
        : allProjects;

      if (pickerIndex >= filtered.length) pickerIndex = Math.max(0, filtered.length - 1);

      const list = document.getElementById("project-list");
      let html = "";
      let lastSection = null;

      filtered.forEach((p, i) => {
        const section = p.active ? "● Active" : p.pinned ? "★ Pinned" : "~/dev";
        if (section !== lastSection) {
          html += `<div class="project-section-header">${section}</div>`;
          lastSection = section;
        }
        const isActive = i === pickerIndex;
        html += `<div class="project-row${isActive ? " active" : ""}" data-idx="${i}">
          <div class="project-icon">${p.icon || "📁"}</div>
          <div class="project-name">${escapeHtml(p.name)}</div>
          ${p.desc ? `<div class="project-desc">${escapeHtml(p.desc)}</div>` : ""}
          <span class="project-enter-badge">⏎</span>
        </div>`;
      });

      if (filtered.length === 0) {
        html = `<div class="empty-state"><div class="empty-text">No projects found</div></div>`;
      }

      list.innerHTML = html;

      list.querySelectorAll(".project-row").forEach((row) => {
        row.addEventListener("click", () => {
          const idx = parseInt(row.dataset.idx, 10);
          selectProject(filtered[idx]);
        });
        row.addEventListener("mouseenter", () => {
          pickerIndex = parseInt(row.dataset.idx, 10);
          renderList(searchInput.value);
        });
      });
    }

    renderList("");
    searchInput.oninput = () => {
      pickerIndex = 0;
      renderList(searchInput.value);
    };
    searchInput.onkeydown = (e) => {
      const filter = searchInput.value;
      const filtered = filter
        ? allProjects.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()))
        : allProjects;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        pickerIndex = Math.min(pickerIndex + 1, filtered.length - 1);
        renderList(filter);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        pickerIndex = Math.max(pickerIndex - 1, 0);
        renderList(filter);
      } else if (e.key === "Enter" && filtered.length > 0) {
        e.preventDefault();
        selectProject(filtered[pickerIndex]);
      } else if (e.key === "Escape") {
        showHomeOrTerminal();
      }
    };

    // Browse folder button
    document.getElementById("btn-browse-folder").onclick = async () => {
      const folder = await window.silo.pickFolder();
      if (folder) selectProject(folder);
    };
  }

  function selectProject(project) {
    selectedProject = project;
    renderToolPicker();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL PICKER
  // ═══════════════════════════════════════════════════════════════════════
  async function renderToolPicker() {
    showView("tool");
    config = config || (await window.silo.getConfig());
    const subtitle = document.getElementById("tool-subtitle");
    subtitle.textContent = `for ${selectedProject.icon || ""} ${selectedProject.name}`;

    const list = document.getElementById("tool-list");
    list.innerHTML = Object.entries(config.tools)
      .map(
        ([key, t]) => `<div class="tool-card" data-tool="${key}">
        <div class="tool-card-icon" style="background:${t.color}15;color:${t.color}">${t.icon}</div>
        <div class="tool-card-info">
          <div class="tool-card-name">${escapeHtml(t.label)}</div>
          ${t.description ? `<div class="tool-card-desc">${escapeHtml(t.description)}</div>` : ""}
          <div class="tool-card-cmd">$ ${escapeHtml(t.command)}</div>
        </div>
      </div>`
      )
      .join("");

    list.querySelectorAll(".tool-card").forEach((card) => {
      card.addEventListener("click", () => launchSession(card.dataset.tool));
    });
  }

  async function launchSession(toolKey) {
    const sess = await window.silo.createSession({
      project: selectedProject,
      tool: toolKey,
    });

    openTabs.set(sess.id, {
      session: sess,
      scrollback: "",
      clipItems: [],
      cmdHistory: [],
      cmdCount: 0,
      exited: false,
    });

    renderSideTabs();
    await switchToTab(sess.id);
  }

  // ── Show home or return to active terminal ─────────────────────────────
  function showHomeOrTerminal() {
    if (activeTabId && openTabs.has(activeTabId)) {
      showView("terminal");
    } else {
      renderHome();
    }
  }

  // ── Navigation buttons ─────────────────────────────────────────────────
  document.getElementById("btn-new-tab").addEventListener("click", () => renderPicker());

  // New Project: show inline name form
  document.getElementById("btn-home-new-project").addEventListener("click", () => {
    const form = document.getElementById("new-project-form");
    form.classList.toggle("hidden");
    if (!form.classList.contains("hidden")) {
      const input = document.getElementById("new-project-name");
      input.value = "";
      input.focus();
    }
  });

  // Create project: pick parent dir, create folder, go to tool picker
  async function createNewProject() {
    const input = document.getElementById("new-project-name");
    const name = input.value.trim();
    if (!name) return;

    config = config || (await window.silo.getConfig());
    const folder = await window.silo.newProject(name);
    if (folder) {
      document.getElementById("new-project-form").classList.add("hidden");
      selectedProject = folder;
      renderToolPicker();
    }
  }

  document.getElementById("btn-create-project").addEventListener("click", createNewProject);
  document.getElementById("new-project-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); createNewProject(); }
    if (e.key === "Escape") { document.getElementById("new-project-form").classList.add("hidden"); }
  });

  // Open existing folder
  document.getElementById("btn-home-new").addEventListener("click", async () => {
    config = config || (await window.silo.getConfig());
    const folder = await window.silo.pickFolder();
    if (folder) {
      selectedProject = folder;
      renderToolPicker();
    }
  });

  // "Resume Session" scrolls to/focuses the session list
  document.getElementById("btn-home-browse").addEventListener("click", () => {
    const list = document.getElementById("session-list");
    if (list) list.scrollIntoView({ behavior: "smooth" });
  });
  document.getElementById("btn-pick-back").addEventListener("click", () => showHomeOrTerminal());
  document.getElementById("btn-tool-back").addEventListener("click", () => renderPicker());

  document.getElementById("btn-restart").addEventListener("click", async () => {
    if (!activeTabId) return;
    const tab = openTabs.get(activeTabId);
    if (!tab) return;
    tab.exited = false;
    renderSideTabs();
    await window.silo.restartPty(activeTabId, tab.session.tool);
  });

  document.getElementById("btn-export").addEventListener("click", async () => {
    if (!activeTabId) return;
    await window.silo.exportSession(activeTabId);
  });

  document.getElementById("btn-clipboard-toggle").addEventListener("click", () => {
    const rail = document.getElementById("clipboard-rail");
    rail.classList.toggle("hidden");
    setTimeout(() => { if (fitAddon) { fitAddon.fit(); term.scrollToBottom(); } }, 220);
  });

  // ── Keyboard shortcuts ─────────────────────────────────────────────────
  document.addEventListener("keydown", (e) => {
    // Cmd+1-9 to switch tabs
    if ((e.metaKey || e.ctrlKey) && e.key >= "1" && e.key <= "9") {
      e.preventDefault();
      const tabIds = Array.from(openTabs.keys());
      const idx = parseInt(e.key, 10) - 1;
      if (idx < tabIds.length) switchToTab(tabIds[idx]);
      return;
    }
    // Cmd+T new tab
    if ((e.metaKey || e.ctrlKey) && e.key === "t") {
      e.preventDefault();
      renderPicker();
      return;
    }
    // Cmd+W close tab
    if ((e.metaKey || e.ctrlKey) && e.key === "w") {
      e.preventDefault();
      if (activeTabId) closeTab(activeTabId);
      return;
    }
  });

  // ── beforeunload save ──────────────────────────────────────────────────
  window.addEventListener("beforeunload", () => {
    stashCurrentTab();
    for (const [id, tab] of openTabs) {
      window.silo.flushSave(id, {
        scrollback: tab.scrollback || "",
        history: tab.cmdHistory || [],
        clipItems: tab.clipItems || [],
        cmds: tab.cmdCount || 0,
      });
    }
  });

  // ── Init ───────────────────────────────────────────────────────────────
  renderHome();
})();
