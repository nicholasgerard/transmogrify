'use strict';

const { version } = require('../../package.json');

if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('package.json version must be a canonical semantic version');
}

module.exports = { VERSION: version };
