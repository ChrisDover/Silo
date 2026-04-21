// Silo local supervisor
// Local-first session doctor backed by Ollama/Gemma when available.

const DEFAULT_TIMEOUT_MS = 12000;

function stripAnsi(text) {
  return String(text || "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

function compactTerminalText(text, maxChars = 6000) {
  const clean = stripAnsi(text)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join("\n");
  return clean.slice(-maxChars);
}

function classifySession({ exited, lastOutputAt, scrollback, resource, git }) {
  const now = Date.now();
  const clean = compactTerminalText(scrollback, 2500).toLowerCase();
  const idleMs = lastOutputAt ? now - lastOutputAt : Number.MAX_SAFE_INTEGER;

  const waitsForUser =
    clean.includes("permission") ||
    clean.includes("approve") ||
    clean.includes("allow") ||
    clean.includes("continue?") ||
    clean.includes("press enter") ||
    clean.includes("waiting for") ||
    clean.includes("would you like");

  const failure =
    clean.includes("error:") ||
    clean.includes("failed") ||
    clean.includes("exception") ||
    clean.includes("traceback") ||
    clean.includes("tests failed") ||
    clean.includes("npm err!");

  if (exited) {
    return {
      state: "dead",
      reason: "The process exited.",
      action: "Restart",
      risk: "low",
    };
  }

  if (waitsForUser) {
    return {
      state: "blocked",
      reason: "The agent appears to be waiting for input or permission.",
      action: "Review",
      risk: clean.includes("sudo") || clean.includes("install") ? "medium" : "low",
    };
  }

  if (failure) {
    return {
      state: "failed",
      reason: "Recent output contains an error or failed command.",
      action: "Ask Gemma",
      risk: "medium",
    };
  }

  if (resource && resource.cpu >= 120) {
    return {
      state: "hot",
      reason: "This session is using a lot of CPU.",
      action: "Watch",
      risk: "low",
    };
  }

  if (git && git.ok && git.changed > 0 && idleMs > 90 * 1000) {
    return {
      state: "review",
      reason: `The agent changed ${git.changed} files and is currently quiet.`,
      action: "Review Diff",
      risk: git.changed > 12 ? "medium" : "low",
    };
  }

  if (idleMs > 10 * 60 * 1000) {
    return {
      state: "idle",
      reason: "No meaningful output for more than ten minutes.",
      action: "Check",
      risk: "low",
    };
  }

  return {
    state: "running",
    reason: "The session is active.",
    action: "Watch",
    risk: "low",
  };
}

async function postOllama({ endpoint, model, prompt, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${endpoint.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature: 0.2,
          num_ctx: 8192,
          num_predict: 700,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    const data = await res.json();
    return String(data.response || "").trim();
  } finally {
    clearTimeout(timeout);
  }
}

function buildDoctorPrompt({ session, health, scrollback }) {
  const recent = compactTerminalText(scrollback, 6000);
  const resource = health.resource
    ? `Resource load: CPU ${health.resource.cpu || 0}% / MEM ${health.resource.memMb || 0}MB / ${health.resource.processes || 0} processes`
    : "";
  return `You are Silo's local supervisor for a vibe coder. Explain only what matters.

Return concise plain text with these labels:
State:
What matters:
Next action:
Escalate:

Rules:
- The user is not an expert developer.
- Prefer local fixes and low-cost actions.
- Say "Escalate: no" unless a cloud model or coding agent is clearly useful.
- Mention resource/cost concerns only if they matter.

Project: ${session.project.name}
Tool: ${session.tool}
Current state: ${health.state}
Current reason: ${health.reason}
Suggested action: ${health.action}
${resource}

Recent terminal output:
${recent || "(no output yet)"}`;
}

async function doctor({ session, health, scrollback, localModel }) {
  const fallback = [
    `State: ${health.state}`,
    `What matters: ${health.reason}`,
    `Next action: ${health.action}`,
    "Escalate: no",
  ].join("\n");

  if (!localModel || localModel.enabled === false) return fallback;

  const endpoint = localModel.endpoint || "http://127.0.0.1:11434";
  const model = localModel.model || "gemma4";
  const prompt = buildDoctorPrompt({ session, health, scrollback });

  try {
    return await postOllama({ endpoint, model, prompt });
  } catch (err) {
    return `${fallback}\n\nLocal supervisor unavailable: ${err.message}`;
  }
}

function buildContextPacket({ session, health, scrollback, git, budget }) {
  return [
    "# Silo Context Packet",
    "",
    `Project: ${session.project.name}`,
    `Path: ${session.project.path}`,
    session.worktree && session.worktree.enabled ? `Worktree: ${session.worktree.path}` : "",
    session.worktree && session.worktree.sourcePath ? `Source checkout: ${session.worktree.sourcePath}` : "",
    session.worktree && session.worktree.branch ? `Branch: ${session.worktree.branch}` : "",
    `Primary tool: ${session.tool}`,
    `State: ${health.state}`,
    `Reason: ${health.reason}`,
    `Recommended action: ${health.action}`,
    health.resource ? `Resource load: CPU ${health.resource.cpu || 0}% / MEM ${health.resource.memMb || 0}MB / ${health.resource.processes || 0} processes` : "",
    git && git.ok ? `Git: ${git.summary} on ${git.branch}` : "",
    git && git.ok && git.files && git.files.length ? `Changed files:\n${git.files.map((f) => `- ${f.code} ${f.path}`).join("\n")}` : "",
    `Cloud budget: ${budget || "ask before spending"}`,
    "",
    "## Recent Output",
    compactTerminalText(scrollback, 8000) || "(no output yet)",
  ].join("\n");
}

module.exports = {
  classifySession,
  compactTerminalText,
  doctor,
  buildContextPacket,
};
