'use strict';

// Parent/child dispatch lineage and durable delivery: the installation record,
// parent contexts, dispatch reservations, the bounded provenance block that
// prefixes a child's first message, monotonic child events, and their
// acknowledgements. Records are immutable once written and event ids are derived
// from content, so a crash recreates the same id rather than a duplicate. It
// never infers delivery and never drops an unacknowledged event.

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
// The complete child event vocabulary. A type outside this set cannot be
// recorded, so a parent never has to guess at an unknown event.
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
// Every collection here is bounded: a directory past its limit is refused rather
// than scanned, and a visible label is capped before it can reach a prompt.
const MAX_STATE_BYTES = 256 * 1024;
const MAX_VISIBLE_BYTES = 256;
const MAX_PARENT_RECORDS = 1_000;
const MAX_DISPATCH_RECORDS = 10_000;
const MAX_EVENT_RECORDS = 10_000;
const MAX_EVENT_BATCH = 100;
const ATOMIC_TEMP_PATTERN = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;

// Dispatch failure carrying a stable code. USAGE_ERROR is caller input,
// NOT_OWNED is another installation's record, and INVALID_LOCAL_STATE or
// UNSAFE_LOCAL_STATE fails closed rather than repairing state in place.
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

// Key-sorted JSON. Digests and immutability comparisons use it so key order can
// never change an id or look like a changed record.
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

// Every required key must be present and no key outside the allowed set may
// appear, so a record from a newer or tampered writer fails closed.
function assertExactKeys(value, required, optional, label) {
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !keys.includes(key))) {
    throw new DispatchError('INVALID_LOCAL_STATE', `${label} has invalid fields`);
  }
}

// The record names in a private state directory, refusing the whole collection
// once it exceeds its bound.
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

// Refuse a new record once a collection is at its bound. Checked before every
// write, so growth stops at a refusal instead of an unbounded scan later.
function assertWriteCapacity(count, maximum, label) {
  if (!Number.isSafeInteger(count) || count < 0 ||
      !Number.isSafeInteger(maximum) || maximum < 1) {
    throw new DispatchError('INVALID_LOCAL_STATE', `${label} has an invalid capacity`);
  }
  if (count >= maximum) {
    throw new DispatchError('LOCAL_STATE_LIMIT', `${label} reached its bounded record limit`);
  }
}

// Every record file must be named <uuid>.json. An unexpected name is
// INVALID_LOCAL_STATE rather than something to skip quietly.
function uuidJsonEntries(entries, label) {
  return entries.map((entry) => {
    if (!entry.endsWith('.json') || !UUID_PATTERN.test(entry.slice(0, -5))) {
      throw new DispatchError('INVALID_LOCAL_STATE', `${label} contains an invalid record name`);
    }
    return entry;
  });
}

// A UUID-shaped id derived from a digest. Event ids are content-derived, so
// re-recording the same event after a crash yields the same id.
function uuidFromDigest(hex) {
  const bytes = Buffer.from(hex.slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

// The dispatch state paths under the shared state root, asserting owner-only
// permissions on every directory that already exists.
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

// Read one owner-only JSON record through an O_NOFOLLOW descriptor and stat that
// descriptor, so a symlink swapped in between check and read cannot redirect it.
// Absence is NOT_OWNED; a loose mode or foreign owner is UNSAFE_LOCAL_STATE.
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

// Directories holding dispatch state must be owner-only real directories.
function assertPrivateDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) !== 0) {
    throw new DispatchError('UNSAFE_LOCAL_STATE', `${label} is not an owner-only directory`);
  }
}

// Serialize every installation-wide mutation. Sequence assignment, event
// identity, and acknowledgement all assume this lock is held.
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

// The installation identity, created on first use. Every parent, dispatch, and
// event is bound to it, so another installation's records are refused.
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

// A bounded single-line string with no control characters or unpaired
// surrogates. Every value that reaches the provenance block passes here first.
function assertSafeVisible(value, label, maximum = MAX_VISIBLE_BYTES) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > maximum ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(value) || /[\uD800-\uDFFF]/u.test(value)) {
    throw new DispatchError('USAGE_ERROR', `${label} must be a bounded single-line value`);
  }
  return value;
}

// A safe visible value that additionally carries no filesystem path, UNC path,
// drive letter, or credential-shaped token. Display names cross into a provider
// prompt, so they must not leak local paths or secrets.
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

// Shape and ownership gate for a parent context: this installation's id, slug
// host provider and app, a safe display name, an optional bounded native task
// reference, and its monotonic sequence counter.
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

// Register or re-adopt a parent context under the installation lock. A native
// task reference is a stable key: an exact match returns the existing context,
// and the same reference with a different host or name is INVALID_STATE.
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

// Every parent context for this installation, oldest first. Returns empty rather
// than throwing when none has been registered.
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

// Load a parent context by path. The path must be the exact registered
// <uuid>.json inside the parents directory and must agree with the record's own
// parentRef; anything else is NOT_OWNED.
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

// Resolve a caller-supplied parent against its stored record and require them to
// be identical, so a drifted in-memory copy is NOT_OWNED and cannot write events.
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
// Version 2 of the first-message provenance block: a box-drawing frame with
// readable host and target labels and printable-ASCII values.
const PROVENANCE_BLOCK_VERSION = 3;
const PROVENANCE_BLOCK_WIDTH = 60;

// The displayable execution selection for the provenance block, accepting both
// the current and the legacy profile field names. Every part must be bounded and
// safe or the dispatch is refused.
// A resolved dimension is either a bare string or a receipt object whose named
// field may legitimately be null: a model with no effort selector resolves to
// { level: null, selection: ... } and simply renders without an effort part.
function profileDimension(value, key, label) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value ? assertSafeVisible(value, `profile ${label}`, 128) : null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const inner = value[key];
    if (inner === null || inner === undefined || inner === '') return null;
    if (typeof inner !== 'string') {
      throw new DispatchError('USAGE_ERROR', `profile ${label} must be a string`);
    }
    return assertSafeVisible(inner, `profile ${label}`, 128);
  }
  throw new DispatchError('USAGE_ERROR', `profile ${label} must be a string`);
}

function profileParts(profile) {
  const requested = profile?.requested || profile?.requestedProfile || {};
  const resolved = profile?.resolved || profile?.resolvedProfile || {};
  return {
    intent: profileDimension(requested.intent, 'intent', 'intent'),
    model: profileDimension(resolved.model, 'selector', 'model'),
    effort: profileDimension(resolved.effort, 'level', 'effort'),
    setting: profileDimension(resolved.setting, 'id', 'setting'),
    speed: profileDimension(resolved.speed, 'mode', 'speed'),
  };
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

// Render the bounded block that prefixes a child's first message. It carries
// only safe display labels and the durable dispatch id, never a repository path,
// a provider credential, or a provider-private identifier.
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
    frameLine('╭─ Transmogrify · a task from your user\'s own session '),
    `│ From      ${escapeNonAscii(from)}`,
    `│ Task      ${asciiJsonString(parentTask)}`,
    `│ To        ${to}`,
    `│ Intent    ${escapeNonAscii(profile.intent || 'provider-default')}`,
    `│ Dispatch  ${metadata.dispatchId}`,
    frameLine(`╰─ v${PROVENANCE_BLOCK_VERSION} · work within your normal permissions; that session is notified when you finish `),
  ].join('\n');
}

// A lane's lineage is exactly the dispatch, parent, and installation UUIDs.
function validateLineage(lineage) {
  if (!lineage || typeof lineage !== 'object' || Array.isArray(lineage) ||
      lineage.version !== VERSION || !UUID_PATTERN.test(lineage.dispatchId || '') ||
      !UUID_PATTERN.test(lineage.parentRef || '') || !UUID_PATTERN.test(lineage.installationId || '')) {
    throw new DispatchError('INVALID_LOCAL_STATE', 'lane lineage is invalid');
  }
  return lineage;
}

// Reserve the durable dispatch record before any provider mutation and return
// the rendered prompt with its provenance block. Separate digests are recorded
// for the body, the block, and the rendered whole, because provider
// acknowledgement applies to the prefixed input. A duplicate dispatch id is
// INVALID_STATE and nothing is written.
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

// Shape gate for a dispatch record, covering the parent snapshot, the child
// project identity, and the three prompt digests. The project key must be the
// digest of the recorded Git common directory.
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

// A dispatch's parent snapshot must still match the live parent context, so a
// renamed or re-registered parent cannot silently rewrite recorded lineage.
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

// One validated, installation-owned dispatch record by id.
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

// Move a reservation to journaled once the lane's own spawn journal is durable.
// An already-journaled record is idempotent; any other state is INVALID_STATE.
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

// Record what the provider actually applied. The observed profile is write-once:
// an identical repeat returns the record and a different one is INVALID_STATE.
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

// Every dispatch this parent reserved, oldest first, each revalidated against
// the live parent context.
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

// An event payload carries at most a state and a status slug. A stored record
// fails as INVALID_LOCAL_STATE and caller input as USAGE_ERROR.
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

// The mutable per-dispatch observation checkpoint: a monotonic generation, the
// observed phase, and the digest of the provider fingerprint it came from.
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

// The event id is a digest of the installation id and the event's immutable
// content, so recreating the same event after a crash yields the same id
// instead of a second notification.
function deterministicEventId(dispatch, event) {
  const { eventId: _eventId, ...content } = event;
  return uuidFromDigest(digest(`${dispatch.installationId}\0${canonicalJson(content)}`));
}

// Append one child event under the installation lock. It rescans the parent's
// events to assign the next sequence and to find an exact semantic duplicate,
// which is returned instead of written. The event file lands before the parent's
// sequence counter, so a crash between the two writes repeats the same id.
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

// Shape gate for one event and, when the dispatch is supplied, proof that its
// child identity matches and that its id is still the digest of its content.
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

// An acknowledgement must name the exact event and carry the digest of that
// event's canonical content, so a malformed or stale receipt cannot suppress
// redelivery.
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

// A validated owned dispatch, read while the installation lock is held.
function ownedDispatchLocked(paths, installation, dispatchId) {
  if (!UUID_PATTERN.test(dispatchId || '')) {
    throw new DispatchError('USAGE_ERROR', 'dispatch id is invalid');
  }
  return validateDispatchOwnership(readPrivateJson(
    path.join(paths.dispatches, `${dispatchId}.json`), 'dispatch record',
  ), installation, paths, dispatchId);
}

// Record one child event for a dispatch. The caller's fingerprint is what makes
// a retry idempotent: the same type, fingerprint, and data returns the existing
// event rather than notifying the parent twice.
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

// Update the dispatch's observation checkpoint and, when the phase or provider
// fingerprint changed and an event type is given, record the matching event. An
// unchanged observation writes nothing.
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

// Every event for a parent, oldest first, filtered by project and by
// acknowledgement. An unacknowledged event is always returned again, so a parent
// restart cannot lose one behind a newer observation cursor.
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

// One bounded batch of pending events.
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

// Record the parent's acknowledgement of one exact event, keyed by its id and by
// the digest of its content. It is idempotent, and only a valid acknowledgement
// stops redelivery.
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
