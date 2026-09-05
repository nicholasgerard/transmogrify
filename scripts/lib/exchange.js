'use strict';

// Portable lane exchange and harvest. The child receives one worktree-local
// packet, writes one bounded handback, and never needs access to private
// operator state or Git metadata. The host treats that handback only as text.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { TextDecoder } = require('node:util');
const { sanitizedGitEnv } = require('./git-env');
const {
  beginLaneOperation,
  completeLaneOperation,
  listOperations,
  pendingOperationForLane,
  requireOwnedLane,
  settleTerminalLaneOperationPointer,
  stateRoot,
  updatePendingLaneOperation,
  withLaneLease,
} = require('./state');
const {
  cleanupStatus,
  provisionSeat,
  removeProvisionedEntries,
  validateProvisionedEntries,
  verifyLaneSeat,
} = require('./worktree');

const MAX_HANDBACK_BYTES = 64 * 1024;
const REQUIRED_SECTIONS = Object.freeze([
  'Commit',
  'What changed and why',
  'Verified',
  'Not verified',
  'Risks and decisions for the operator',
]);

function exchangePaths(seatPath) {
  const directory = path.join(seatPath, '.transmogrify');
  return {
    directory,
    packet: path.join(directory, 'packet.md'),
    handback: path.join(directory, 'handback.md'),
  };
}

// This is deliberately the only child-facing contract injected by adapters.
// JSON quoting keeps even an unusual absolute path on one inert text line.
function exchangePreamble(seatPath) {
  const paths = exchangePaths(seatPath);
  return `# Transmogrify lane exchange

Your assigned worktree is ${JSON.stringify(seatPath)}.
Write only inside this directory and /tmp.
Do not commit. The operator commits your work under the title and body you hand back.
Before finishing, write ${JSON.stringify(paths.handback)} with exactly these sections:
Start with # Handback: <packet name>.

## Commit

A one-line imperative title between 10 and 72 characters, then a blank line and the commit body.

## What changed and why

## Verified

## Not verified

## Risks and decisions for the operator

End your final message with DONE, or BLOCKED and the reason.

---`;
}

function prependExchangePreamble(seatPath, input) {
  return `${exchangePreamble(seatPath)}\n\n${input}`;
}

function writePacket(repoRoot, seat, packet) {
  if (typeof packet !== 'string') throw coded('USAGE_ERROR', 'spawn packet must be text');
  const provisioned = provisionSeat(repoRoot, seat);
  const paths = exchangePaths(provisioned.path);
  let descriptor;
  try {
    const existingReceipt = provisioned.packetReceipt;
    if (existingReceipt !== undefined &&
        (!existingReceipt || typeof existingReceipt !== 'object' ||
          Object.keys(existingReceipt).sort().join(',') !== 'dev,ino' ||
          !Number.isSafeInteger(existingReceipt.dev) || existingReceipt.dev < 0 ||
          !Number.isSafeInteger(existingReceipt.ino) || existingReceipt.ino < 0)) {
      throw coded('SEAT_MISMATCH', 'lane packet has an invalid creation receipt');
    }
    descriptor = fs.openSync(paths.packet, existingReceipt
      ? fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0)
      : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0), 0o600);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw coded('SEAT_MISMATCH', 'lane packet path is not an owner-written regular file');
    }
    if (existingReceipt &&
        (stat.dev !== existingReceipt.dev || stat.ino !== existingReceipt.ino)) {
      throw coded('SEAT_MISMATCH', 'lane packet no longer matches its creation receipt');
    }
    fs.fchmodSync(descriptor, 0o600);
    if (existingReceipt) fs.ftruncateSync(descriptor, 0);
    fs.writeFileSync(descriptor, packet, { encoding: 'utf8' });
    provisioned.packetReceipt = { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (error.code === 'SEAT_MISMATCH') throw error;
    throw coded('SEAT_MISMATCH', 'lane packet could not be written safely');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return { seat: provisioned, exchange: { packet: paths.packet, handback: paths.handback } };
}

function coded(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function stripControlCharacters(value) {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '');
}

function readBoundedText(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_HANDBACK_BYTES ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw coded('HARVEST_MISMATCH', 'handback must be a bounded owner-written regular file');
    }
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(16 * 1024, MAX_HANDBACK_BYTES + 1 - total));
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_HANDBACK_BYTES) {
        throw coded('HARVEST_MISMATCH', 'handback exceeds the 64 KiB bound');
      }
      chunks.push(chunk.subarray(0, count));
    }
    const bytes = Buffer.concat(chunks);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
      throw coded('HARVEST_MISMATCH', 'handback must be valid UTF-8 text');
    }
    return stripControlCharacters(text);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'HARVEST_MISMATCH') throw error;
    throw coded('HARVEST_MISMATCH', 'handback could not be read safely');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseHandback(text) {
  if (typeof text !== 'string') throw coded('HARVEST_REQUIRED', 'lane handback is missing');
  text = stripControlCharacters(text);
  if (!/^# Handback: [^\n]+\n/u.test(text)) {
    throw coded('HARVEST_MISMATCH', 'handback is missing its title');
  }
  const matches = [...text.matchAll(/^## ([^\n]+)\n/gmu)];
  const sections = new Map();
  for (let index = 0; index < matches.length; index += 1) {
    const name = matches[index][1].trim();
    if (sections.has(name)) throw coded('HARVEST_MISMATCH', `handback repeats section ${name}`);
    const start = matches[index].index + matches[index][0].length;
    const end = matches[index + 1]?.index ?? text.length;
    sections.set(name, text.slice(start, end).trimEnd());
  }
  for (const required of REQUIRED_SECTIONS) {
    if (!sections.has(required) || !sections.get(required).trim()) {
      throw coded('HARVEST_MISMATCH', `handback is missing section ${required}`);
    }
  }
  const commit = sections.get('Commit').trim();
  const match = /^([^\n]+)\n[ \t]*\n([\s\S]+)$/u.exec(commit);
  if (!match) throw coded('HARVEST_MISMATCH', 'handback commit requires a title, blank line, and body');
  const title = match[1];
  const body = match[2].trim();
  const titleLength = [...title].length;
  if (title !== title.trim() || titleLength < 10 || titleLength > 72 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(title)) {
    throw coded('HARVEST_MISMATCH', 'handback commit title must be one clean line of 10 to 72 characters');
  }
  if (!body || /\u0000/u.test(body)) {
    throw coded('HARVEST_MISMATCH', 'handback commit body must be non-empty text');
  }
  return { text, title, body, sections: Object.fromEntries(sections) };
}

function readHandback(seatPath) {
  const text = readBoundedText(exchangePaths(seatPath).handback);
  return text === null ? null : parseHandback(text);
}

function gitBuffer(seatPath, args, options = {}) {
  try {
    return execFileSync('git', ['-C', seatPath, ...args], {
      encoding: null,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: sanitizedGitEnv(options.env || process.env),
      ...(options.input === undefined ? {} : { input: options.input }),
    });
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw coded('HARVEST_MISMATCH', `git ${args[0]} failed during harvest: ${detail}`);
  }
}

function gitText(seatPath, args, options) {
  return gitBuffer(seatPath, args, options).toString('utf8').trim();
}

function safeRelativePath(file) {
  return typeof file === 'string' && file && !path.isAbsolute(file) &&
    file !== '..' && !file.startsWith('../') && !file.includes('\0');
}

function isProvisioned(file, provisioned = []) {
  const names = validateProvisionedEntries(provisioned).entries.map((entry) =>
    typeof entry === 'string' ? entry : entry.name);
  return file === '.transmogrify' || file.startsWith('.transmogrify/') ||
    names.some((entry) => file === entry || file.startsWith(`${entry}/`));
}

function changedFiles(seat) {
  const tracked = gitBuffer(seat.path, ['diff', '--name-only', '-z', 'HEAD', '--'])
    .toString('utf8').split('\0').filter(Boolean);
  const untracked = gitBuffer(seat.path, ['ls-files', '--others', '--exclude-standard', '-z', '--'])
    .toString('utf8').split('\0').filter(Boolean);
  const files = [...new Set([...tracked, ...untracked])]
    .filter((file) => !isProvisioned(file, seat.provisioned));
  if (files.some((file) => !safeRelativePath(file))) {
    throw coded('HARVEST_MISMATCH', 'Git returned an unsafe changed path');
  }
  return files.sort();
}

function providerAttribution(lane) {
  if (lane.target === 'claude' || lane.backend.startsWith('claude')) {
    return 'Claude Code <noreply@anthropic.com>';
  }
  return 'Codex <noreply@openai.com>';
}

function commitMessage(handback, lane) {
  return `${handback.title}\n\n${handback.body}\n\nCo-Authored-By: ${providerAttribution(lane)}\n`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stageChanges(seat, files) {
  if (files.length === 0) throw coded('HARVEST_MISMATCH', 'harvest has no repository changes to commit');
  const pathspecs = files.map((file) => `:(top,literal)${file}`);
  gitBuffer(seat.path, ['add', '-A', '--', ...pathspecs]);
  const staged = gitBuffer(seat.path, ['diff', '--cached', '--name-only', '-z', '--'])
    .toString('utf8').split('\0').filter(Boolean).sort();
  if (staged.some((file) => isProvisioned(file, seat.provisioned))) {
    throw coded('HARVEST_MISMATCH', 'a provisioned entry is staged and cannot be committed');
  }
  const observed = changedFiles(seat);
  if (JSON.stringify(observed) !== JSON.stringify(files)) {
    throw coded('HARVEST_MISMATCH', 'worktree changes moved while harvest was staging them');
  }
  return { staged, tree: gitText(seat.path, ['write-tree']) };
}

function readOperatorIdentity(seatPath) {
  const identityEnv = Object.fromEntries([
    ['HOME', process.env.HOME],
    ['PATH', process.env.PATH],
    ['USER', process.env.USER],
    ['LOGNAME', process.env.LOGNAME],
    ['XDG_CONFIG_HOME', process.env.XDG_CONFIG_HOME],
    ['GIT_CONFIG_NOSYSTEM', '1'],
  ].filter(([, value]) => value !== undefined));
  const read = (key) => {
    try {
      return execFileSync('git', ['-C', seatPath, 'config', '--get', key], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: identityEnv,
      }).trim();
    } catch {
      return '';
    }
  };
  const name = read('user.name');
  const email = read('user.email');
  if (!name || !email || /[\r\n\u0000-\u001f\u007f]/u.test(`${name}${email}`)) {
    throw coded('HARVEST_MISMATCH', 'operator Git identity is not configured safely');
  }
  return { name, email };
}

function createCommit(seat, message) {
  const identity = readOperatorIdentity(seat.path);
  gitBuffer(seat.path, [
    '-c', `user.name=${identity.name}`,
    '-c', `user.email=${identity.email}`,
    '-c', 'commit.gpgSign=false',
    'commit', '--no-verify', '--no-gpg-sign', '--file', '-',
  ], { input: message });
  return gitText(seat.path, ['rev-parse', '--verify', 'HEAD']).toLowerCase();
}

function commitMatches(seat, details) {
  const head = gitText(seat.path, ['rev-parse', '--verify', 'HEAD']).toLowerCase();
  if (head === details.baseHead) return { committed: false, head };
  const parent = gitText(seat.path, ['rev-parse', '--verify', 'HEAD^']).toLowerCase();
  const tree = gitText(seat.path, ['rev-parse', '--verify', 'HEAD^{tree}']).toLowerCase();
  const message = gitBuffer(seat.path, ['show', '-s', '--format=%B', 'HEAD']).toString('utf8').trimEnd();
  if (parent !== details.baseHead || tree !== details.expectedTree ||
      sha256(message) !== details.commitMessageSha256) {
    throw coded('HARVEST_MISMATCH', 'worktree HEAD does not match the pending harvest commit');
  }
  return { committed: true, head };
}

function ensurePrivateDirectory(directory, fsApi = fs) {
  fsApi.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fsApi.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw coded('HARVEST_MISMATCH', 'durable harvest directory is not owner-only');
  }
}

function durableHandbackPath(laneId, env) {
  return path.join(stateRoot(env), 'harvests', laneId, 'handback.md');
}

function immutableHandbackPath(laneId, digest, env) {
  return path.join(stateRoot(env), 'harvests', laneId, `${digest}.md`);
}

function fsyncDirectory(directory, fsApi) {
  const descriptor = fsApi.openSync(directory, 'r');
  try { fsApi.fsyncSync(descriptor); } finally { fsApi.closeSync(descriptor); }
}

function writeImmutableHandback(file, text, expectedSha256, fsApi) {
  let descriptor;
  try {
    descriptor = fsApi.openSync(file, 'wx', 0o600);
    fsApi.writeFileSync(descriptor, text, 'utf8');
    fsApi.fsyncSync(descriptor);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = fsApi.readFileSync(file);
    if (sha256(existing) !== expectedSha256) {
      throw coded('HARVEST_MISMATCH', 'immutable handback copy digest differs');
    }
    return;
  } finally {
    if (descriptor !== undefined) fsApi.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(file), fsApi);
}

function atomicWriteHandback(file, text, fsApi) {
  const temporary = path.join(path.dirname(file), `.handback-${process.pid}-${crypto.randomUUID()}`);
  let descriptor;
  try {
    descriptor = fsApi.openSync(temporary, 'wx', 0o600);
    fsApi.writeFileSync(descriptor, text, 'utf8');
    fsApi.fsyncSync(descriptor);
  } catch (error) {
    try { fsApi.unlinkSync(temporary); } catch {}
    throw error;
  } finally {
    if (descriptor !== undefined) fsApi.closeSync(descriptor);
  }
  fsApi.renameSync(temporary, file);
  fsyncDirectory(path.dirname(file), fsApi);
}

function copyHandback(file, immutableFile, text, fsApi = fs) {
  ensurePrivateDirectory(path.dirname(path.dirname(file)), fsApi);
  ensurePrivateDirectory(path.dirname(file), fsApi);
  const expectedSha256 = sha256(text);
  writeImmutableHandback(immutableFile, text, expectedSha256, fsApi);
  atomicWriteHandback(file, text, fsApi);
  const latest = fsApi.readFileSync(file);
  const immutable = fsApi.readFileSync(immutableFile);
  if (sha256(latest) !== expectedSha256 || sha256(immutable) !== expectedSha256) {
    throw coded('HARVEST_MISMATCH', 'durable handback copy digest differs');
  }
  return expectedSha256;
}

function verifyHandbackCopies(details, fsApi = fs) {
  let latest;
  let immutable;
  try {
    latest = fsApi.readFileSync(details.durableHandback);
    immutable = fsApi.readFileSync(details.immutableHandback);
  } catch {
    throw coded('HARVEST_MISMATCH', 'durable handback copy could not be verified');
  }
  if (details.copiedSha256 !== details.handbackSha256 ||
      sha256(latest) !== details.handbackSha256 ||
      sha256(immutable) !== details.handbackSha256) {
    throw coded('HARVEST_MISMATCH', 'durable handback copy digest differs');
  }
}

function quoteCommand(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}

function retireCommand(repoRoot, lane, digest) {
  const laneScript = path.join(__dirname, '..', 'lane.js');
  const privateArchive = lane.target === 'claude' || lane.backend.startsWith('claude')
    ? ' --private-archive' : '';
  return `node ${quoteCommand(laneScript)} retire --repo-root ${quoteCommand(repoRoot)} --lane ${quoteCommand(lane.laneId)}${privateArchive} --harvested-output-sha256 ${digest}`;
}

function resultFor(lane, operation, details) {
  return {
    version: 1,
    ok: true,
    operation: 'harvest',
    operationId: operation?.operationId || null,
    laneId: lane.laneId,
    adapter: lane.backend,
    handback: details.handbackSha256 ? 'present' : 'missing',
    changedFiles: details.changedFiles || [],
    head: details.head || details.baseHead,
    handbackSha256: details.handbackSha256 || null,
    retireCommand: details.handbackSha256
      ? retireCommand(details.repoRoot, lane, details.handbackSha256) : null,
  };
}

function lastCompletedHarvest(repoRoot, laneId, env) {
  return listOperations(repoRoot, env)
    .filter((entry) => entry.type === 'harvest' && entry.laneId === laneId && entry.state === 'complete')
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0] || null;
}

async function harvestLane(options, env = process.env, dependencies = {}) {
  if (!options.repoRoot || !path.isAbsolute(options.repoRoot) || !options.laneId) {
    throw coded('USAGE_ERROR', 'harvest requires absolute repoRoot and --lane');
  }
  return withLaneLease(options.repoRoot, options.laneId, async () => {
    let lane = requireOwnedLane(options.repoRoot, options.laneId, env);
    const seat = verifyLaneSeat(options.repoRoot, lane.seat);
    let operation = pendingOperationForLane(options.repoRoot, lane.laneId, env);
    const observation = dependencies.observe ? await dependencies.observe(lane) : null;
    if (!['idle', 'stopped', 'completed', 'retired'].includes(observation?.phase)) {
      const nextReadOnlyStep = `lane.js status --lane ${lane.laneId}`;
      throw coded(
        'TARGET_ACTIVE',
        `lane is not confirmed quiescent; run ${nextReadOnlyStep}`,
        { laneId: lane.laneId, nextReadOnlyStep, ownerAction: nextReadOnlyStep },
      );
    }
    if (operation && operation.type !== 'harvest') {
      throw coded('PENDING_OPERATION', `lane has unresolved ${operation.type} operation`, {
        laneId: lane.laneId, pendingType: operation.type, pendingState: operation.state,
      });
    }
    if (operation?.state === 'complete') {
      settleTerminalLaneOperationPointer(options.repoRoot, lane.laneId, env);
      return resultFor(lane, operation, operation.details);
    }

    if (!operation) {
      const handback = readHandback(seat.path);
      const completed = lastCompletedHarvest(options.repoRoot, lane.laneId, env);
      if (!handback && completed) return resultFor(lane, completed, completed.details);
      if (!handback) {
        return resultFor(lane, null, {
          repoRoot: options.repoRoot,
          baseHead: gitText(seat.path, ['rev-parse', '--verify', 'HEAD']).toLowerCase(),
          changedFiles: changedFiles(seat),
        });
      }
      const files = changedFiles(seat);
      const message = commitMessage(handback, lane);
      operation = beginLaneOperation(options.repoRoot, lane.laneId, {
        type: 'harvest',
        providerId: lane.providerId,
        details: {
          repoRoot: options.repoRoot,
          commit: options.commit === true,
          cleanupProvisioned: options.cleanupProvisioned !== false,
          baseHead: gitText(seat.path, ['rev-parse', '--verify', 'HEAD']).toLowerCase(),
          changedFiles: files,
          handbackSha256: sha256(handback.text),
          commitTitleSha256: sha256(handback.title),
          commitMessageSha256: sha256(message.trimEnd()),
          durableHandback: durableHandbackPath(lane.laneId, env),
          immutableHandback: immutableHandbackPath(lane.laneId, sha256(handback.text), env),
        },
      }, env);
    } else if (operation.details.commit !== (options.commit === true) ||
        operation.details.cleanupProvisioned !== (options.cleanupProvisioned !== false)) {
      throw coded('HARVEST_MISMATCH', 'harvest flags do not match the pending journal');
    }

    const details = operation.details;
    const handbackText = readBoundedText(exchangePaths(seat.path).handback) ||
      readBoundedText(details.durableHandback);
    const handback = parseHandback(handbackText);
    if (sha256(handback.text) !== details.handbackSha256 ||
        sha256(handback.title) !== details.commitTitleSha256) {
      throw coded('HARVEST_MISMATCH', 'handback changed after harvest began');
    }

    if (details.commit) {
      if (operation.state === 'planned') {
        const staged = stageChanges(seat, details.changedFiles);
        operation = updatePendingLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
          state: 'staged', details: { ...operation.details, expectedTree: staged.tree },
        }, env);
      }
      if (['staged', 'commitDispatching'].includes(operation.state)) {
        let observed = commitMatches(seat, operation.details);
        if (!observed.committed) {
          if (gitText(seat.path, ['write-tree']) !== operation.details.expectedTree) {
            throw coded('HARVEST_MISMATCH', 'staged tree changed during harvest');
          }
          if (operation.state === 'staged') {
            operation = updatePendingLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
              state: 'commitDispatching', details: operation.details,
            }, env);
          }
          const message = commitMessage(handback, lane);
          createCommit(seat, message);
          if (dependencies.afterCommit) await dependencies.afterCommit();
          observed = commitMatches(seat, operation.details);
        }
        operation = updatePendingLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
          state: 'committed', details: { ...operation.details, head: observed.head },
        }, env);
      }
    }

    if (['planned', 'committed', 'copying'].includes(operation.state)) {
      if (operation.state !== 'copying') {
        operation = updatePendingLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
          state: 'copying', details: operation.details,
        }, env);
      }
      const copiedSha256 = copyHandback(
        operation.details.durableHandback,
        operation.details.immutableHandback,
        handback.text,
        dependencies.fs || fs,
      );
      operation = updatePendingLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
        state: 'copied', details: { ...operation.details, copiedSha256 },
      }, env);
      if (dependencies.afterCopy) await dependencies.afterCopy(operation);
    }

    if (['copied', 'cleanupDispatching', 'cleanupComplete'].includes(operation.state)) {
      verifyHandbackCopies(operation.details, dependencies.fs || fs);
    }

    if (operation.details.cleanupProvisioned &&
        ['copied', 'cleanupDispatching'].includes(operation.state)) {
      if (operation.state === 'copied') {
        operation = updatePendingLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
          state: 'cleanupDispatching', details: operation.details,
        }, env);
      }
      removeProvisionedEntries(seat);
      operation = updatePendingLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
        state: 'cleanupComplete', details: operation.details,
      }, env);
    }

    if (operation.state === 'copied' || operation.state === 'cleanupComplete') {
      const head = gitText(seat.path, ['rev-parse', '--verify', 'HEAD']).toLowerCase();
      const census = cleanupStatus(seat.path, seat.provisioned);
      operation = completeLaneOperation(options.repoRoot, lane.laneId, operation.operationId, {
        state: 'complete',
        details: { ...operation.details, head, statusSha256: census.sha256, clean: census.clean },
      }, env);
    }
    lane = requireOwnedLane(options.repoRoot, lane.laneId, env);
    return resultFor(lane, operation, operation.details);
  }, env);
}

module.exports = {
  MAX_HANDBACK_BYTES,
  REQUIRED_SECTIONS,
  changedFiles,
  copyHandback,
  exchangePaths,
  exchangePreamble,
  harvestLane,
  immutableHandbackPath,
  parseHandback,
  prependExchangePreamble,
  readHandback,
  stripControlCharacters,
  writePacket,
};
