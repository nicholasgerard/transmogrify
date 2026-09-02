'use strict';

const THREAD_STATUS_TYPES = new Set(['active', 'idle', 'systemError', 'notLoaded']);
const THREAD_ACTIVE_FLAGS = new Set(['waitingOnApproval', 'waitingOnUserInput']);
const MAX_CURSOR_BYTES = 4096;

function boundedCursor(value, label = 'pagination cursor') {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_CURSOR_BYTES ||
      /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function laneNameError(value, label = 'lane name') {
  if (typeof value !== 'string' || !value.trim() || value.startsWith('-') ||
      /[\u0000-\u001f\u007f\u2028\u2029\uD800-\uDFFF]/u.test(value) ||
      Buffer.byteLength(value, 'utf8') > 256) {
    return `${label} must be non-empty bounded single-line text and cannot begin with -`;
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
  laneNameError,
  normalizeThreadStatus,
};
