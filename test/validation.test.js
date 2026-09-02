'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  canonicalLaneName,
  laneNameError,
  OWNED_LANE_PREFIX,
  ownedLaneNameError,
} = require('../scripts/lib/validation');

test('canonical lane names use one provider-neutral ownership marker', () => {
  assert.equal(OWNED_LANE_PREFIX, '::: ');
  assert.equal(canonicalLaneName('release review'), '::: release review');
  assert.equal(canonicalLaneName('::: release review'), '::: release review');
  assert.equal(canonicalLaneName('[Claude] release review'), '::: release review');
  assert.equal(canonicalLaneName('[claude] release review'), '::: release review');
  assert.equal(canonicalLaneName('[codex] release review'), '::: release review');
  assert.equal(canonicalLaneName('[maint] release review'), '::: release review');
  assert.equal(canonicalLaneName('[maint] [Claude] release review'), '::: release review');
  assert.equal(canonicalLaneName('[test] release review'), '::: [test] release review');
  assert.equal(ownedLaneNameError('::: release review'), null);
  assert.match(ownedLaneNameError('release review'), /must begin with/);
});

test('canonical lane names reject empty markers and option-like summaries', () => {
  assert.equal(canonicalLaneName(':::'), '');
  assert.equal(canonicalLaneName('[maint]'), '');
  assert.match(laneNameError(canonicalLaneName(':::'), 'lane'), /non-empty/);
  assert.match(laneNameError('  --unsafe', 'lane'), /cannot begin with -/);
});
