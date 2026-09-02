'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sanitizedGitEnv } = require('./git-env');
const { mutateLane, resolveProject } = require('./state');

class UnsafeCleanupStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeCleanupStateError';
    this.code = 'UNSAFE_CLEANUP_STATE';
  }
}

class SeatIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SeatIdentityError';
    this.code = 'SEAT_IDENTITY_MISMATCH';
  }
}

function unsafeCleanup(message) {
  return new UnsafeCleanupStateError(message);
}

function seatIdentity(message) {
  return new SeatIdentityError(message);
}

function isPermanentCleanupError(error) {
  return error?.code === 'UNSAFE_CLEANUP_STATE';
}

function git(repoRoot, args, options = {}) {
  try {
    const { env = process.env, ...safeOptions } = options;
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...safeOptions,
      env: sanitizedGitEnv(env),
    });
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`git ${args.join(' ')} failed for ${repoRoot}: ${detail}`);
  }
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function requireOwnerControlledDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (stat.mode & 0o022) !== 0) {
    throw seatIdentity(`refusing non-owner-controlled ${label}: ${directory}`);
  }
}

function requirePrivateManagedRoot(directory) {
  const stat = fs.lstatSync(directory);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`refusing non-private managed WORKTREES directory: ${directory}`);
  }
}

function requireIgnoredManagedRoot(projectRoot, worktreesRoot) {
  if (!containsPath(projectRoot, worktreesRoot)) return;
  const directoryForm = `${worktreesRoot}${path.sep}`;
  try {
    execFileSync('git', [
      '-C', projectRoot, 'check-ignore', '--quiet', '--no-index', '--', directoryForm,
    ], { stdio: 'ignore', env: sanitizedGitEnv() });
  } catch (error) {
    if (error.status === 1) {
      throw seatIdentity(
        'WORKTREES inside the repository must be ignored by Git; ' +
        'ignore the root or choose an absolute path outside the repository',
      );
    }
    throw new Error('could not verify that the in-repository WORKTREES root is ignored by Git');
  }
}

function requireExternalManagedRootOutsideGit(projectRoot, worktreesRoot) {
  let ancestor = worktreesRoot;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  ancestor = fs.realpathSync(ancestor);
  try {
    const containingRoot = execFileSync(
      'git', ['-C', ancestor, 'rev-parse', '--show-toplevel'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...sanitizedGitEnv(), LC_ALL: 'C', LANG: 'C' },
      },
    ).trim();
    if (containingRoot && fs.realpathSync(containingRoot) !== projectRoot) {
      throw seatIdentity(
        'external WORKTREES must be outside every other Git worktree, including linked worktrees',
      );
    }
    return;
  } catch (error) {
    if (error.code === 'SEAT_IDENTITY_MISMATCH') {
      throw error;
    }
    const detail = error.stderr?.toString() || '';
    if (error.status === 128 && detail.includes('not a git repository')) return;
    throw new Error('could not verify that external WORKTREES is outside every Git worktree');
  }
}

function parseWorktreeList(raw) {
  const records = [];
  let current = null;
  for (const field of raw.split('\0')) {
    if (!field) continue;
    const space = field.indexOf(' ');
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? true : field.slice(space + 1);
    if (key === 'worktree') {
      current = { path: value };
      records.push(current);
    } else if (current) {
      current[key] = value;
    }
  }
  return records;
}

function canonicalFuturePath(repoRoot, candidate) {
  if (!candidate || !path.isAbsolute(candidate)) {
    throw new Error(`path must be absolute: ${candidate || '(missing)'}`);
  }
  const project = resolveProject(repoRoot);
  const requestedRoot = path.resolve(repoRoot);
  const requested = path.resolve(candidate);
  const relative = path.relative(requestedRoot, requested);
  const expected = relative === '' || containsPath(requestedRoot, requested)
    ? path.join(project.root, relative)
    : requested;
  let ancestor = expected;
  const missing = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  requireOwnerControlledDirectory(ancestor, 'WORKTREES ancestor');
  const canonical = path.join(fs.realpathSync(ancestor), ...missing);
  if (canonical !== expected) {
    throw new Error(`path traverses a symlink: ${candidate}`);
  }
  return canonical;
}

function verifySeat(repoRoot, seatPath, worktreesRoot) {
  if (!seatPath || !path.isAbsolute(seatPath)) {
    throw seatIdentity(`lane seat must be an absolute path: ${seatPath || '(missing)'}`);
  }
  if (!worktreesRoot || !path.isAbsolute(worktreesRoot)) {
    throw seatIdentity(`WORKTREES must be an absolute path: ${worktreesRoot || '(missing)'}`);
  }
  const project = resolveProject(repoRoot);
  const requestedRoot = path.resolve(repoRoot);
  const canonicalizeInput = (input) => {
    const requested = path.resolve(input);
    const relative = path.relative(requestedRoot, requested);
    if (relative === '' || containsPath(requestedRoot, requested)) {
      return { expected: path.join(project.root, relative), actual: fs.realpathSync(requested) };
    }
    return { expected: requested, actual: fs.realpathSync(requested) };
  };
  const seat = canonicalizeInput(seatPath);
  const worktrees = canonicalizeInput(worktreesRoot);
  const canonicalSeat = seat.actual;
  const canonicalWorktrees = worktrees.actual;
  if (canonicalSeat !== seat.expected) {
    throw seatIdentity(`lane seat path traverses a symlink: ${seatPath}`);
  }
  if (canonicalWorktrees !== worktrees.expected) {
    throw seatIdentity(`WORKTREES path traverses a symlink: ${worktreesRoot}`);
  }
  if (canonicalWorktrees === project.commonDir || containsPath(project.commonDir, canonicalWorktrees)) {
    throw seatIdentity('WORKTREES must be outside the Git common directory');
  }
  requireOwnerControlledDirectory(canonicalWorktrees, 'WORKTREES directory');
  requireExternalManagedRootOutsideGit(project.root, canonicalWorktrees);
  requireIgnoredManagedRoot(project.root, canonicalWorktrees);
  if (!containsPath(canonicalWorktrees, canonicalSeat)) {
    throw seatIdentity(`lane seat is outside WORKTREES: ${canonicalSeat}`);
  }
  if (canonicalSeat === project.root) {
    throw seatIdentity('the operator checkout cannot be used as a lane seat');
  }

  const seatProject = resolveProject(canonicalSeat);
  if (seatProject.commonDir !== project.commonDir) {
    throw seatIdentity(`lane seat belongs to a different Git repository: ${canonicalSeat}`);
  }
  const records = parseWorktreeList(git(project.root, ['worktree', 'list', '--porcelain', '-z']));
  const record = records.find((entry) => {
    try { return fs.realpathSync(entry.path) === canonicalSeat; } catch { return false; }
  });
  if (!record) throw seatIdentity(`Git does not recognize the lane seat as a worktree: ${canonicalSeat}`);
  if (typeof record.branch !== 'string' || !record.branch.startsWith('refs/heads/')) {
    throw seatIdentity(`lane seat must be on a local branch: ${canonicalSeat}`);
  }

  const stat = fs.statSync(canonicalSeat);
  return {
    path: canonicalSeat,
    worktreesRoot: canonicalWorktrees,
    gitCommonDir: project.commonDir,
    branchRef: record.branch,
    head: record.HEAD || null,
    device: stat.dev,
    inode: stat.ino,
    managed: false,
  };
}

function createManagedSeat(repoRoot, worktreesRoot, laneId, options = {}) {
  const intent = planManagedSeat(repoRoot, worktreesRoot, laneId, options);
  return materializeManagedSeat(repoRoot, intent);
}

function planManagedSeat(repoRoot, worktreesRoot, laneId, options = {}) {
  if (!/^[0-9a-f-]{36}$/.test(laneId || '')) {
    throw new Error(`managed worktree requires a UUID lane id: ${laneId || '(missing)'}`);
  }
  const project = resolveProject(repoRoot);
  const canonicalWorktrees = canonicalFuturePath(repoRoot, worktreesRoot);
  if (canonicalWorktrees === project.root) {
    throw new Error('WORKTREES cannot be the operator checkout');
  }
  if (canonicalWorktrees === project.commonDir || containsPath(project.commonDir, canonicalWorktrees)) {
    throw new Error('WORKTREES must be outside the Git common directory');
  }
  requireExternalManagedRootOutsideGit(project.root, canonicalWorktrees);
  requireIgnoredManagedRoot(project.root, canonicalWorktrees);
  const seatPath = path.join(canonicalWorktrees, laneId);
  const branchName = options.branchName || `transmogrify/${laneId}`;
  if (branchName.startsWith('-')) throw new Error(`invalid managed branch name: ${branchName}`);
  git(project.root, ['check-ref-format', '--branch', branchName]);
  const baseRef = options.baseRef || 'HEAD';
  if (baseRef.startsWith('-')) throw new Error(`invalid managed base ref: ${baseRef}`);
  const baseCommit = git(project.root, ['rev-parse', '--verify', `${baseRef}^{commit}`]).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(baseCommit)) {
    throw new Error(`managed base ref did not resolve to a commit: ${baseRef}`);
  }
  return {
    version: 1,
    laneId,
    path: seatPath,
    worktreesRoot: canonicalWorktrees,
    gitCommonDir: project.commonDir,
    branchRef: `refs/heads/${branchName}`,
    baseCommit: baseCommit.toLowerCase(),
    managed: true,
  };
}

function verifyManagedSeatIntent(repoRoot, intent) {
  if (!intent || intent.version !== 1 || intent.managed !== true ||
      !/^[0-9a-f-]{36}$/.test(intent.laneId || '') ||
      !path.isAbsolute(intent.path || '') || !path.isAbsolute(intent.worktreesRoot || '') ||
      !path.isAbsolute(intent.gitCommonDir || '') ||
      typeof intent.branchRef !== 'string' || !intent.branchRef.startsWith('refs/heads/') ||
      !/^[0-9a-f]{40,64}$/.test(intent.baseCommit || '')) {
    throw new Error('invalid managed seat intent');
  }
  const project = resolveProject(repoRoot);
  if (project.commonDir !== intent.gitCommonDir) {
    throw new Error('managed seat intent belongs to a different Git repository');
  }
  const expectedRoot = canonicalFuturePath(repoRoot, intent.worktreesRoot);
  if (expectedRoot !== intent.worktreesRoot ||
      path.join(expectedRoot, intent.laneId) !== intent.path) {
    throw new Error('managed seat intent path identity changed');
  }
  if (expectedRoot === project.commonDir || containsPath(project.commonDir, expectedRoot)) {
    throw new Error('WORKTREES must be outside the Git common directory');
  }
  requireExternalManagedRootOutsideGit(project.root, expectedRoot);
  requireIgnoredManagedRoot(project.root, expectedRoot);
  return { project, intent };
}

function materializeManagedSeat(repoRoot, intent) {
  const verified = verifyManagedSeatIntent(repoRoot, intent);
  const { project } = verified;
  fs.mkdirSync(intent.worktreesRoot, { recursive: true, mode: 0o700 });
  requireOwnerControlledDirectory(intent.worktreesRoot, 'WORKTREES directory');
  requirePrivateManagedRoot(intent.worktreesRoot);
  if (fs.realpathSync(intent.worktreesRoot) !== intent.worktreesRoot) {
    throw new Error(`refusing unsafe WORKTREES directory: ${intent.worktreesRoot}`);
  }

  if (fs.existsSync(intent.path)) {
    const existing = verifySeat(repoRoot, intent.path, intent.worktreesRoot);
    if (existing.branchRef !== intent.branchRef || existing.head?.toLowerCase() !== intent.baseCommit) {
      throw new Error(`managed seat does not match its durable intent: ${intent.path}`);
    }
    return { ...existing, managed: true };
  }

  const records = parseWorktreeList(git(project.root, ['worktree', 'list', '--porcelain', '-z']));
  const collision = records.find((entry) =>
    path.resolve(entry.path) === intent.path || entry.branch === intent.branchRef
  );
  if (collision) throw new Error('managed seat intent collides with an existing worktree or branch');

  let branchCommit = null;
  try {
    branchCommit = git(project.root, ['show-ref', '--verify', '--hash', intent.branchRef]).trim().toLowerCase();
  } catch {}
  const branchName = intent.branchRef.slice('refs/heads/'.length);
  if (branchCommit !== null && branchCommit !== intent.baseCommit) {
    throw new Error('managed seat branch no longer matches its reserved base commit');
  }
  if (branchCommit === null) {
    git(project.root, ['worktree', 'add', '-b', branchName, '--', intent.path, intent.baseCommit]);
  } else {
    git(project.root, ['worktree', 'add', '--', intent.path, branchName]);
  }
  const seat = verifySeat(project.root, intent.path, intent.worktreesRoot);
  if (seat.branchRef !== intent.branchRef || seat.head?.toLowerCase() !== intent.baseCommit) {
    throw new Error('materialized managed seat does not match its durable intent');
  }
  return { ...seat, managed: true };
}

function verifyRecordedSeat(repoRoot, recorded) {
  if (!recorded || recorded.managed !== true) {
    throw seatIdentity('lane seat is not operator-managed');
  }
  const current = verifySeat(repoRoot, recorded.path, recorded.worktreesRoot);
  for (const key of ['path', 'worktreesRoot', 'gitCommonDir', 'branchRef', 'device', 'inode']) {
    if (current[key] !== recorded[key]) {
      throw seatIdentity(`managed lane seat identity changed (${key}): ${recorded.path}`);
    }
  }
  return { ...current, managed: true };
}

function verifyLaneSeat(repoRoot, recorded) {
  if (!recorded) throw seatIdentity('lane has no recorded seat');
  if (recorded.managed === true) return verifyRecordedSeat(repoRoot, recorded);
  const current = verifySeat(repoRoot, recorded.path, recorded.worktreesRoot);
  for (const key of ['path', 'worktreesRoot', 'gitCommonDir', 'branchRef', 'device', 'inode']) {
    if (current[key] !== recorded[key]) {
      throw seatIdentity(`lane seat identity changed (${key}): ${recorded.path}`);
    }
  }
  return current;
}

function captureHarvestReceipt(repoRoot, recorded, outputSha256) {
  if (!/^[0-9a-f]{64}$/.test(outputSha256 || '')) {
    throw new Error('harvested output digest must be a lowercase SHA-256');
  }
  const seat = verifyLaneSeat(repoRoot, recorded);
  const head = git(seat.path, ['rev-parse', '--verify', 'HEAD']).trim().toLowerCase();
  const status = cleanupStatus(seat.path);
  return {
    version: 1,
    outputSha256,
    harvestedAt: new Date().toISOString(),
    seat: {
      branchRef: seat.branchRef,
      head,
      statusSha256: status.sha256,
      clean: status.clean,
    },
  };
}

function cleanupStatus(seatPath) {
  const visible = git(seatPath, ['status', '--porcelain=v1', '--untracked-files=all']);
  const ignored = git(seatPath, [
    'ls-files', '--others', '--ignored', '--exclude-standard', '-z',
  ]);
  return {
    clean: visible.length === 0 && ignored.length === 0,
    sha256: crypto.createHash('sha256')
      .update('visible\0').update(visible).update('\0ignored\0').update(ignored).digest('hex'),
  };
}

function verifyHarvestedSeatForCleanup(repoRoot, recorded, harvestReceipt) {
  if (!harvestReceipt || harvestReceipt.version !== 1 ||
      !/^[0-9a-f]{64}$/.test(harvestReceipt.outputSha256 || '') ||
      !/^[0-9a-f]{40,64}$/.test(harvestReceipt.seat?.head || '') ||
      !/^[0-9a-f]{64}$/.test(harvestReceipt.seat?.statusSha256 || '') ||
      harvestReceipt.seat?.clean !== true ||
      harvestReceipt.seat?.branchRef !== recorded?.branchRef) {
    throw unsafeCleanup('managed worktree was not clean when output was harvested');
  }
  let seat;
  try {
    seat = verifyLaneSeat(repoRoot, recorded);
  } catch (error) {
    if (error.code === 'SEAT_IDENTITY_MISMATCH') throw unsafeCleanup(error.message);
    throw error;
  }
  const head = git(seat.path, ['rev-parse', '--verify', 'HEAD']).trim().toLowerCase();
  if (head !== harvestReceipt.seat.head) {
    throw unsafeCleanup('managed worktree HEAD changed after output harvest');
  }
  if (!cleanupStatus(seat.path).clean) {
    throw unsafeCleanup(`refusing to remove dirty managed worktree: ${seat.path}`);
  }
  return seat;
}

function removeManagedSeat(repoRoot, laneId, harvestReceipt, env = process.env) {
  return mutateLane(repoRoot, laneId, (lane) => {
    if (!['archivedVerified', 'cleanupEligible'].includes(lane.state)) {
      throw unsafeCleanup('managed worktree cleanup requires verified provider retirement');
    }
    if (lane.seat?.managed !== true) throw unsafeCleanup('lane seat is not operator-managed');
    if (!fs.existsSync(lane.seat.path)) {
      if (!harvestReceipt || harvestReceipt.version !== 1 ||
          harvestReceipt.seat?.branchRef !== lane.seat.branchRef ||
          !/^[0-9a-f]{40,64}$/.test(harvestReceipt.seat?.head || '')) {
        throw unsafeCleanup('managed worktree cleanup requires its exact harvest receipt');
      }
      const project = resolveProject(repoRoot);
      if (project.commonDir !== lane.seat.gitCommonDir) {
        throw unsafeCleanup('managed lane seat belongs to a different Git repository');
      }
      const remaining = parseWorktreeList(git(project.root, ['worktree', 'list', '--porcelain', '-z']));
      if (remaining.some((entry) => path.resolve(entry.path) === lane.seat.path)) {
        throw unsafeCleanup(`managed worktree path is absent but Git still lists it: ${lane.seat.path}`);
      }
      const branchHead = git(project.root, ['rev-parse', '--verify', lane.seat.branchRef]).trim().toLowerCase();
      if (branchHead !== harvestReceipt.seat.head) {
        throw unsafeCleanup('managed worktree branch HEAD changed after output harvest');
      }
      return {
        patch: { state: 'worktreeRemoved', lastVerifiedAt: new Date().toISOString() },
        value: { ...lane.seat, alreadyRemoved: true },
      };
    }
    const seat = verifyHarvestedSeatForCleanup(repoRoot, lane.seat, harvestReceipt);
    const project = resolveProject(repoRoot);
    git(project.root, ['worktree', 'remove', '--', seat.path]);
    if (fs.existsSync(seat.path)) {
      throw unsafeCleanup(`Git reported success but managed worktree still exists: ${seat.path}`);
    }
    const remaining = parseWorktreeList(git(project.root, ['worktree', 'list', '--porcelain', '-z']));
    if (remaining.some((entry) => path.resolve(entry.path) === seat.path)) {
      throw unsafeCleanup(`Git reported success but still lists managed worktree: ${seat.path}`);
    }
    const branchHead = git(project.root, ['rev-parse', '--verify', seat.branchRef]).trim().toLowerCase();
    if (branchHead !== harvestReceipt.seat.head) {
      try {
        git(project.root, ['worktree', 'add', '-q', '--', seat.path, seat.branchRef]);
      } catch {}
      throw unsafeCleanup('managed worktree branch HEAD changed during removal; its branch was preserved');
    }
    return {
      patch: { state: 'worktreeRemoved', lastVerifiedAt: new Date().toISOString() },
      value: seat,
    };
  }, env);
}

module.exports = {
  canonicalFuturePath,
  captureHarvestReceipt,
  containsPath,
  createManagedSeat,
  isPermanentCleanupError,
  materializeManagedSeat,
  parseWorktreeList,
  planManagedSeat,
  requireIgnoredManagedRoot,
  removeManagedSeat,
  verifyLaneSeat,
  verifyHarvestedSeatForCleanup,
  verifyManagedSeatIntent,
  verifyRecordedSeat,
  verifySeat,
};
