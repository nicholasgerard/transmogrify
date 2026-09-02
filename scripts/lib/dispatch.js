'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  acquireLock,
  atomicWriteJson,
  releaseLock,
  resolveProject,
  stateRoot,
} = require('./state');

const VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const EVENT_TYPES = new Set([
  'child.spawned',
  'child.turn-completed',
  'child.idle-observed',
  'child.needs-attention',
  'child.failed',
  'child.stopped',
  'child.retired',
  'child.cleanup-blocked',
  'child.delivery-unknown',
]);
const DISPATCH_STATES = new Set(['reserved', 'journaled']);
const MAX_STATE_BYTES = 256 * 1024;
const MAX_VISIBLE_BYTES = 256;
const MAX_PARENT_RECORDS = 1_000;
const MAX_DISPATCH_RECORDS = 10_000;
const MAX_EVENT_RECORDS = 10_000;
const MAX_EVENT_BATCH = 100;
const ATOMIC_TEMP_PATTERN = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;

class DispatchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, normalize(entry[key])]));
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

function assertExactKeys(value, required, optional, label) {
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !keys.includes(key))) {
    throw new DispatchError('INVALID_LOCAL_STATE', `${label} has invalid fields`);
  }
}

function boundedDirectoryEntries(directory, maximum, label) {
  assertPrivateDirectory(directory, label);
  // atomicWriteJson uses this exact private temporary-name shape. A reader may
  // overlap the write, or a process may crash before rename. Such files are
  // never records and must not poison or consume the bounded collection.
  // Dot-prefixed non-JSON entries (for example Finder's .DS_Store) are host
  // metadata, never records; every other unexpected name still fails closed.
  const entries = fs.readdirSync(directory).filter((entry) =>
    !ATOMIC_TEMP_PATTERN.test(entry) && !(entry.startsWith('.') && !entry.endsWith('.json')));
  if (entries.length > maximum) {
    throw new DispatchError('LOCAL_STATE_LIMIT', `${label} exceeds its bounded record limit`);
  }
  return entries;
}

function assertWriteCapacity(count, maximum, label) {
  if (!Number.isSafeInteger(count) || count < 0 ||
      !Number.isSafeInteger(maximum) || maximum < 1) {
    throw new DispatchError('INVALID_LOCAL_STATE', `${label} has an invalid capacity`);
  }
  if (count >= maximum) {
    throw new DispatchError('LOCAL_STATE_LIMIT', `${label} reached its bounded record limit`);
  }
}

function uuidJsonEntries(entries, label) {
  return entries.map((entry) => {
    if (!entry.endsWith('.json') || !UUID_PATTERN.test(entry.slice(0, -5))) {
      throw new DispatchError('INVALID_LOCAL_STATE', `${label} contains an invalid record name`);
    }
    return entry;
  });
}

function uuidFromDigest(hex) {
  const bytes = Buffer.from(hex.slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function pathsFor(env = process.env) {
  const root = stateRoot(env);
  const paths = {
    root,
    installation: path.join(root, 'installation.json'),
    lock: path.join(root, 'dispatch-lock'),
    parents: path.join(root, 'parents'),
    dispatches: path.join(root, 'dispatches'),
    observations: path.join(root, 'observations'),
    events: path.join(root, 'events'),
    acknowledgements: path.join(root, 'acknowledgements'),
  };
  if (fs.existsSync(root)) assertPrivateDirectory(root, 'dispatch state root');
  for (const [key, directory] of Object.entries(paths)) {
    if (key !== 'root' && !['installation', 'lock'].includes(key) && fs.existsSync(directory)) {
      assertPrivateDirectory(directory, `${key} directory`);
    }
  }
  return paths;
}

function readPrivateJson(file, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
        (stat.mode & 0o077) !== 0) {
      throw new DispatchError('UNSAFE_LOCAL_STATE', `${label} is not an owner-only regular file`);
    }
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } catch (error) {
    if (error instanceof DispatchError) throw error;
    if (error.code === 'ENOENT') {
      throw new DispatchError('NOT_OWNED', `${label} does not exist`);
    }
    throw new DispatchError('INVALID_LOCAL_STATE', `${label} is not valid private JSON`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertPrivateDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) !== 0) {
    throw new DispatchError('UNSAFE_LOCAL_STATE', `${label} is not an owner-only directory`);
  }
}

function withInstallationLock(env, callback) {
  const paths = pathsFor(env);
  const owner = acquireLock(paths.lock);
  try { return callback(paths); } finally { releaseLock(paths.lock, owner); }
}

function validateInstallation(record) {
  if (record && typeof record === 'object' && !Array.isArray(record)) {
    assertExactKeys(record, ['schemaVersion', 'installationId', 'createdAt'], [], 'installation record');
  }
  if (record?.schemaVersion !== VERSION || !UUID_PATTERN.test(record.installationId || '') ||
      typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new DispatchError('INVALID_LOCAL_STATE', 'installation record is invalid');
  }
  return record;
}

function installationRecord(paths) {
  if (fs.existsSync(paths.installation)) {
    return validateInstallation(readPrivateJson(paths.installation, 'installation record'));
  }
  const record = {
    schemaVersion: VERSION,
    installationId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  atomicWriteJson(paths.installation, record);
  return record;
}

function assertSafeVisible(value, label, maximum = MAX_VISIBLE_BYTES) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > maximum ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(value) || /[\uD800-\uDFFF]/u.test(value)) {
    throw new DispatchError('USAGE_ERROR', `${label} must be a bounded single-line value`);
  }
  return value;
}

function assertSafeMetadataLabel(value, label) {
  assertSafeVisible(value, label);
  if (path.isAbsolute(value) ||
      /(?:^|[\s"'([{=,:;])\/(?!\/)[^\s"')\]},;]+/u.test(value) ||
      /(?:^|[\s"'([{=,:;])[A-Za-z]:[\\/][^\s"')\]},;]*/u.test(value) ||
      /(?:^|[\s"'([{=,:;])\\\\[^\s"')\]},;]+/u.test(value) ||
      /\b(?:bearer|api[-_ ]?key|access[-_ ]?token|secret|password|credential)\s*(?:[:=]|\s)\s*\S+/iu.test(value)) {
    throw new DispatchError('USAGE_ERROR', `${label} must not contain a path or credential-like value`);
  }
  return value;
}

function validateParent(record, installation) {
  if (record && typeof record === 'object' && !Array.isArray(record)) {
    assertExactKeys(record, [
      'schemaVersion', 'parentRef', 'installationId', 'hostProvider', 'hostApp',
      'displayName', 'nativeTaskRef', 'nextSequence', 'createdAt',
    ], [], 'parent context');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      record.schemaVersion !== VERSION || !UUID_PATTERN.test(record.parentRef || '') ||
      record.installationId !== installation.installationId ||
      !SLUG_PATTERN.test(record.hostProvider || '') || !SLUG_PATTERN.test(record.hostApp || '') ||
      !Number.isSafeInteger(record.nextSequence) || record.nextSequence < 0 ||
      typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new DispatchError('INVALID_LOCAL_STATE', 'parent context is invalid');
  }
  assertSafeMetadataLabel(record.displayName, 'parent display name');
  if (record.nativeTaskRef !== null && record.nativeTaskRef !== undefined) {
    assertSafeVisible(record.nativeTaskRef, 'native task reference', 512);
  }
  return record;
}

function createParentContext(options, env = process.env) {
  if (!SLUG_PATTERN.test(options?.hostProvider || '') || !SLUG_PATTERN.test(options?.hostApp || '')) {
    throw new DispatchError('USAGE_ERROR', 'parent host provider and app must be lowercase slugs');
  }
  assertSafeMetadataLabel(options.displayName, 'parent display name');
  if (options.nativeTaskRef !== undefined) {
    assertSafeVisible(options.nativeTaskRef, 'native task reference', 512);
  }
  return withInstallationLock(env, (paths) => {
    const installation = installationRecord(paths);
    let parentEntries = [];
    if (fs.existsSync(paths.parents)) {
      assertPrivateDirectory(paths.parents, 'parent context directory');
      parentEntries = uuidJsonEntries(
        boundedDirectoryEntries(paths.parents, MAX_PARENT_RECORDS, 'parent context directory'),
        'parent context directory',
      );
    }
    if (options.nativeTaskRef !== undefined && parentEntries.length > 0) {
      const matches = parentEntries
        .map((entry) => ({
          file: path.join(paths.parents, entry),
          parent: validateParent(
            readPrivateJson(path.join(paths.parents, entry), 'parent context'),
            installation,
          ),
        }))
        .filter(({ parent }) => parent.nativeTaskRef === options.nativeTaskRef);
      if (matches.length > 1) {
        throw new DispatchError('INVALID_LOCAL_STATE', 'native parent reference is duplicated');
      }
      if (matches.length === 1) {
        const existing = matches[0];
        if (existing.parent.hostProvider !== options.hostProvider ||
            existing.parent.hostApp !== options.hostApp ||
            existing.parent.displayName !== options.displayName) {
          throw new DispatchError('INVALID_STATE', 'native parent reference is already registered differently');
        }
        return existing;
      }
    }
    assertWriteCapacity(parentEntries.length, MAX_PARENT_RECORDS, 'parent context directory');
    const parentRef = crypto.randomUUID();
    const record = {
      schemaVersion: VERSION,
      parentRef,
      installationId: installation.installationId,
      hostProvider: options.hostProvider,
      hostApp: options.hostApp,
      displayName: options.displayName,
      nativeTaskRef: options.nativeTaskRef ?? null,
      nextSequence: 0,
      createdAt: new Date().toISOString(),
    };
    const file = path.join(paths.parents, `${parentRef}.json`);
    atomicWriteJson(file, record);
    return { parent: record, file };
  });
}

function listParentContexts(env = process.env) {
  const paths = pathsFor(env);
  if (!fs.existsSync(paths.installation) || !fs.existsSync(paths.parents)) return [];
  const installation = validateInstallation(readPrivateJson(paths.installation, 'installation record'));
  return uuidJsonEntries(
    boundedDirectoryEntries(paths.parents, MAX_PARENT_RECORDS, 'parent context directory'),
    'parent context directory',
  )
    .map((entry) => {
      const file = path.join(paths.parents, entry);
      return { parent: validateParent(readPrivateJson(file, 'parent context'), installation), file };
    })
    .sort((left, right) => left.parent.createdAt.localeCompare(right.parent.createdAt));
}

function loadParentContext(file, env = process.env) {
  if (!path.isAbsolute(file || '')) {
    throw new DispatchError('USAGE_ERROR', '--parent-context-file must be absolute');
  }
  const paths = pathsFor(env);
  const supplied = path.resolve(file);
  if (path.dirname(supplied) !== paths.parents ||
      !UUID_PATTERN.test(path.basename(supplied, '.json')) || path.extname(supplied) !== '.json') {
    throw new DispatchError('NOT_OWNED', 'parent context is not registered to this installation');
  }
  const installation = validateInstallation(readPrivateJson(paths.installation, 'installation record'));
  const record = validateParent(readPrivateJson(supplied, 'parent context'), installation);
  const expected = path.join(paths.parents, `${record.parentRef}.json`);
  if (supplied !== path.resolve(expected)) {
    throw new DispatchError('NOT_OWNED', 'parent context is not registered to this installation');
  }
  return { parent: record, file: expected };
}

function ownedParentContext(parentContext, env) {
  if (!parentContext?.parent) return loadParentContext(parentContext, env);
  const paths = pathsFor(env);
  const installation = validateInstallation(readPrivateJson(paths.installation, 'installation record'));
  const supplied = validateParent(parentContext.parent, installation);
  const file = path.join(paths.parents, `${supplied.parentRef}.json`);
  const stored = validateParent(readPrivateJson(file, 'parent context'), installation);
  if (!sameParentIdentity(stored, supplied)) {
    throw new DispatchError('NOT_OWNED', 'parent context does not match its installation record');
  }
  return { parent: stored, file };
}

const PROVIDER_LABELS = new Map([
  ['codex', 'Codex'],
  ['claude', 'Claude Code'],
]);
const APP_LABELS = new Map([
  ['codex-desktop', 'Codex Desktop'],
  ['codex-cli', 'Codex CLI'],
  ['codex-ide', 'Codex IDE'],
  ['codex-web', 'Codex web'],
  ['claude-desktop', 'Claude Desktop'],
  ['claude-code', 'Claude Code'],
  ['claude-cli', 'Claude Code CLI'],
  ['claude-ide', 'Claude Code IDE'],
  ['claude-web', 'Claude web'],
]);
const PROVENANCE_BLOCK_VERSION = 2;
const PROVENANCE_BLOCK_WIDTH = 60;

function profileParts(profile) {
  const requested = profile?.requested || profile?.requestedProfile || {};
  const resolved = profile?.resolved || profile?.resolvedProfile || {};
  const parts = {
    intent: requested.intent || null,
    model: resolved.model?.selector || resolved.model || null,
    effort: resolved.effort?.level || resolved.effort || null,
    setting: resolved.setting?.id || resolved.setting || null,
    speed: resolved.speed?.mode || resolved.speed || null,
  };
  for (const [key, value] of Object.entries(parts)) {
    if (value === null) continue;
    if (typeof value !== 'string') {
      throw new DispatchError('USAGE_ERROR', `profile ${key} must be a string`);
    }
    assertSafeVisible(value, `profile ${key}`, 128);
  }
  return parts;
}

// Every visible value is reduced to printable ASCII. The frame itself uses
// box-drawing characters, so no value can forge a frame line or a label.
function escapeNonAscii(text) {
  return String(text).replace(/[^\x20-\x7e]/gu, (character) =>
    [...character].map((scalar) => {
      const codePoint = scalar.codePointAt(0);
      if (codePoint <= 0xffff) return `\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
      const adjusted = codePoint - 0x10000;
      const high = 0xd800 + (adjusted >> 10);
      const low = 0xdc00 + (adjusted & 0x3ff);
      return `\\u${high.toString(16).toUpperCase()}\\u${low.toString(16).toUpperCase()}`;
    }).join('')
  );
}

function asciiJsonString(value) {
  return escapeNonAscii(JSON.stringify(value));
}

function frameLine(prefix) {
  return `${prefix}${'─'.repeat(Math.max(PROVENANCE_BLOCK_WIDTH - prefix.length, 4))}`;
}

function renderProvenanceBlock(metadata) {
  const parentProvider = assertSafeVisible(metadata.parentProvider, 'parent-provider');
  if (!SLUG_PATTERN.test(parentProvider)) {
    throw new DispatchError('USAGE_ERROR', 'parent-provider must be a lowercase slug');
  }
  const fromApp = assertSafeVisible(metadata.fromApp, 'from-app');
  const parentTask = assertSafeMetadataLabel(metadata.parentTask, 'parent-task');
  if (!UUID_PATTERN.test(metadata.dispatchId || '')) {
    throw new DispatchError('USAGE_ERROR', 'dispatch id must be a UUID');
  }
  const target = assertSafeVisible(metadata.target, 'target');
  const profile = profileParts(metadata.profile);
  const providerLabel = PROVIDER_LABELS.get(parentProvider) || parentProvider;
  const appLabel = APP_LABELS.get(fromApp) || fromApp;
  const from = APP_LABELS.has(fromApp) && appLabel.startsWith(providerLabel)
    ? appLabel
    : `${providerLabel} on ${appLabel}`;
  const to = [
    PROVIDER_LABELS.get(target) || target,
    profile.model,
    profile.effort ? `${profile.effort} effort` : null,
    profile.setting,
    profile.speed ? `${profile.speed} speed` : null,
  ].filter(Boolean).map(escapeNonAscii).join(' · ');
  return [
    frameLine('╭─ Transmogrify dispatch '),
    `│ From      ${escapeNonAscii(from)}`,
    `│ Task      ${asciiJsonString(parentTask)}`,
    `│ To        ${to}`,
    `│ Intent    ${escapeNonAscii(profile.intent || 'provider-default')}`,
    `│ Dispatch  ${metadata.dispatchId}`,
    frameLine(`╰─ v${PROVENANCE_BLOCK_VERSION} · the parent is notified when you finish `),
  ].join('\n');
}

function validateLineage(lineage) {
  if (!lineage || typeof lineage !== 'object' || Array.isArray(lineage) ||
      lineage.version !== VERSION || !UUID_PATTERN.test(lineage.dispatchId || '') ||
      !UUID_PATTERN.test(lineage.parentRef || '') || !UUID_PATTERN.test(lineage.installationId || '')) {
    throw new DispatchError('INVALID_LOCAL_STATE', 'lane lineage is invalid');
  }
  return lineage;
}

function reserveDispatch(options, env = process.env) {
  const parent = options?.parentContext?.parent || options?.parentContext;
  const prompt = options?.prompt;
  if (!parent || typeof prompt !== 'string' || !prompt || !UUID_PATTERN.test(options.laneId || '') ||
      !SLUG_PATTERN.test(options.targetProvider || '') || typeof options.backend !== 'string' ||
      !options.backend || typeof options.displayName !== 'string' || !options.displayName) {
    throw new DispatchError('USAGE_ERROR', 'dispatch requires parent, lane, target, backend, name, and prompt');
  }
  if (Buffer.byteLength(prompt, 'utf8') > 64 * 1024 || prompt.includes('\0') ||
      /[\uD800-\uDFFF]/u.test(prompt)) {
    throw new DispatchError('USAGE_ERROR', 'dispatch prompt is not safe and bounded');
  }
  return withInstallationLock(env, (paths) => {
    const installation = installationRecord(paths);
    const storedParent = validateParent(
      readPrivateJson(path.join(paths.parents, `${parent.parentRef}.json`), 'parent context'),
      installation,
    );
    if (!sameParentIdentity(storedParent, parent)) {
      throw new DispatchError('NOT_OWNED', 'parent context changed after loading');
    }
    const dispatchId = options.dispatchId || crypto.randomUUID();
    if (!UUID_PATTERN.test(dispatchId)) throw new DispatchError('USAGE_ERROR', 'dispatch id is invalid');
    const provenance = renderProvenanceBlock({
      parentProvider: storedParent.hostProvider,
      fromApp: storedParent.hostApp,
      parentTask: storedParent.displayName,
      dispatchId,
      target: options.targetProvider,
      profile: options.profile,
    });
    const renderedPrompt = `${provenance}\n\n${prompt}`;
    const project = resolveProject(options.repoRoot);
    const projectKey = digest(project.commonDir);
    const receipts = {
      bodySha256: digest(prompt),
      provenanceSha256: digest(provenance),
      renderedSha256: digest(renderedPrompt),
    };
    const lineage = {
      version: VERSION,
      dispatchId,
      parentRef: storedParent.parentRef,
      installationId: installation.installationId,
    };
    const record = {
      schemaVersion: VERSION,
      dispatchId,
      installationId: installation.installationId,
      parentRef: storedParent.parentRef,
      parent: {
        hostProvider: storedParent.hostProvider,
        hostApp: storedParent.hostApp,
        displayName: storedParent.displayName,
      },
      child: {
        projectKey,
        repoRoot: project.root,
        gitCommonDir: project.commonDir,
        laneId: options.laneId,
        targetProvider: options.targetProvider,
        backend: options.backend,
        displayName: options.displayName,
      },
      requestedProfile: options.profile?.requested || options.profile?.requestedProfile || null,
      resolvedProfile: options.profile?.resolved || options.profile?.resolvedProfile || null,
      observedProfile: options.profile?.observed || options.profile?.observedProfile || null,
      promptReceipts: receipts,
      state: 'reserved',
      createdAt: new Date().toISOString(),
    };
    const file = path.join(paths.dispatches, `${dispatchId}.json`);
    if (fs.existsSync(file)) throw new DispatchError('INVALID_STATE', 'dispatch id is already reserved');
    const dispatchEntries = fs.existsSync(paths.dispatches)
      ? uuidJsonEntries(
        boundedDirectoryEntries(paths.dispatches, MAX_DISPATCH_RECORDS, 'dispatch directory'),
        'dispatch directory',
      )
      : [];
    assertWriteCapacity(dispatchEntries.length, MAX_DISPATCH_RECORDS, 'dispatch directory');
    atomicWriteJson(file, record);
    return { dispatch: record, lineage, renderedPrompt, provenance, receipts };
  });
}

function sameParentIdentity(left, right) {
  return [
    'schemaVersion', 'parentRef', 'installationId', 'hostProvider', 'hostApp',
    'displayName', 'nativeTaskRef', 'createdAt',
  ].every((key) => canonicalJson(left?.[key]) === canonicalJson(right?.[key]));
}

function validateDispatch(record, installation, expectedId = null) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new DispatchError('INVALID_LOCAL_STATE', 'dispatch record is invalid');
  }
  assertExactKeys(record, [
    'schemaVersion', 'dispatchId', 'installationId', 'parentRef', 'parent', 'child',
    'requestedProfile', 'resolvedProfile', 'observedProfile', 'promptReceipts',
    'state', 'createdAt',
  ], ['journaledAt'], 'dispatch record');
  assertExactKeys(record.parent, ['hostProvider', 'hostApp', 'displayName'], [], 'dispatch parent');
  assertExactKeys(record.child, [
    'projectKey', 'repoRoot', 'gitCommonDir', 'laneId', 'targetProvider', 'backend', 'displayName',
  ], [], 'dispatch child');
  assertExactKeys(record.promptReceipts, [
    'bodySha256', 'provenanceSha256', 'renderedSha256',
  ], [], 'dispatch prompt receipts');
  if (record.schemaVersion !== VERSION || !UUID_PATTERN.test(record.dispatchId || '') ||
      (expectedId !== null && record.dispatchId !== expectedId) ||
      record.installationId !== installation.installationId || !UUID_PATTERN.test(record.parentRef || '') ||
      !SLUG_PATTERN.test(record.parent.hostProvider || '') || !SLUG_PATTERN.test(record.parent.hostApp || '') ||
      !SHA256_PATTERN.test(record.child.projectKey || '') || !UUID_PATTERN.test(record.child.laneId || '') ||
      !SLUG_PATTERN.test(record.child.targetProvider || '') || typeof record.child.backend !== 'string' ||
      !record.child.backend || !path.isAbsolute(record.child.repoRoot || '') ||
      !path.isAbsolute(record.child.gitCommonDir || '') || !DISPATCH_STATES.has(record.state) ||
      typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) ||
      (record.journaledAt !== undefined &&
       (typeof record.journaledAt !== 'string' || !Number.isFinite(Date.parse(record.journaledAt)))) ||
      !Object.values(record.promptReceipts).every((value) => SHA256_PATTERN.test(value))) {
    throw new DispatchError('INVALID_LOCAL_STATE', 'dispatch record is invalid');
  }
  assertSafeMetadataLabel(record.parent.displayName, 'dispatch parent display name');
  assertSafeMetadataLabel(record.child.displayName, 'dispatch child display name');
  if (digest(record.child.gitCommonDir) !== record.child.projectKey) {
    throw new DispatchError('INVALID_LOCAL_STATE', 'dispatch project identity is invalid');
  }
  for (const profile of [record.requestedProfile, record.resolvedProfile, record.observedProfile]) {
    if (profile !== null && (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
        Buffer.byteLength(canonicalJson(profile), 'utf8') > 16 * 1024)) {
      throw new DispatchError('INVALID_LOCAL_STATE', 'dispatch execution profile is invalid');
    }
  }
  return record;
}

function validateDispatchOwnership(record, installation, paths, expectedId = null) {
  const dispatch = validateDispatch(record, installation, expectedId);
  const parent = validateParent(readPrivateJson(
    path.join(paths.parents, `${dispatch.parentRef}.json`), 'parent context',
  ), installation);
  if (dispatch.parent.hostProvider !== parent.hostProvider ||
      dispatch.parent.hostApp !== parent.hostApp ||
      dispatch.parent.displayName !== parent.displayName) {
    throw new DispatchError('INVALID_LOCAL_STATE', 'dispatch parent snapshot is invalid');
  }
  return dispatch;
}

function readDispatch(dispatchId, env = process.env) {
  if (!UUID_PATTERN.test(dispatchId || '')) throw new DispatchError('USAGE_ERROR', 'dispatch id is invalid');
  const paths = pathsFor(env);
  if (!fs.existsSync(paths.installation)) throw new DispatchError('NOT_OWNED', 'installation record does not exist');
  const installation = validateInstallation(readPrivateJson(paths.installation, 'installation record'));
  return validateDispatchOwnership(
    readPrivateJson(path.join(paths.dispatches, `${dispatchId}.json`), 'dispatch record'),
    installation, paths,
    dispatchId,
  );
}

function markDispatchJournaled(dispatchId, env = process.env) {
  return withInstallationLock(env, (paths) => {
    const installation = installationRecord(paths);
    const record = ownedDispatchLocked(paths, installation, dispatchId);
    if (record.state === 'journaled') return record;
    if (record.state !== 'reserved') {
      throw new DispatchError('INVALID_STATE', 'dispatch cannot enter journaled state');
    }
    const updated = { ...record, state: 'journaled', journaledAt: new Date().toISOString() };
    atomicWriteJson(path.join(paths.dispatches, `${dispatchId}.json`), updated);
    return updated;
  });
}

function setObservedProfile(dispatchId, observedProfile, env = process.env) {
  if (!UUID_PATTERN.test(dispatchId || '') || !observedProfile ||
      typeof observedProfile !== 'object' || Array.isArray(observedProfile)) {
    throw new DispatchError('USAGE_ERROR', 'dispatch observation profile is invalid');
  }
  const serialized = canonicalJson(observedProfile);
  if (Buffer.byteLength(serialized, 'utf8') > 16 * 1024) {
    throw new DispatchError('USAGE_ERROR', 'dispatch observation profile is too large');
  }
  return withInstallationLock(env, (paths) => {
    const installation = installationRecord(paths);
    const record = ownedDispatchLocked(paths, installation, dispatchId);
    if (record.observedProfile !== null) {
      if (canonicalJson(record.observedProfile) !== serialized) {
        throw new DispatchError('INVALID_STATE', 'dispatch observed profile is immutable');
      }
      return record;
    }
    const updated = { ...record, observedProfile };
    atomicWriteJson(path.join(paths.dispatches, `${dispatchId}.json`), updated);
    return updated;
  });
}

function listDispatches(parentContext, env = process.env) {
  const loaded = ownedParentContext(parentContext, env);
  const paths = pathsFor(env);
  if (!fs.existsSync(paths.dispatches)) return [];
  if (!fs.existsSync(paths.installation)) throw new DispatchError('NOT_OWNED', 'installation record does not exist');
  const installation = validateInstallation(readPrivateJson(paths.installation, 'installation record'));
  return uuidJsonEntries(
    boundedDirectoryEntries(paths.dispatches, MAX_DISPATCH_RECORDS, 'dispatch directory'),
    'dispatch directory',
  )
    .map((entry) => {
      const id = entry.slice(0, -5);
      return validateDispatchOwnership(
        readPrivateJson(path.join(paths.dispatches, entry), 'dispatch record'),
        installation, paths, id,
      );
    })
    .filter((entry) => entry.parentRef === loaded.parent.parentRef)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function validateEventData(data, stored = false) {
  const invalid = (message) => {
    throw new DispatchError(stored ? 'INVALID_LOCAL_STATE' : 'USAGE_ERROR', message);
  };
  if (data === undefined) return {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return invalid('event data must be an object');
  }
  const keys = Object.keys(data);
  if (keys.some((key) => !['state', 'status'].includes(key))) {
    return invalid('event data has invalid fields');
  }
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/u.test(value)) {
      return invalid(`event data ${key} is invalid`);
    }
  }
  return { ...data };
}

function validateObservation(record, dispatchId) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new DispatchError('INVALID_LOCAL_STATE', 'dispatch observation is invalid');
  }
  assertExactKeys(record, [
    'schemaVersion', 'dispatchId', 'generation', 'phase', 'providerFingerprint', 'observedAt',
  ], [], 'dispatch observation');
  if (record.schemaVersion !== VERSION || record.dispatchId !== dispatchId ||
      !Number.isSafeInteger(record.generation) || record.generation < 1 ||
      !SLUG_PATTERN.test(record.phase || '') || !SHA256_PATTERN.test(record.providerFingerprint || '') ||
      typeof record.observedAt !== 'string' || !Number.isFinite(Date.parse(record.observedAt))) {
    throw new DispatchError('INVALID_LOCAL_STATE', 'dispatch observation is invalid');
  }
  return record;
}

function deterministicEventId(dispatch, event) {
  const { eventId: _eventId, ...content } = event;
  return uuidFromDigest(digest(`${dispatch.installationId}\0${canonicalJson(content)}`));
}

function recordEventLocked(paths, installation, dispatch, options, data) {
  const fingerprint = digest(options.fingerprint);
  const eventDirectory = path.join(paths.events, dispatch.parentRef);
  if (fs.existsSync(eventDirectory)) {
    assertPrivateDirectory(eventDirectory, 'parent event directory');
  }
  const parentFile = path.join(paths.parents, `${dispatch.parentRef}.json`);
  const parent = validateParent(readPrivateJson(parentFile, 'parent context'), installation);
  let maximumSequence = parent.nextSequence;
  const sequences = new Set();
  const semanticMatches = [];
  if (fs.existsSync(eventDirectory)) {
    const entries = uuidJsonEntries(
      boundedDirectoryEntries(eventDirectory, MAX_EVENT_RECORDS, 'parent event directory'),
      'parent event directory',
    );
    for (const entry of entries) {
      const id = entry.slice(0, -5);
      let existing = validateEvent(
        readPrivateJson(path.join(eventDirectory, entry), 'dispatch event'),
        dispatch.parentRef,
        id,
      );
      const existingDispatch = ownedDispatchLocked(
        paths, installation, existing.dispatchId,
      );
      existing = validateEvent(existing, dispatch.parentRef, id, existingDispatch);
      if (sequences.has(existing.sequence)) {
        throw new DispatchError('INVALID_LOCAL_STATE', 'parent event sequence is duplicated');
      }
      sequences.add(existing.sequence);
      if (existing.dispatchId === dispatch.dispatchId && existing.type === options.type &&
          existing.observationFingerprint === fingerprint &&
          canonicalJson(existing.data) === canonicalJson(data)) {
        semanticMatches.push(existing);
      }
      maximumSequence = Math.max(maximumSequence, existing.sequence);
    }
  }
  if (semanticMatches.length > 1) {
    throw new DispatchError('INVALID_LOCAL_STATE', 'dispatch event identity is duplicated');
  }
  if (semanticMatches.length === 1) {
    if (parent.nextSequence < maximumSequence) {
      atomicWriteJson(parentFile, { ...parent, nextSequence: maximumSequence });
    }
    return semanticMatches[0];
  }
  assertWriteCapacity(sequences.size, MAX_EVENT_RECORDS, 'parent event directory');
  const content = {
    schemaVersion: VERSION,
    sequence: maximumSequence + 1,
    parentRef: dispatch.parentRef,
    dispatchId: dispatch.dispatchId,
    child: {
      provider: dispatch.child.targetProvider,
      laneId: dispatch.child.laneId,
      projectKey: dispatch.child.projectKey,
    },
    type: options.type,
    observationFingerprint: fingerprint,
    data,
    occurredAt: new Date().toISOString(),
  };
  const event = { ...content, eventId: deterministicEventId(dispatch, content) };
  const file = path.join(eventDirectory, `${event.eventId}.json`);
  if (fs.existsSync(file)) {
    throw new DispatchError('INVALID_LOCAL_STATE', 'dispatch event id collides with an existing record');
  }
  atomicWriteJson(file, event);
  atomicWriteJson(parentFile, { ...parent, nextSequence: event.sequence });
  return event;
}

function validateEvent(event, parentRef, expectedId = null, dispatch = null) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new DispatchError('INVALID_LOCAL_STATE', 'dispatch event is invalid');
  }
  assertExactKeys(event, [
    'schemaVersion', 'eventId', 'sequence', 'parentRef', 'dispatchId', 'child', 'type',
    'observationFingerprint', 'data', 'occurredAt',
  ], [], 'dispatch event');
  assertExactKeys(event.child, ['provider', 'laneId', 'projectKey'], [], 'dispatch event child');
  if (event.schemaVersion !== VERSION || !UUID_PATTERN.test(event.eventId || '') ||
      (expectedId !== null && event.eventId !== expectedId) || event.parentRef !== parentRef ||
      !UUID_PATTERN.test(event.dispatchId || '') || !Number.isSafeInteger(event.sequence) ||
      event.sequence < 1 || !EVENT_TYPES.has(event.type) ||
      !SHA256_PATTERN.test(event.observationFingerprint || '') ||
      !SLUG_PATTERN.test(event.child.provider || '') || !UUID_PATTERN.test(event.child.laneId || '') ||
      !SHA256_PATTERN.test(event.child.projectKey || '') ||
      typeof event.occurredAt !== 'string' || !Number.isFinite(Date.parse(event.occurredAt))) {
    throw new DispatchError('INVALID_LOCAL_STATE', 'dispatch event is invalid');
  }
  validateEventData(event.data, true);
  if (dispatch !== null && (
    event.dispatchId !== dispatch.dispatchId || event.parentRef !== dispatch.parentRef ||
    event.child.provider !== dispatch.child.targetProvider ||
    event.child.laneId !== dispatch.child.laneId ||
    event.child.projectKey !== dispatch.child.projectKey
  )) {
    throw new DispatchError('INVALID_LOCAL_STATE', 'dispatch event does not match its dispatch');
  }
  if (dispatch !== null && event.eventId !== deterministicEventId(dispatch, event)) {
    throw new DispatchError('INVALID_LOCAL_STATE', 'dispatch event id does not match its immutable content');
  }
  return event;
}

function validateAcknowledgement(record, event) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new DispatchError('INVALID_LOCAL_STATE', 'event acknowledgement is invalid');
  }
  assertExactKeys(record, [
    'schemaVersion', 'eventId', 'parentRef', 'eventSha256', 'acknowledgedAt',
  ], [], 'event acknowledgement');
  if (record.schemaVersion !== VERSION || record.eventId !== event.eventId ||
      record.parentRef !== event.parentRef || !SHA256_PATTERN.test(record.eventSha256 || '') ||
      record.eventSha256 !== digest(canonicalJson(event)) ||
      typeof record.acknowledgedAt !== 'string' || !Number.isFinite(Date.parse(record.acknowledgedAt))) {
    throw new DispatchError('INVALID_LOCAL_STATE', 'event acknowledgement is invalid');
  }
  return record;
}

function ownedDispatchLocked(paths, installation, dispatchId) {
  if (!UUID_PATTERN.test(dispatchId || '')) {
    throw new DispatchError('USAGE_ERROR', 'dispatch id is invalid');
  }
  return validateDispatchOwnership(readPrivateJson(
    path.join(paths.dispatches, `${dispatchId}.json`), 'dispatch record',
  ), installation, paths, dispatchId);
}

function recordEvent(options, env = process.env) {
  if (!UUID_PATTERN.test(options?.dispatchId || '') || !EVENT_TYPES.has(options?.type) ||
      typeof options.fingerprint !== 'string' || !options.fingerprint ||
      Buffer.byteLength(options.fingerprint) > 1024) {
    throw new DispatchError('USAGE_ERROR', 'dispatch, event type, and observation fingerprint are required');
  }
  const data = validateEventData(options.data);
  return withInstallationLock(env, (paths) => {
    const installation = installationRecord(paths);
    const dispatch = ownedDispatchLocked(paths, installation, options.dispatchId);
    return recordEventLocked(paths, installation, dispatch, options, data);
  });
}

function recordObservation(options, env = process.env) {
  if (!UUID_PATTERN.test(options?.dispatchId || '') || !SLUG_PATTERN.test(options?.phase || '') ||
      typeof options.providerFingerprint !== 'string' || !options.providerFingerprint ||
      Buffer.byteLength(options.providerFingerprint) > 1024 ||
      (options.eventType !== null && options.eventType !== undefined &&
       !EVENT_TYPES.has(options.eventType))) {
    throw new DispatchError('USAGE_ERROR', 'dispatch observation is invalid');
  }
  const data = validateEventData(options.data);
  return withInstallationLock(env, (paths) => {
    const installation = installationRecord(paths);
    const dispatch = ownedDispatchLocked(paths, installation, options.dispatchId);
    const file = path.join(paths.observations, `${dispatch.dispatchId}.json`);
    let prior = null;
    if (fs.existsSync(file)) {
      prior = validateObservation(
        readPrivateJson(file, 'dispatch observation'),
        dispatch.dispatchId,
      );
    }
    const providerFingerprint = digest(options.providerFingerprint);
    const changed = !prior || prior.phase !== options.phase ||
      prior.providerFingerprint !== providerFingerprint;
    if (!changed) return { observation: prior, event: null, changed: false };
    const observation = {
      schemaVersion: VERSION,
      dispatchId: dispatch.dispatchId,
      generation: (prior?.generation || 0) + 1,
      phase: options.phase,
      providerFingerprint,
      observedAt: new Date().toISOString(),
    };
    let event = null;
    if (options.eventType) {
      event = recordEventLocked(paths, installation, dispatch, {
        type: options.eventType,
        fingerprint: `${observation.generation}:${providerFingerprint}`,
      }, data);
    }
    // The immutable event is durable before the mutable observation checkpoint.
    // A crash between these writes recreates the same generation and event ID.
    atomicWriteJson(file, observation);
    return { observation, event, changed: true };
  });
}

function collectEvents(parentContext, options = {}, env = process.env) {
  const loaded = ownedParentContext(parentContext, env);
  const paths = pathsFor(env);
  const directory = path.join(paths.events, loaded.parent.parentRef);
  if (!fs.existsSync(directory)) return [];
  const installation = validateInstallation(readPrivateJson(paths.installation, 'installation record'));
  const dispatchCache = new Map();
  const entries = uuidJsonEntries(
    boundedDirectoryEntries(directory, MAX_EVENT_RECORDS, 'parent event directory'),
    'parent event directory',
  );
  const after = options.after ?? 0;
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new DispatchError('USAGE_ERROR', 'event cursor must be a non-negative integer');
  }
  const sequences = new Set();
  const events = entries
    .map((entry) => {
      const id = entry.slice(0, -5);
      const event = validateEvent(
        readPrivateJson(path.join(directory, entry), 'dispatch event'),
        loaded.parent.parentRef,
        id,
      );
      let dispatch = dispatchCache.get(event.dispatchId);
      if (!dispatch) {
        dispatch = validateDispatchOwnership(readPrivateJson(
          path.join(paths.dispatches, `${event.dispatchId}.json`), 'dispatch record',
        ), installation, paths, event.dispatchId);
        dispatchCache.set(event.dispatchId, dispatch);
      }
      return validateEvent(event, loaded.parent.parentRef, id, dispatch);
    });
  for (const event of events) {
    if (sequences.has(event.sequence)) {
      throw new DispatchError('INVALID_LOCAL_STATE', 'parent event sequence is duplicated');
    }
    sequences.add(event.sequence);
  }
  return events
    .filter((event) => options.projectKey === undefined || event.child.projectKey === options.projectKey)
    .filter((event) => {
      if (options.includeAcknowledged === true) return event.sequence > after;
      const acknowledgementDirectory = path.join(paths.acknowledgements, loaded.parent.parentRef);
      if (fs.existsSync(acknowledgementDirectory)) {
        assertPrivateDirectory(acknowledgementDirectory, 'parent acknowledgement directory');
      }
      const file = path.join(acknowledgementDirectory, `${event.eventId}.json`);
      if (!fs.existsSync(file)) return true;
      validateAcknowledgement(readPrivateJson(file, 'event acknowledgement'), event);
      return false;
    })
    .sort((left, right) => left.sequence - right.sequence);
}

function listEvents(parentContext, options = {}, env = process.env) {
  const limit = options.limit ?? MAX_EVENT_BATCH;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_BATCH) {
    throw new DispatchError('USAGE_ERROR', `event batch limit must be 1..${MAX_EVENT_BATCH}`);
  }
  return collectEvents(parentContext, options, env).slice(0, limit);
}

function countEvents(parentContext, options = {}, env = process.env) {
  return collectEvents(parentContext, options, env).length;
}

function acknowledgeEvent(parentContext, eventId, env = process.env) {
  if (!UUID_PATTERN.test(eventId || '')) throw new DispatchError('USAGE_ERROR', 'event id is invalid');
  const loaded = ownedParentContext(parentContext, env);
  return withInstallationLock(env, (paths) => {
    const eventDirectory = path.join(paths.events, loaded.parent.parentRef);
    assertPrivateDirectory(eventDirectory, 'parent event directory');
    const eventFile = path.join(eventDirectory, `${eventId}.json`);
    const installation = installationRecord(paths);
    let event = validateEvent(
      readPrivateJson(eventFile, 'dispatch event'), loaded.parent.parentRef, eventId,
    );
    const dispatch = ownedDispatchLocked(paths, installation, event.dispatchId);
    event = validateEvent(event, loaded.parent.parentRef, eventId, dispatch);
    const acknowledgementDirectory = path.join(paths.acknowledgements, loaded.parent.parentRef);
    if (fs.existsSync(acknowledgementDirectory)) {
      assertPrivateDirectory(acknowledgementDirectory, 'parent acknowledgement directory');
    }
    const file = path.join(acknowledgementDirectory, `${eventId}.json`);
    if (fs.existsSync(file)) {
      return validateAcknowledgement(readPrivateJson(file, 'event acknowledgement'), event);
    }
    const acknowledgement = {
      schemaVersion: VERSION,
      eventId,
      parentRef: loaded.parent.parentRef,
      eventSha256: digest(canonicalJson(event)),
      acknowledgedAt: new Date().toISOString(),
    };
    atomicWriteJson(file, acknowledgement);
    return acknowledgement;
  });
}

module.exports = {
  DispatchError,
  EVENT_TYPES,
  VERSION,
  acknowledgeEvent,
  assertWriteCapacity,
  asciiJsonString,
  countEvents,
  createParentContext,
  digest,
  listDispatches,
  listEvents,
  listParentContexts,
  loadParentContext,
  markDispatchJournaled,
  pathsFor,
  profileParts,
  readDispatch,
  recordEvent,
  recordObservation,
  renderProvenanceBlock,
  reserveDispatch,
  setObservedProfile,
  validateLineage,
};
