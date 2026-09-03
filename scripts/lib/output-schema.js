'use strict';

// The public output contract for every command result. Each operation names
// the keys its result may carry; anything else is dropped before printing, so
// a provider handle, a path, or a transcript fragment can never reach output
// by being added to an internal result. Strings that survive are redacted.
//
// Subtrees listed in EXEMPT_SUBTREES are provider-advertised catalogs and
// immutable execution profiles: their `id`, `name`, and source fields are
// public metadata, so key stripping stops there while redaction still applies.
//
// `phase` is one vocabulary for every provider; `providerPhase` keeps the
// provider's own word beside it.

const { safeString } = require('./public-error');

const PHASES = Object.freeze(['executing', 'waiting', 'idle', 'stopped', 'failed', 'retired', 'unknown']);

// Provider phase -> normalized phase. A provider word missing here maps to
// unknown, never to a made-up state.
const PROVIDER_PHASES = Object.freeze({
  codex: Object.freeze({
    executing: 'executing',
    idle: 'idle',
    interrupted: 'idle',
    failed: 'failed',
    notLoaded: 'idle',
    unknown: 'unknown',
  }),
  claude: Object.freeze({
    working: 'executing',
    waiting: 'waiting',
    idle: 'idle',
    stopped: 'stopped',
    retiring: 'stopped',
    retired: 'retired',
    unknown: 'unknown',
  }),
});

function normalizePhase(target, providerPhase) {
  return PROVIDER_PHASES[target]?.[providerPhase] || 'unknown';
}

// The two phase fields every status-bearing result carries.
function phaseFields(target, providerPhase) {
  return { phase: normalizePhase(target, providerPhase), providerPhase };
}

const EXEMPT_SUBTREES = new Set([
  'catalog', 'executionProfile', 'guidance', 'intents', 'observedProfile',
  'requestedProfile', 'resolvedProfile', 'selectionGuide',
]);

// Keys every lane-bound result shares.
const LANE_ENVELOPE = [
  'version', 'ok', 'operation', 'operationId', 'laneId', 'adapter', 'state', 'phase', 'providerPhase',
  'capabilities', 'visibility', 'receipt', 'delivery',
];
const CAPABILITIES = {
  midTurnSteer: true, interrupt: true, retirement: true, recovery: true, approvalRelay: true,
  steering: true, stop: true, cancelTurnOnly: true, nativePresentation: true,
};
const VISIBILITY = {
  surface: true, state: true, attachment: true,
  receipt: {
    runtimeUrl: true, evidence: true, connection: true, observedAt: true, bundleId: true,
    desktopVersion: true, desktopBuild: true, buildTested: true, clientPid: true,
  },
};
const RECONCILE_ENTRY = {
  laneId: true, state: true, phase: true, providerPhase: true, outcome: true, delivery: true,
  repaired: true, skipped: true, pendingOperation: true, code: true, causeCode: true, ownerAction: true,
  error: { code: true },
};
const PROFILE_FIELDS = { requestedProfile: true, resolvedProfile: true, observedProfile: true };

function laneShape(receipt, extra = {}) {
  return {
    ...Object.fromEntries(LANE_ENVELOPE.map((key) => [key, true])),
    capabilities: CAPABILITIES,
    visibility: VISIBILITY,
    receipt,
    ...extra,
  };
}

// `true` admits a scalar or an array of scalars; an object admits those keys.
const SCHEMAS = Object.freeze({
  spawn: laneShape({
    acknowledgedBy: true, inputReceiptSource: true, completedStatus: true, presentation: true,
    requestedModelSelector: true, bridgeIdSha256: true, executionProfile: true,
  }),
  status: laneShape({
    exactSession: true, executionEpoch: true, durableLifecycle: true, providerInspectionDeferred: true,
  }, { turn: { status: true }, rawState: { type: true, activeFlags: true }, waiting: true }),
  steer: laneShape({
    mode: true, observation: true, observedAtOffset: true, deliveryTokenSha256: true,
  }),
  interrupt: laneShape({ reconciled: true }),
  stop: laneShape({ mode: true, alreadyStopped: true }),
  recover: laneShape({
    acknowledgedBy: true, inputReceiptSource: true, sameSessionId: true, sameJobId: true,
    sameBridgeId: true, executionEpoch: true, presentation: true,
  }),
  retire: laneShape({
    archived: true, alreadyRetired: true, worktreeRemoved: true, reconciled: true, retired: true,
    harvestedOutputSha256: true, remoteArchived: true, localJobRemoved: true, localRemovalDeferred: true,
    provider: { unbound: true, stop: true, archive: true, localRemoval: true },
    worktree: { attempted: true, removed: true, deferred: true, blocked: true },
  }),
  reconcile: {
    version: true, ok: true, operation: true, adapter: true, results: RECONCILE_ENTRY,
    recovered: RECONCILE_ENTRY, receipt: { providerConnection: true },
  },
  abandon: {
    version: true, ok: true, operation: true, laneId: true, providerOutcome: true,
    lane: { laneId: true, state: true, backend: true },
    abandoned: { operationId: true, type: true, fromState: true, reason: true, at: true },
    delivery: { providerMutation: true },
  },
  capabilities: {
    version: true, ok: true, operation: true, target: true, intents: true, selectionGuide: true,
    availability: { kind: true, observed: true, note: true }, guidance: true, catalog: true,
  },
  'parent-init': {
    version: true, ok: true, operation: true, parentRef: true, contextFile: true,
    hostProvider: true, hostApp: true, displayName: true,
  },
  'parent-list': {
    version: true, ok: true, operation: true,
    parents: {
      parentRef: true, contextFile: true, hostProvider: true, hostApp: true, displayName: true,
      createdAt: true, children: true, unacknowledgedEvents: true,
    },
  },
  children: {
    version: true, ok: true, operation: true, parentRef: true, unacknowledgedEvents: true,
    children: {
      dispatchId: true, laneId: true, target: true, displayName: true, state: true, phase: true,
      laneObservation: true, createdAt: true, unacknowledgedEvents: true, latestEventType: true,
      latestEventKind: true, ...PROFILE_FIELDS,
    },
  },
  wait: {
    version: true, ok: true, operation: true, until: true,
    events: {
      schemaVersion: true, sequence: true, parentRef: true, dispatchId: true, type: true, kind: true,
      terminal: true, observationFingerprint: true, occurredAt: true, eventId: true,
      child: { provider: true, laneId: true, projectKey: true },
      data: { state: true, status: true },
    },
    observed: { dispatchId: true, laneId: true, phase: true, eventType: true },
    observerErrors: { dispatchId: true, code: true },
  },
  ack: { version: true, ok: true, operation: true, eventId: true, acknowledgedAt: true },
  schema: { version: true, ok: true, operation: true, operations: true, phases: true, providerPhases: true, schemas: true },
  // The bounded maintenance runner and its `--retention` mode share one
  // operation name; `providers`/`counts`/`setup` and `retention` never appear
  // together in one result, but both are declared here so either shape
  // projects cleanly.
  maintain: {
    version: true, ok: true, operation: true, dryRun: true,
    providers: {
      codex: { available: true, reconciled: true, results: true, notOk: true, skipped: true, code: true },
      claude: { available: true, reconciled: true, results: true, notOk: true, skipped: true, code: true },
    },
    counts: {
      ownedActive: true, ownedStopped: true, pendingOperations: true, pendingRetirements: true,
      cleanupBlocked: true, unattendedChildren: true,
    },
    setup: {
      ready: true,
      ownerActions: { provider: true, reason: true, blocking: true, ownerAction: true },
    },
    retention: {
      dryRun: true, keepDays: true, keepBackups: true,
      operations: { candidates: true, moved: true },
      events: { candidates: true, moved: true },
      backups: { candidates: true, moved: true },
      trashDir: true,
    },
  },
});

// Project a value through a shape: objects keep only listed keys, arrays are
// projected element-wise, strings are redacted, exempt subtrees keep every key.
function project(value, shape, exempt = false) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => project(entry, shape, exempt));
  if (typeof value === 'string') return safeString(value);
  if (typeof value !== 'object') return value;
  if (exempt) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, project(nested, true, true)]));
  }
  if (shape === true) {
    // A scalar slot holding an object: nothing inside it was declared public.
    return undefined;
  }
  const projected = {};
  for (const [key, nested] of Object.entries(value)) {
    if (EXEMPT_SUBTREES.has(key) && shape[key] !== undefined) {
      projected[key] = project(nested, true, true);
      continue;
    }
    const nestedShape = shape[key];
    if (nestedShape === undefined) continue;
    const result = project(nested, nestedShape, false);
    if (result !== undefined) projected[key] = result;
  }
  return projected;
}

// The public view of a command result. A result naming no known operation is
// reduced to its envelope so an unregistered shape never prints internals.
function publicResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const shape = SCHEMAS[result.operation] || { version: true, ok: true, operation: true };
  return project(result, shape, false);
}

// The contract as data, for `lane.js schema` and the documentation test.
function describeSchema() {
  return {
    version: 1,
    ok: true,
    operation: 'schema',
    operations: Object.keys(SCHEMAS),
    phases: [...PHASES],
    providerPhases: PROVIDER_PHASES,
    schemas: SCHEMAS,
  };
}

module.exports = {
  EXEMPT_SUBTREES,
  PHASES,
  PROVIDER_PHASES,
  SCHEMAS,
  describeSchema,
  normalizePhase,
  phaseFields,
  project,
  publicResult,
};
