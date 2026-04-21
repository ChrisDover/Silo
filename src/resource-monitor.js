// Lightweight Apple Silicon-friendly resource monitor.
// Uses ps without a shell and keeps sampling coarse to avoid becoming the load.

const { execFile } = require("child_process");

function ps(args) {
  return new Promise((resolve) => {
    execFile("ps", args, { timeout: 1500 }, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve("");
        return;
      }
      resolve(stdout);
    });
  });
}

async function listProcesses() {
  const stdout = await ps(["axo", "pid=,ppid=,%cpu=,rss=,state=,comm="]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      return {
        pid: Number.parseInt(parts[0], 10),
        ppid: Number.parseInt(parts[1], 10),
        cpu: Number.parseFloat(parts[2]) || 0,
        rssKb: Number.parseInt(parts[3], 10) || 0,
        state: parts[4] || "unknown",
        command: parts.slice(5).join(" "),
      };
    })
    .filter((p) => Number.isFinite(p.pid) && Number.isFinite(p.ppid));
}

function collectTree(rootPid, processes) {
  const byParent = new Map();
  for (const proc of processes) {
    if (!byParent.has(proc.ppid)) byParent.set(proc.ppid, []);
    byParent.get(proc.ppid).push(proc);
  }

  const root = processes.find((p) => p.pid === rootPid);
  if (!root) return [];

  const tree = [];
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const proc = queue.shift();
    if (!proc || seen.has(proc.pid)) continue;
    seen.add(proc.pid);
    tree.push(proc);
    for (const child of byParent.get(proc.pid) || []) {
      queue.push(child);
    }
  }
  return tree;
}

async function samplePid(pid) {
  if (!pid) return { cpu: 0, memMb: 0, state: "dead", processes: 0, top: [] };

  const processes = await listProcesses();
  const tree = collectTree(Number(pid), processes);
  if (!tree.length) return { cpu: 0, memMb: 0, state: "dead", processes: 0, top: [] };

  const cpu = tree.reduce((sum, p) => sum + p.cpu, 0);
  const rssKb = tree.reduce((sum, p) => sum + p.rssKb, 0);
  const top = tree
    .slice()
    .sort((a, b) => b.cpu - a.cpu || b.rssKb - a.rssKb)
    .slice(0, 4)
    .map((p) => ({
      pid: p.pid,
      cpu: Math.round(p.cpu * 10) / 10,
      memMb: Math.round((p.rssKb / 1024) * 10) / 10,
      command: p.command.split("/").pop().slice(0, 40),
    }));

  return {
    cpu: Math.round(cpu * 10) / 10,
    memMb: Math.round((rssKb / 1024) * 10) / 10,
    state: tree[0].state || "unknown",
    processes: tree.length,
    top,
  };
}

module.exports = { samplePid };
