'use strict';

const THREAD_STATUS_TYPES = new Set(['active', 'idle', 'systemError', 'notLoaded']);
const THREAD_ACTIVE_FLAGS = new Set(['waitingOnApproval', 'waitingOnUserInput']);
const MAX_CURSOR_BYTES = 4096;
const OWNED_LANE_PREFIX = '::: ';
const LEGACY_LANE_PREFIX = /^\[(?:claude|codex|maint)\]\s*/iu;

function boundedCursor(value, label = 'pagination cursor') {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_CURSOR_BYTES ||
      /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function laneNameError(value, label = 'lane name') {
  if (typeof value !== 'string' || !value.trim() || value.trimStart().startsWith('-') ||
      /[\u0000-\u001f\u007f\u2028\u2029\uD800-\uDFFF]/u.test(value) ||
      Buffer.byteLength(value, 'utf8') > 256) {
    return `${label} must be non-empty bounded single-line text and cannot begin with -`;
  }
  return null;
}

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

function ownedLaneNameError(value, label = 'lane name') {
  const problem = laneNameError(value, label);
  if (problem) return problem;
  if (!value.startsWith(OWNED_LANE_PREFIX) || canonicalLaneName(value) !== value) {
    return `${label} must begin with ${JSON.stringify(OWNED_LANE_PREFIX)} and contain a summary`;
  }
  return null;
}

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

module.exports = {
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
