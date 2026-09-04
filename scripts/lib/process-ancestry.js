'use strict';

// One bounded process-ancestry walk for host detection, wake discovery, and
// Desktop self-host checks. The system ps is addressed through a fixed PATH so
// a project executable cannot impersonate it.

const { execFileSync } = require('node:child_process');

const DEFAULT_MAX_DEPTH = 32;
const SYSTEM_TOOL_PATH = '/usr/sbin:/usr/bin:/bin:/sbin';

function defaultRun(executable, args) {
  return execFileSync(executable, args, {
    encoding: 'utf8', timeout: 3000, env: { PATH: SYSTEM_TOOL_PATH },
  });
}

function parseProcessRow(raw) {
  const match = /^\s*(\d+)(?:\s+(.*?))?\s*$/.exec(String(raw || ''));
  if (!match) return null;
  const ppid = Number(match[1]);
  if (!Number.isInteger(ppid) || ppid < 0) return null;
  return { ppid, command: match[2] || '' };
}

function processRow(pid, run = defaultRun) {
  try {
    const raw = run('ps', ['-o', 'ppid=,comm=', '-p', String(pid)]);
    return parseProcessRow(raw);
  } catch {
    return null;
  }
}

function walkProcessAncestry(options = {}) {
  const run = options.run || defaultRun;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const rows = [];
  const seen = new Set();
  let pid = options.startPid ?? process.ppid;

  for (let depth = 0; depth < maxDepth && Number.isInteger(pid) && pid > 1; depth += 1) {
    if (seen.has(pid)) break;
    seen.add(pid);
    const row = processRow(pid, run);
    if (!row) break;
    rows.push({ pid, ppid: row.ppid, command: row.command, depth });
    if (row.ppid < 1 || seen.has(row.ppid)) break;
    pid = row.ppid;
  }
  return rows;
}

function ancestorProcessIds(options = {}) {
  return walkProcessAncestry(options).map((row) => row.pid);
}

module.exports = {
  DEFAULT_MAX_DEPTH,
  ancestorProcessIds,
  defaultRun,
  parseProcessRow,
  processRow,
  walkProcessAncestry,
};
