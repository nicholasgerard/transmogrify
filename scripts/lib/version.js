'use strict';

// Single source of the Transmogrify version reported in every provider
// clientInfo and written into durable receipts. Loading this module refuses a
// package.json version that is not a canonical semantic version, so a malformed
// release cannot reach a provider handshake or a persisted record.

const { version } = require('../../package.json');

if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('package.json version must be a canonical semantic version');
}

module.exports = { VERSION: version };
