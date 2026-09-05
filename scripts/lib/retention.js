'use strict';

// A conservative, recoverable retention pass over this installation's own
// local state. Nothing is unlinked: every candidate is moved into a
// same-filesystem `trash/<ISO date>/...` directory (0700) that sits beside
// the resource it came from, so an owner can recover anything by moving it
// back by hand. `--dry-run` only counts candidates; it never touches disk.
//
// Three resources are considered:
//   (a) operation journals that are terminal, whose lane has released its
//       worktree seat, and that are older than the keep-days window;
//   (b) acknowledged parent events older than the keep-days window;
//   (c) installer backups beyond the newest keep-backups per backup root.
//
// (b) is reported but never moved. An event's id is the digest of its
// content including its per-parent sequence, and recording re-scans every
// event file under a parent (acknowledged or not) to find a semantic
// duplicate before minting a new one; that is what keeps a crash-and-retry
// from notifying a parent twice. Reaping acknowledged events would make that
// match depend on retention timing, so `events` stays `{ candidates: 0,
// moved: 0 }` until dispatch.js offers a pruning primitive of its own.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  TERMINAL_OPERATION_STATES, listLanes, listOperations, projectPaths, withProjectLock,
} = require('./state');

const DEFAULT_KEEP_DAYS = 30;
const DEFAULT_KEEP_BACKUPS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Only an installer backup is ever a candidate. A `.failed-*` entry records a
// broken install and is left in place for manual review.
const BACKUP_ENTRY_PATTERN = /^transmogrify\.backup-/;
const BACKUP_RECEIPT_FILE = '.transmogrify-backup.json';

function isoDateStamp(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function lstatIfPresent(target) {
  try { return fs.lstatSync(target); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertRealDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory`);
  }
  return stat;
}

// Create every missing path segment as an owner-only 0700 directory. Every
// existing segment is inspected with lstat so chmod can never follow a link.
function ensureTrashDirectory(directory) {
  const missing = [];
  let current = directory;
  while (!lstatIfPresent(current)) {
    missing.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  assertRealDirectory(current, 'trash ancestor');
  for (const segment of missing) {
    assertRealDirectory(path.dirname(segment), 'trash parent');
    fs.mkdirSync(segment, { mode: 0o700 });
    assertRealDirectory(segment, 'trash directory');
  }
  assertRealDirectory(directory, 'trash directory');
  fs.chmodSync(directory, 0o700);
}

// Move one path into `trashDirectory`, preserving its basename. Refuses to
// silently clobber an existing trash entry. Same-filesystem rename only: both
// sides always sit under the resource's own root, so this never crosses a
// mount boundary.
function moveToTrash(sourcePath, trashDirectory) {
  ensureTrashDirectory(trashDirectory);
  const destination = path.join(trashDirectory, path.basename(sourcePath));
  if (lstatIfPresent(destination)) {
    throw new Error(`trash destination already exists: ${path.basename(destination)}`);
  }
  fs.renameSync(sourcePath, destination);
}

// Best-effort move: one candidate that cannot be moved is left in place
// rather than aborting the rest of the batch or the whole pass.
function tryMoveToTrash(sourcePath, trashDirectory) {
  try {
    moveToTrash(sourcePath, trashDirectory);
    return true;
  } catch {
    return false;
  }
}

// Terminal operation journals whose lane already released its worktree seat
// and whose last update is older than the cutoff.
function operationCandidates(repoRoot, env, cutoffMs) {
  const lanesById = new Map(listLanes(repoRoot, env).map((lane) => [lane.laneId, lane]));
  return listOperations(repoRoot, env).filter((operation) => {
    if (!TERMINAL_OPERATION_STATES.has(operation.state)) return false;
    const lane = operation.laneId ? lanesById.get(operation.laneId) : null;
    if (!lane || lane.state !== 'worktreeRemoved') return false;
    const updatedAtMs = Date.parse(operation.updatedAt);
    return Number.isFinite(updatedAtMs) && updatedAtMs < cutoffMs;
  });
}

// Identify and, unless dry-run, move the candidate journals. Candidates are
// re-read inside the project lock so the decision and the move share one
// consistent snapshot with any concurrent lane operation.
function retainOperations(repoRoot, env, options, isoDate) {
  const paths = projectPaths(repoRoot, env);
  return withProjectLock(paths, () => {
    const candidates = operationCandidates(repoRoot, env, options.cutoffMs);
    let moved = 0;
    if (!options.dryRun) {
      const trashDirectory = path.join(paths.directory, 'trash', isoDate, 'operations');
      for (const operation of candidates) {
        const file = path.join(paths.operations, `${operation.operationId}.json`);
        if (tryMoveToTrash(file, trashDirectory)) moved += 1;
      }
    }
    return { candidates: candidates.length, moved };
  });
}

// The two backup roots install.js writes to. Mirrors its own HOME resolution
// exactly so retention and installation never disagree on where backups live.
function backupRoots(env) {
  const home = env.HOME || os.homedir();
  return [
    path.join(home, '.claude', 'transmogrify-backups'),
    path.join(home, '.agents', 'transmogrify-backups'),
  ];
}

// The installer stamps each backup name with the transaction's UTC time, and
// a renamed directory keeps its old mtime, so the name is the ordering key and
// mtime only breaks ties for entries without a parseable stamp.
function backupOrder(name, mtimeMs) {
  const stamp = /^transmogrify\.backup-(\d{8}T\d{9}Z)/.exec(name);
  return stamp ? stamp[1] : `0000000000000000000Z:${String(Math.floor(mtimeMs)).padStart(16, '0')}`;
}

function validBackupReceipt(entryPath, entryName) {
  const entryStat = lstatIfPresent(entryPath);
  if (!entryStat?.isDirectory() || entryStat.isSymbolicLink()) return false;
  const receiptPath = path.join(entryPath, BACKUP_RECEIPT_FILE);
  const stat = lstatIfPresent(receiptPath);
  if (!stat?.isFile() || stat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) !== 0) return false;
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); } catch { return false; }
  const keys = receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    ? Object.keys(receipt).sort() : [];
  const expected = ['createdAt', 'source', 'transaction', 'version'].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]) &&
    receipt.version === 1 &&
    typeof receipt.transaction === 'string' && Boolean(receipt.transaction) &&
    entryName === `transmogrify.backup-${receipt.transaction}` &&
    typeof receipt.createdAt === 'string' && !Number.isNaN(Date.parse(receipt.createdAt)) &&
    typeof receipt.source === 'string' && path.isAbsolute(receipt.source) &&
    path.normalize(receipt.source) === receipt.source;
}

// Installer backups beyond the newest `keepBackups`, independently per
// backup root. Age plays no part: this is a pure count-based retention over
// `transmogrify.backup-*` entries, newest first by their transaction stamp.
function retainBackups(env, options, isoDate) {
  let candidates = 0;
  let moved = 0;
  for (const root of backupRoots(env)) {
    let entries;
    try {
      const rootStat = fs.lstatSync(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error('backup root is not a real directory');
      }
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const backups = entries
      .filter((entry) => BACKUP_ENTRY_PATTERN.test(entry.name) &&
        validBackupReceipt(path.join(root, entry.name), entry.name))
      .map((entry) => {
        const entryPath = path.join(root, entry.name);
        return { path: entryPath, order: backupOrder(entry.name, fs.lstatSync(entryPath).mtimeMs) };
      })
      .sort((left, right) => (left.order < right.order ? 1 : left.order > right.order ? -1 : 0));
    const stale = backups.slice(Math.max(0, options.keepBackups));
    candidates += stale.length;
    if (!options.dryRun && stale.length > 0) {
      const trashDirectory = path.join(root, 'trash', isoDate);
      for (const backup of stale) {
        if (tryMoveToTrash(backup.path, trashDirectory)) moved += 1;
      }
    }
  }
  return { candidates, moved };
}

// Run one retention pass. `options.repoRoot` scopes the operation-journal
// pass; backups are installation-wide and need no repository. Never throws
// for an individual unmovable candidate; a genuine local-state fault (a lock
// timeout, a corrupt registry) still propagates so the owner sees it.
function runRetention(options, env = process.env) {
  const dryRun = options.dryRun === true;
  const keepDays = options.keepDays ?? DEFAULT_KEEP_DAYS;
  const keepBackups = options.keepBackups ?? DEFAULT_KEEP_BACKUPS;
  const cutoffMs = Date.now() - keepDays * MS_PER_DAY;
  const isoDate = isoDateStamp();
  const operations = retainOperations(options.repoRoot, env, { dryRun, cutoffMs }, isoDate);
  const events = { candidates: 0, moved: 0 };
  const backups = retainBackups(env, { dryRun, keepBackups }, isoDate);
  return {
    dryRun,
    keepDays,
    keepBackups,
    operations,
    events,
    backups,
    trashDir: !dryRun && (operations.moved > 0 || backups.moved > 0),
  };
}

module.exports = {
  BACKUP_ENTRY_PATTERN,
  BACKUP_RECEIPT_FILE,
  DEFAULT_KEEP_BACKUPS,
  DEFAULT_KEEP_DAYS,
  backupRoots,
  operationCandidates,
  runRetention,
};
