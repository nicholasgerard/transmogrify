'use strict';

// Field-level guards shared by every durable record schema. They carry no
// dependencies so identity schemas and the state store can both use them.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

// Unknown fields fail closed: a record written by a newer or tampered writer is
// refused rather than silently carried forward.
function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
}

function assertTimestamp(value, label) {
  if (typeof value !== 'string' || !value || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
}

module.exports = { SHA256_PATTERN, UUID_PATTERN, assertExactKeys, assertTimestamp };
