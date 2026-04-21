// Git state helpers for Silo worktree/session awareness.

const { execFile } = require("child_process");

function execGit(cwd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, stdout: "", stderr: stderr || err.message });
        return;
      }
      resolve({ ok: true, stdout: stdout || "", stderr: "" });
    });
  });
}

async function getGitSummary(cwd) {
  const inside = await execGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return { ok: false, changed: 0, insertions: 0, deletions: 0, files: [], summary: "Not a git worktree" };
  }

  const [branchRes, statusRes, statRes] = await Promise.all([
    execGit(cwd, ["branch", "--show-current"]),
    execGit(cwd, ["status", "--short"]),
    execGit(cwd, ["diff", "--shortstat", "HEAD"]),
  ]);

  const files = statusRes.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, 30)
    .map((line) => ({
      code: line.slice(0, 2).trim() || "?",
      path: line.slice(3).trim(),
    }));

  const stat = statRes.stdout.trim();
  const insertions = Number.parseInt((stat.match(/(\d+) insertion/) || [])[1], 10) || 0;
  const deletions = Number.parseInt((stat.match(/(\d+) deletion/) || [])[1], 10) || 0;

  return {
    ok: true,
    branch: branchRes.stdout.trim() || "detached",
    changed: files.length,
    insertions,
    deletions,
    files,
    summary: files.length
      ? `${files.length} files changed, +${insertions} -${deletions}`
      : "No changes",
  };
}

async function getDiffPreview(cwd, maxChars = 12000) {
  const diff = await execGit(cwd, ["diff", "--stat", "HEAD"]);
  const names = await execGit(cwd, ["status", "--short"]);
  if (!diff.ok && !names.ok) return "No git diff available.";
  return `${diff.stdout.trim()}\n\n${names.stdout.trim()}`.trim().slice(0, maxChars) || "No changes.";
}

module.exports = { getGitSummary, getDiffPreview };
