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
function readOwnedText(file, { maxBytes, modeMask = 0o077 }) {
  let descriptor;
  try {
    // O_NONBLOCK makes a FIFO rejectable by fstat without waiting for a writer.
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
        (stat.mode & modeMask) !== 0) return { status: 'unsafe' };
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(descriptor, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > stat.size) return { status: 'unsafe' };
    const after = fs.fstatSync(descriptor);
    if (after.size !== bytes || after.mtimeMs !== stat.mtimeMs ||
        after.uid !== stat.uid || after.mode !== stat.mode) return { status: 'unsafe' };
    const value = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
    return { status: 'ok', value, modifiedAt: stat.mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', cause: error.message };
    return { status: 'invalid', cause: error.message };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readOwnedJson(file, options) {
  const read = readOwnedText(file, options);
  if (read.status !== 'ok') return read;
  try { return { ...read, value: JSON.parse(read.value) }; }
  catch (error) { return { status: 'invalid', cause: error.message }; }
}

module.exports = { SHA256_PATTERN, UUID_PATTERN, assertExactKeys, assertTimestamp, readOwnedJson, readOwnedText };
