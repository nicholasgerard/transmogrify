'use strict';

const fs = require('node:fs');

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

// Read a JSON file that must be a bounded regular file owned by the current
// user, through an O_NOFOLLOW descriptor that is stat'ed after opening so a
// symlink swapped in between check and read cannot redirect it. modeMask names
// the permission bits that must be clear (0o077 for owner-only, 0o022 for
// not group- or world-writable). The outcome is data; callers map it to their
// own error classes.
function readOwnedJson(file, { maxBytes, modeMask }) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
        (stat.mode & modeMask) !== 0) {
      return { status: 'unsafe' };
    }
    return { status: 'ok', value: JSON.parse(fs.readFileSync(descriptor, 'utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', cause: error.message };
    return { status: 'invalid', cause: error.message };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

module.exports = { SHA256_PATTERN, UUID_PATTERN, assertExactKeys, assertTimestamp, readOwnedJson };
