'use strict';

// Managed Git worktree seats: planning an immutable seat intent, materializing
// it, verifying a recorded seat's identity, capturing the pre-retirement harvest
// receipt, and removing a seat only after provider retirement is verified. A
// seat must be a real, owner-controlled, symlink-free worktree of this exact
// repository. Cleanup never removes a seat that is dirty, whose HEAD moved, or
// that Git still lists, and an unsafe observation blocks it permanently.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sanitizedGitEnv } = require('./git-env');
const { mutateLane, resolveProject } = require('./state');

// A permanent cleanup refusal: observed dirt, a changed HEAD, or an inconsistent
// Git view. Once raised, automatic cleanup stays blocked pending manual review;
// later cleanliness does not make the seat eligible again.
class UnsafeCleanupStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeCleanupStateError';
    this.code = 'UNSAFE_CLEANUP_STATE';
  }
}

// The seat is not the exact recorded worktree, or its ancestry is not
// owner-controlled. Always raised before any provider mutation.
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

// Separates a permanent unsafe-state refusal from a transient local failure,
// which callers report as retryable with no further provider mutation.
function isPermanentCleanupError(error) {
  return error?.code === 'UNSAFE_CLEANUP_STATE';
}

// One Git invocation in the sanitized environment. A non-zero exit throws with
// the child's stderr and is never read as an empty result.
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

// True only when child is strictly inside parent. Equality and traversal both
// return false, so a seat can never claim its own root.
function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// A real directory owned by this user with no group or world write bits.
// Anything else is a seat identity refusal.
function requireOwnerControlledDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (stat.mode & 0o022) !== 0) {
    throw seatIdentity(`refusing non-owner-controlled ${label}: ${directory}`);
  }
}

// A managed WORKTREES root must be 0700; any group or world access is refused.
function requirePrivateManagedRoot(directory) {
  const stat = fs.lstatSync(directory);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`refusing non-private managed WORKTREES directory: ${directory}`);
  }
}

// A WORKTREES root inside the repository must be ignored by Git, so managed
// seats can never be staged or committed. A root outside it is unaffected.
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

// An external WORKTREES root must not sit inside any other Git worktree,
// including a linked one. A path in no repository at all is accepted.
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

// Parse the NUL-delimited porcelain worktree listing into one record per
// worktree, keyed by its first field.
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

// Resolve a path that may not exist yet, requiring its nearest existing ancestor
// to be owner-controlled and the resolved result to contain no symlink.
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

// Prove that a path is a usable lane seat: no symlink traversal, inside an
// owner-controlled WORKTREES root that lies outside the Git common directory and
// is ignored where it is in-repository, a Git-recognized worktree of this exact
// repository checked out on a local branch, and never the operator checkout.
// Returns the seat identity including its device and inode receipt.
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

// Plan and materialize a managed seat in one step. Spawn paths split the two so
// the intent becomes durable before anything is created.
function createManagedSeat(repoRoot, worktreesRoot, laneId, options = {}) {
  const intent = planManagedSeat(repoRoot, worktreesRoot, laneId, options);
  return materializeManagedSeat(repoRoot, intent);
}

// Reserve the immutable seat intent before anything is created: seat path,
// branch ref, and base commit. A branch of that name already existing is
// refused, so a fresh managed seat never adopts unrelated history.
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
  let existingBranch = null;
  try {
    existingBranch = git(project.root, ['show-ref', '--verify', '--hash', `refs/heads/${branchName}`]).trim();
  } catch {}
  if (existingBranch !== null) {
    // A fresh managed seat never adopts a branch that already exists; only a
    // durable seat intent may re-materialize the branch it reserved.
    throw new Error(`managed branch already exists: ${branchName}`);
  }
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

// Re-prove a durable seat intent against the current repository before
// materializing it: same Git common directory, same canonical WORKTREES root,
// and the lane's own path directly under that root.
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

// Create the worktree the intent reserved, or adopt an existing seat that
// matches it exactly. A path or branch collision is refused, as is a branch
// whose commit no longer equals the reserved base, so recovery can re-run this
// without silently binding a different tree.
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
    return provisionSeat(project.root, { ...existing, managed: true });
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
  return provisionSeat(project.root, { ...seat, managed: true });
}

// Entries the operator creates in a lane seat. They are kept relative to the
// seat root so later census and cleanup code can match exactly these paths.
function plannedProvisionedEntries(repoRoot) {
  const project = resolveProject(repoRoot);
  const entries = ['.transmogrify'];
  if (fs.existsSync(path.join(project.root, 'package.json')) &&
      fs.existsSync(path.join(project.root, 'node_modules'))) {
    entries.push('node_modules');
  }
  return entries;
}

function validateProvisionedEntries(entries, label = 'provisioned entries') {
  if (!Array.isArray(entries) || new Set(entries).size !== entries.length ||
      entries.some((entry) => typeof entry !== 'string' || !entry ||
        path.isAbsolute(entry) || entry === '.' || entry === '..' ||
        entry.includes('/') || entry.includes('\\') || /[\u0000-\u001f\u007f]/u.test(entry))) {
    throw seatIdentity(`${label} must contain unique safe top-level relative paths`);
  }
  return entries;
}

function ensureExchangeExclude(project) {
  const infoDirectory = path.join(project.commonDir, 'info');
  const excludeFile = path.join(infoDirectory, 'exclude');
  fs.mkdirSync(infoDirectory, { recursive: true });
  const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
  if (current.split(/\r?\n/u).includes('.transmogrify/')) return;
  fs.appendFileSync(excludeFile, `${current && !current.endsWith('\n') ? '\n' : ''}.transmogrify/\n`);
}

function ensureDirectory(target, label) {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { mode: 0o700 });
    return;
  }
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw seatIdentity(`${label} must be a real directory: ${target}`);
  }
}

// Provision a materialized seat without copying dependencies. Existing entries
// are accepted only when they are exactly the directory or symlink we create.
function provisionSeat(repoRoot, recorded) {
  const project = resolveProject(repoRoot);
  const seat = verifySeat(project.root, recorded.path, recorded.worktreesRoot);
  const provisioned = plannedProvisionedEntries(project.root);
  for (const entry of provisioned) {
    if (git(seat.path, ['ls-files', '--', entry]).trim()) {
      throw seatIdentity(`refusing to provision tracked lane entry: ${entry}`);
    }
  }
  ensureExchangeExclude(project);
  ensureDirectory(path.join(seat.path, '.transmogrify'), 'lane exchange directory');
  if (provisioned.includes('node_modules')) {
    const source = path.join(project.root, 'node_modules');
    const target = path.join(seat.path, 'node_modules');
    if (!pathEntryExists(target)) {
      fs.symlinkSync(source, target, 'dir');
    } else {
      const stat = fs.lstatSync(target);
      if (!stat.isSymbolicLink() || fs.realpathSync(target) !== fs.realpathSync(source)) {
        throw seatIdentity(`refusing to replace existing lane dependency entry: ${target}`);
      }
    }
  }
  return { ...recorded, provisioned };
}

// A managed lane's recorded seat must still verify with the same path, root,
// repository, branch, device, and inode.
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
  if (recorded.provisioned !== undefined) validateProvisionedEntries(recorded.provisioned);
  return {
    ...current,
    managed: true,
    ...(recorded.provisioned === undefined ? {} : { provisioned: [...recorded.provisioned] }),
  };
}

// The seat check every mutation runs first, for managed and external seats
// alike. Any drift is SEAT_IDENTITY_MISMATCH before a provider is contacted.
function verifyLaneSeat(repoRoot, recorded) {
  if (!recorded) throw seatIdentity('lane has no recorded seat');
  if (recorded.managed === true) return verifyRecordedSeat(repoRoot, recorded);
  const current = verifySeat(repoRoot, recorded.path, recorded.worktreesRoot);
  for (const key of ['path', 'worktreesRoot', 'gitCommonDir', 'branchRef', 'device', 'inode']) {
    if (current[key] !== recorded[key]) {
      throw seatIdentity(`lane seat identity changed (${key}): ${recorded.path}`);
    }
  }
  if (recorded.provisioned !== undefined) validateProvisionedEntries(recorded.provisioned);
  return {
    ...current,
    ...(recorded.provisioned === undefined ? {} : { provisioned: [...recorded.provisioned] }),
  };
}

// The durable pre-retirement receipt: the caller's harvested output digest plus
// the seat's branch, HEAD, and a digest of its complete visible and ignored file
// census. Cleanup is later checked against exactly this receipt.
function captureHarvestReceipt(repoRoot, recorded, outputSha256) {
  if (!/^[0-9a-f]{64}$/.test(outputSha256 || '')) {
    throw new Error('harvested output digest must be a lowercase SHA-256');
  }
  const seat = verifyLaneSeat(repoRoot, recorded);
  const head = git(seat.path, ['rev-parse', '--verify', 'HEAD']).trim().toLowerCase();
  const status = cleanupStatus(seat.path, seat.provisioned);
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

// The seat's full working-tree census: tracked changes, untracked files, and
// ignored files. Clean means all three are empty.
function cleanupStatus(seatPath, provisioned) {
  const entries = provisioned === undefined ? [] : validateProvisionedEntries(provisioned);
  const exclusions = entries.flatMap((entry) => [
    `:(top,exclude)${entry}`,
    `:(top,exclude)${entry}/**`,
  ]);
  const visible = git(seatPath, [
    'status', '--porcelain=v1', '--untracked-files=all', '--', '.', ...exclusions,
  ]);
  const ignored = git(seatPath, [
    'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', '.', ...exclusions,
  ]);
  return {
    clean: visible.length === 0 && ignored.length === 0,
    sha256: crypto.createHash('sha256')
      .update('visible\0').update(visible).update('\0ignored\0').update(ignored).digest('hex'),
  };
}

// Remove only the exact top-level entries recorded as operator provisions.
// A missing entry is already clean; a symlink is unlinked rather than followed.
function removeProvisionedEntries(recorded) {
  const entries = recorded.provisioned === undefined
    ? [] : validateProvisionedEntries(recorded.provisioned);
  for (const entry of entries) {
    const target = path.join(recorded.path, entry);
    if (!pathEntryExists(target)) continue;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || stat.isFile()) fs.unlinkSync(target);
    else if (stat.isDirectory()) fs.rmSync(target, { recursive: true });
    else throw unsafeCleanup(`refusing unsupported provisioned entry: ${target}`);
  }
  return entries;
}

// Removal is permitted only when the seat was clean at harvest, its identity
// still verifies, its HEAD is unchanged, and its census is still clean. Every
// failure is UNSAFE_CLEANUP_STATE and permanently blocks automatic cleanup.
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
  if (!cleanupStatus(seat.path, seat.provisioned).clean) {
    throw unsafeCleanup(`refusing to remove dirty managed worktree: ${seat.path}`);
  }
  return seat;
}

function pathEntryExists(targetPath) {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Remove a managed seat inside a lane mutation, and only after provider
// retirement is verified. An already-absent seat is accepted only with its exact
// harvest receipt, no surviving Git worktree row, and the preserved branch still
// at the harvested HEAD. After removal it re-checks that Git neither keeps the
// path nor moved the branch, restoring the worktree if the branch changed.
function removeManagedSeat(repoRoot, laneId, harvestReceipt, env = process.env) {
  return mutateLane(repoRoot, laneId, (lane) => {
    if (!['archivedVerified', 'cleanupEligible'].includes(lane.state)) {
      throw unsafeCleanup('managed worktree cleanup requires verified provider retirement');
    }
    if (lane.seat?.managed !== true) throw unsafeCleanup('lane seat is not operator-managed');
    if (!pathEntryExists(lane.seat.path)) {
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
    removeProvisionedEntries(seat);
    if (!cleanupStatus(seat.path).clean) {
      throw unsafeCleanup(`refusing to remove dirty managed worktree: ${seat.path}`);
    }
    const project = resolveProject(repoRoot);
    git(project.root, ['worktree', 'remove', '--', seat.path]);
    if (pathEntryExists(seat.path)) {
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
  cleanupStatus,
  containsPath,
  createManagedSeat,
  isPermanentCleanupError,
  materializeManagedSeat,
  pathEntryExists,
  parseWorktreeList,
  planManagedSeat,
  plannedProvisionedEntries,
  provisionSeat,
  requireIgnoredManagedRoot,
  removeProvisionedEntries,
  removeManagedSeat,
  verifyLaneSeat,
  verifyHarvestedSeatForCleanup,
  verifyManagedSeatIntent,
  verifyRecordedSeat,
  verifySeat,
};
