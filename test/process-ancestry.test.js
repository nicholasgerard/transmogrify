'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseProcessRow, walkProcessAncestry } = require('../scripts/lib/process-ancestry');

test('parses process rows with and without a command', () => {
  assert.deepEqual(parseProcessRow(' 42 /bin/zsh\n'), { ppid: 42, command: '/bin/zsh' });
  assert.deepEqual(parseProcessRow('1\n'), { ppid: 1, command: '' });
  assert.equal(parseProcessRow('not a process'), null);
});

test('walks a bounded ancestry and stops on a cycle', () => {
  const rows = new Map([
    [70, '60 /bin/node\n'],
    [60, '50 /bin/zsh\n'],
    [50, '60 /usr/bin/tmux\n'],
  ]);
  const ancestry = walkProcessAncestry({
    startPid: 70,
    run(executable, args) {
      assert.equal(executable, 'ps');
      return rows.get(Number(args.at(-1))) || '';
    },
  });
  assert.deepEqual(ancestry, [
    { pid: 70, ppid: 60, command: '/bin/node', depth: 0 },
    { pid: 60, ppid: 50, command: '/bin/zsh', depth: 1 },
    { pid: 50, ppid: 60, command: '/usr/bin/tmux', depth: 2 },
  ]);
});

