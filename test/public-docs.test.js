'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseHandback, exchangePreamble } = require('../scripts/lib/exchange');
const { MINIMUM_CLI_VERSION } = require('../scripts/lib/claude-surface');
const { MINIMUM_APP_SERVER_VERSION } = require('../scripts/lib/app-server');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('SKILL.md stays within its byte and word budgets', () => {
  const skill = read('SKILL.md');
  // The skill is loaded into every operator context. Bound growth so detailed
  // reference material moves into linked docs. Baseline: 28,138 bytes / 4,031
  // words at 6cbce31; these limits leave roughly 18% release-edit headroom.
  assert.ok(Buffer.byteLength(skill, 'utf8') <= 33000, 'SKILL.md exceeds 33,000 bytes');
  assert.ok(skill.trim().split(/\s+/u).length <= 4800, 'SKILL.md exceeds 4,800 words');
});

test('the example handback parses with the real exchange contract', () => {
  const handback = parseHandback(read('examples/handback.md'));
  const preamble = exchangePreamble('/tmp/example-seat', 'codex');
  const required = [...preamble.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(Object.keys(handback.sections), required);
  assert.equal(handback.commitSha, '1'.repeat(40));
  assert.ok(handback.title.length >= 10 && handback.title.length <= 72);
  assert.ok(handback.body.trim());
  assert.doesNotMatch(handback.body, /^SHA:/m);
});

test('the example packet restricts child Git actions to its assigned clone', () => {
  const packet = read('examples/packet.md');
  assert.match(packet, /Commit the authorized changes in the assigned clone on its current branch/);
  assert.match(packet, /Never push\. Never change branches\./);
  assert.match(packet, /\.transmogrify\/handback\.md/);
  const instructions = packet.replace(/Never push\. Never change branches\./, '');
  assert.doesNotMatch(instructions, /\bpush\b|\b(?:checkout|switch)\b|change branches|git branch/i);
  assert.doesNotMatch(packet, /Handback:.*outside|must not commit|do not commit/i);
});

test('current support docs separate measured minimums from the private archive pin', () => {
  assert.equal(typeof MINIMUM_CLI_VERSION, 'string');
  for (const file of ['README.md', 'SECURITY.md', 'docs/ONBOARDING.md', 'docs/EXECUTION-PROFILES.md']) {
    const doc = read(file);
    assert.ok(doc.includes(`\`${MINIMUM_CLI_VERSION}\``), `${file}: Claude minimum`);
    assert.match(doc, /private archiv[\s\S]{0,180}(?:exact|pin)|exact[\s\S]{0,180}private archiv/i, file);
  }
  assert.ok(read('README.md').includes(`\`${MINIMUM_APP_SERVER_VERSION}\``));
  assert.match(read('SECURITY.md'), /current `0\.6\.x` release line/);
  assert.doesNotMatch(read('README.md'), /claude install 2\.|initialize-only Codex handshake|unpinned Claude CLI/);
  assert.doesNotMatch(read('docs/EXECUTION-PROFILES.md'), /refusing every unpinned version|on a pinned CLI/);
  assert.doesNotMatch(read('.github/ISSUE_TEMPLATE/bug.yml'), /0\.2\.6/);
});

test('the roadmap preserves the dated release exceptions and fresh-machine gate', () => {
  const roadmap = read('ROADMAP.md');
  assert.ok(roadmap.includes('2026-09-04 exception: 0.6.0 shipped without the fresh-machine acceptance pass.'));
  assert.match(roadmap, /2026-09-08 exception: 0\.6\.1 shipped on the owner's decision/);
  assert.match(roadmap, /The gate is retained\. The next release requires[\s\S]*machine that has never seen\nTransmogrify, with exact builds and outcomes recorded before release/);
  assert.match(roadmap, /Persistence across login, mobile[\s\S]*remain unverified live/);
  assert.doesNotMatch(roadmap, /queued for a Codex worker/);
});

// Read the shipped documents themselves so these checks catch cross-tree drift.
const documentationContracts = [
  ['docs/PROTOCOL.md', 'normal launches may inherit persistence', /Persistence can supply this environment on a normal launch/],
  ['site/src/content/sections/04-install.md', 'Desktop-host example measures attachment without relaunch', /node "\$SKILL_ROOT\/scripts\/desktop-attach\.js" check/],
  ['site/src/content/sections/04-install.md', 'attachment setup runs outside the Desktop host', /Connecting an unattached app requires guided setup from outside a Codex Desktop host/],
  ['SKILL.md', 'restart attachment is remeasured', /After a Desktop restart, run a fresh `desktop-attach\.js check`/],
  ['SKILL.md', 'command events require ack', /Retire, stop, and interrupt events remain pending until `ack`/],
  ['SKILL.md', 'parent context suppresses only wakes', /matching `--parent-context-file` suppresses only the redundant wake/],
  ['SKILL.md', 'exit 2 includes cleanup', /exit 2[^\n]+CLEANUP_RETRYABLE[^\n]+verified provider retirement/],
  ['SKILL.md', 'explaining doctor has a TTY summary', /`doctor --explain` on a TTY prints a terminal summary unless `--json`/],
  ['docs/CLAUDE-CODE.md', 'Claude children commit in clones', /managed clone seat, the Claude child commits on its assigned branch and reports the full SHA/],
  ['docs/CLAUDE-CODE.md', 'harvest verifies and fetches child commits', /verify the child SHA equals clone HEAD and fetch that HEAD into the preserved operator branch/],
  ['docs/CLAUDE-CODE.md', 'operator commits remain a fallback', /use `harvest --commit` for an operator commit when needed/],
  ['docs/PROTOCOL.md', 'doctor measures methods and writes receipts', /validated `thread\/list` read, and nil-ID method probes, and writes local compatibility receipts/],
  ['docs/PROTOCOL.md', 'adopted relays cannot be stopped', /Stop requires a record with `origin: launched` and a matching process birth; an adopted relay is refused/],
  ['docs/PROTOCOL.md', 'ensure can start missing services', /`ensure` may start a missing runtime or relay/],
  ['docs/PROTOCOL.md', 'launch-only excludes runtime startup', /`--launch-only` requires an already-live selected relay and never starts a runtime or relay/],
  ['docs/PROTOCOL.md', 'first message includes the exchange in order', /first child message begins with the bounded Transmogrify provenance block[^\n]+followed by the exchange preamble, then the caller's packet/],
  ['docs/PROTOCOL.md', 'absent first input settles after grace', /Reconciliation also settles proven first-turn input absence after the grace period \(60 seconds by default\) as `notDelivered` \(`spawnInputAbsent`\)/],
  ['docs/PROTOCOL.md', 'steer marker links its dated live receipt', /Live-verified, 2026-09-03[^\n]+NOTIFICATIONS\.md#receipts-and-open-experiments/],
  ['docs/PROTOCOL.md', 'cleanup recognizes only receipted provisions', /census is clean except for exact receipted provisions, which are removed before seat cleanup/],
  ['docs/PROTOCOL.md', 'clone cleanup preserves fetched commits', /Clone cleanup also requires the fetched HEAD on the preserved branch in the operator repository/],
  ['docs/PROTOCOL.md', 'journal types include harvest', /eight types \(`spawn`, `steer`, `stop`, `recover`, `resume`, `interrupt`, `harvest`, `retire`\)/],
  ['docs/PROTOCOL.md', 'harvest graph includes commit and cleanup paths', /planned → staged → commitDispatching → committed → copying[^\n]+copied → cleanupDispatching → cleanupComplete → complete/],
  ['docs/PROTOCOL.md', 'exit 2 allows post-retirement cleanup', /2 for a usage error, a safe refusal, or retryable local cleanup after verified provider retirement/],
  ['docs/PROTOCOL.md', 'ack takes event or sequence and derives digests', /`ack --event <event-id>` or `ack --through <sequence>`; the command derives each event's digest itself/],
  ['docs/PROTOCOL.md', 'security boundary includes canonical Unix endpoints', /Transmogrify accepts canonical `ws\+unix:<normalized absolute socket path>` endpoints as well as root-path loopback WebSocket URLs/],
  ['docs/NOTIFICATIONS.md', 'notification architecture has four layers', /## Four layers/],
  ['docs/NOTIFICATIONS.md', 'nudges supplement idle polling', /nudges it to read that child at once, in addition to the thirty-second idle polling interval/],
  ['docs/NOTIFICATIONS.md', 'subscriptions are implemented', /notification subscriptions already accelerate observation; polling remains the fallback/],
  ['docs/NOTIFICATIONS.md', 'completion is not task success', /turn ended, possibly by interruption[^\n]+completion does not prove task success/],
  ['docs/NOTIFICATIONS.md', 'stopped can mean turn interruption', /`child.stopped` can report a turn interruption and does not prove the session ended/],
  ['docs/NOTIFICATIONS.md', 'children names the actual output fields', /`latestEventKind`, and the `unacknowledgedEvents` count/],
  ['docs/NOTIFICATIONS.md', 'cost model includes idle timer reads', /polling working children every three seconds and idle children every thirty seconds/],
  ['docs/NOTIFICATIONS.md', 'hooks retain fallback polling', /timer polling remains as the fallback for working and waiting children/],
  ['docs/TROUBLESHOOTING.md', 'exit 2 includes provider-retired cleanup', /2 means a usage error, a safe refusal, or retryable local cleanup after verified provider retirement/],
  ['docs/TROUBLESHOOTING.md', 'doctor can write local state', /doctor may create the registry and write local compatibility receipts; real provider sessions remain untouched/],
  ['docs/TROUBLESHOOTING.md', 'restart calls for fresh attachment evidence', /After a restart or update, run a fresh `desktop-attach\.js check` to remeasure attachment/],
  ['docs/TROUBLESHOOTING.md', 'UI appearance cannot determine ownership', /proves neither ownership nor non-ownership\. Use exact registry and runtime receipts/],
  ['docs/TROUBLESHOOTING.md', 'post-dispatch mismatch may exit 3', /mismatch discovered after dispatch can leave partial or unknown provider effects and exit 3/],
  ['docs/TROUBLESHOOTING.md', 'unbound Claude jobs require exact receipts', /Identify any remaining job only from exact dispatch and runtime receipts, never its title/],
  ['docs/TROUBLESHOOTING.md', 'unbound Claude cleanup remains guarded', /Never run `claude rm` before the managed-seat removal guard has passed/],
  ['docs/TROUBLESHOOTING.md', 'manual rm uses retirement guards', /Manual `claude rm <job>` requires the same guard as retirement[^\n]+managed seat path is already absent after guarded cleanup/],
  ['examples/mailbox.md', 'amendments travel through the control channel', /send the amendment text itself through `steer` or boundary `recover --input`/],
  ['examples/mailbox.md', 'external mailbox paths may be unreadable', /external mailbox path alone may be unreadable to a restricted child/],
  ['site/README.md', 'site build imports root setup narration', /build reads root metadata and imports `scripts\/lib\/setup-plan\.js`/],
  ['site/README.md', 'both workflows filter the setup-plan input', /Both `\.github\/workflows\/site\.yml` and `\.github\/workflows\/site-deploy\.yml` filter on[^\n]+`scripts\/lib\/setup-plan\.js`/],
  ['site/src/content/sections/01-definition.md', 'managed jobs have separate clones', /term: A separate clone per job/],
  ['site/src/content/sections/01-definition.md', 'removal lists the harvest guards', /Removal requires a seat clean at harvest and cleanup, matching provision receipts, verified provider retirement, and unchanged commits preserved in the operator repository/],
  ['site/src/content/sections/01-definition.md', 'native visibility is conditional', /measured attachment connects it to their runtime; protocol-only lanes also work/],
  ['site/src/content/sections/01-definition.md', 'telemetry claim is scoped to Transmogrify', /Transmogrify itself collects no telemetry[^\n]+Provider tools still use their own services and accounts/],
  ['site/src/content/sections/01-definition.md', 'definition uses clone seat terminology', /gives it a managed Git clone seat/],
  ['site/src/content/sections/03-matrix.md', 'matrix qualifies app visibility', /Codex app visibility requires measured Desktop attachment to the lane's runtime/],
  ['site/src/content/sections/04-install.md', 'setup checks prerequisites before writes', /Check prerequisites before creating directories; stop with a visible error if repository-root resolution fails/],
  ['site/src/content/sections/04-install.md', 'default install covers both hosts', /default install covers both Codex and Claude Code personal skill directories/],
  ['site/src/content/sections/04-install.md', 'doctor uses nil-id probes and local receipts', /probes methods against a nil thread ID[^\n]+write local compatibility receipts/],
  ['site/src/content/sections/04-install.md', 'Claude spawn prompt is positional', /Claude background spawn forwards its prompt as a positional argument/],
  ['site/src/content/sections/04-install.md', 'parent-init supplies repository root', /parent-init \\ --repo-root "\$REPO_ROOT"/],
  ['site/src/content/sections/04-install.md', 'site development minimum is separate', /Node\.js 22\.18 or newer is needed only for site development/],
  ['site/src/content/sections/04-install.md', 'Claude requires Apple Silicon macOS', /Claude lanes require Apple Silicon macOS/],
  ['scripts/lib/exchange.js', 'exchange comment allows own Git metadata', /clone seat grants exactly its own \.git for child commits/],
];

for (const [file, contract, pattern] of documentationContracts) {
  test(`public documentation: ${contract}`, () => {
    assert.match(read(file).replace(/\s+/gu, ' '), pattern, file);
  });
}

test('protocol Claude compatibility links resolve to the real heading', () => {
  const protocol = read('docs/PROTOCOL.md');
  assert.match(read('docs/CLAUDE-CODE.md'), /^## Compatibility receipts$/m);
  assert.equal(protocol.match(/CLAUDE-CODE\.md#compatibility-receipts/g)?.length, 2);
  assert.doesNotMatch(protocol, /CLAUDE-CODE\.md#measured-compatibility-tuple/);
});

test('site install runtime minimum agrees with the root package', () => {
  const minimum = JSON.parse(read('package.json')).engines.node.replace('>=', '');
  assert.ok(read('site/src/content/sections/04-install.md').includes(`Node.js ${minimum} or newer`));
});

test('site setup example refuses failed prerequisites before creating directories', () => {
  const install = read('site/src/content/sections/04-install.md');
  const firstWrite = install.indexOf('install -d');
  for (const check of ['command -v git', 'command -v node', 'command -v npm', 'git rev-parse --verify HEAD',
    'TRANSMOGRIFY_RESOLVED_REPO_ROOT="$(git rev-parse --show-toplevel)" && test -n "$TRANSMOGRIFY_RESOLVED_REPO_ROOT" || {']) {
    assert.ok(install.indexOf(check) >= 0 && install.indexOf(check) < firstWrite, check);
  }
  assert.match(install.slice(0, firstWrite), /repository root could not be resolved[^\n]+>&2\n\s+exit 1/);
});
