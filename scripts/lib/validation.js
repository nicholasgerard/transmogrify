'use strict';

// Shared shape checks for caller-supplied and provider-supplied values: bounded
// pagination cursors, single-line lane names, the `::: ` ownership marker, and
// Codex thread status. These functions decide shape only. Ownership authority
// stays with the durable registry, and none of them contacts a provider.

const THREAD_STATUS_TYPES = new Set(['active', 'idle', 'systemError', 'notLoaded']);
const THREAD_ACTIVE_FLAGS = new Set(['waitingOnApproval', 'waitingOnUserInput']);
const MAX_CURSOR_BYTES = 4096;
const OWNED_LANE_PREFIX = '::: ';
const LEGACY_LANE_PREFIX = /^\[(?:claude|codex|maint)\]\s*/iu;

// Accepts an absent cursor as null and otherwise requires bounded single-line
// text. An oversized or control-bearing cursor throws, because a census that
// cannot page safely must fail rather than report itself complete.
function boundedCursor(value, label = 'pagination cursor') {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_CURSOR_BYTES ||
      /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

// Returns a problem description for an empty, multi-line, oversized, or
// option-like lane name, and null when the name is acceptable. A leading - is
// refused so a name can never be read as a flag by a provider CLI.
function laneNameError(value, label = 'lane name') {
  if (typeof value !== 'string' || !value.trim() || value.trimStart().startsWith('-') ||
      /[\u0000-\u001f\u007f\u2028\u2029\uD800-\uDFFF]/u.test(value) ||
      Buffer.byteLength(value, 'utf8') > 256) {
    return `${label} must be non-empty bounded single-line text and cannot begin with -`;
  }
  return null;
}

// Strips every stacked `:::` and legacy bracket prefix, then reapplies exactly
// one owned marker. The marker is visual only, so a value that carries no
// summary canonicalizes to the empty string rather than to a bare marker.
function canonicalLaneName(value) {
  if (typeof value !== 'string') return value;
  let summary = value.trim();
  while (summary) {
    if (summary.startsWith(':::')) {
      summary = summary.slice(3).trimStart();
      continue;
    }
    const legacy = summary.match(LEGACY_LANE_PREFIX);
    if (legacy) {
      summary = summary.slice(legacy[0].length).trimStart();
      continue;
    }
    break;
  }
  return summary ? `${OWNED_LANE_PREFIX}${summary}` : '';
}

// Requires a name that is already canonical, not merely valid. A value that
// canonicalLaneName would still rewrite is refused, so a lane can never be
// recorded under a title different from the one the provider is given.
function ownedLaneNameError(value, label = 'lane name') {
  const problem = laneNameError(value, label);
  if (problem) return problem;
  if (!value.startsWith(OWNED_LANE_PREFIX) || canonicalLaneName(value) !== value) {
    return `${label} must begin with ${JSON.stringify(OWNED_LANE_PREFIX)} and contain a summary`;
  }
  return null;
}

// Projects a provider thread status onto the schema-defined shape and throws on
// an unknown type or an unrecognized active flag. Only `active` carries flags,
// so a status is never accepted with flags the protocol does not define.
function normalizeThreadStatus(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status) ||
      !THREAD_STATUS_TYPES.has(status.type)) {
    throw new Error('invalid Codex thread status');
  }
  if (status.type !== 'active') return { type: status.type };
  if (!Array.isArray(status.activeFlags) ||
      status.activeFlags.some((flag) => !THREAD_ACTIVE_FLAGS.has(flag))) {
    throw new Error('invalid Codex active thread flags');
  }
  return { type: 'active', activeFlags: [...status.activeFlags] };
}

// A bounded non-negative integer CLI value with a fallback for an absent
// one; `invalid` receives the usage message and must throw.
function boundedInteger(value, label, minimum, maximum, fallback, invalid) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) invalid(`${label} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    invalid(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

module.exports = {
  boundedInteger,
  MAX_CURSOR_BYTES,
  THREAD_ACTIVE_FLAGS,
  THREAD_STATUS_TYPES,
  boundedCursor,
  canonicalLaneName,
  laneNameError,
  normalizeThreadStatus,
  OWNED_LANE_PREFIX,
  ownedLaneNameError,
};
