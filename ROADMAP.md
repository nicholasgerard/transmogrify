# Roadmap

## Direction

The destination is one operator skill that can be loaded by either Codex or
Claude Code and can launch and manage native-visible lanes in either provider's
desktop and mobile apps. The operator discovers what is already running, reuses
compatible shared infrastructure, provisions only what it owns, selects the
best provider-native control channel available, reconciles interrupted work,
harvests results, archives finished lanes, and removes only its own clean
worktrees.

Every new native row begins with the provider-neutral `::: ` ownership marker.
The marker is a visual cue only; lifecycle authority continues to require the
installation's exact durable identity receipt.

Transport symmetry is not the goal. Lifecycle parity is. Codex and Claude may
use different spawn, steer, status, stop, recovery, and archive channels as long
as the observable contract and safety invariants match.

Codex and Claude Code are the first complete pair, not the final boundary. Once
their launch gate is green, the same adapter contract can extend to Cursor and
other native coding-agent desktop surfaces. New providers enter through
measured native mechanisms; roadmap intent is never presented as current
support.

## Current state

The canonical support matrix is in [README.md](README.md#support-matrix). The
standalone adapters implement both target providers on the pinned
compatibility tuple. Claude Desktop/mobile visibility, mobile-originated
input, and native archive behavior are live-verified on the recorded build
tuple. Codex Desktop and mobile visibility are live-verified with the app
attached to the shared runtime: `desktop-attach.js` measures that attachment
on every check and every dispatch, launches or (with owner authorization)
relaunches the app attached, and a lane without the receipt is recorded
protocol-only only with `--allow-protocol-only`. A Desktop restart or update
drops the attachment; run `desktop-attach.js ensure` before new cross-host
Codex dispatches.

Managed dispatch now has two provider-neutral contracts. Execution profiles
resolve a task intent or explicit override to an immutable model, effort, and
Standard/Fast receipt; provider adapters compile that receipt to their native
controls and reapply it on recovery. Parent contexts reserve every child before
mutation, prefix its first message with safe visible provenance, and retain
durable sequenced events until the parent explicitly handles and acknowledges
them. The current contracts are in
[Execution profiles](docs/EXECUTION-PROFILES.md) and
[Dispatch and lineage](docs/DISPATCH.md).

Since 0.3.0 every tool shares one entry point (`transmogrify.js`), one exit
table, one failure envelope with fixed public text, and one output allowlist
per operation ([Output contract](docs/OUTPUT.md)); operation journals hold
only enumerated per-type states behind a schema version, an owner may
`abandon` a stranded non-retirement journal, and both provider adapters sit
behind one descriptor-driven seam with a contract test.

## Acceptance program: turnkey bidirectional operation

Run the following suite on compatibility refreshes and before widening any
provider claim:

- Load the same installed skill in current Codex and Claude Code hosts.
- Run the read-only doctor; reuse a compatible existing runtime and leave every
  foreign provider session untouched.
- From each host, create one Codex lane and one Claude Code lane with an exact
  name and isolated managed seat.
- Observe each lane in the target desktop app and target mobile Code surface.
- Deliver one directed steer, observe its receipt, stop it, recover the same
  lane identity, and confirm visibility remains continuous.
- Harvest durable output, archive the exact native row, remove the clean managed
  worktree through the operator guard, and then clear the exact local Claude
  record only after its seat path is absent.
- Restart the orchestrator between lifecycle stages and reconcile without
  duplicate spawn, duplicate steer, wrong-lane mutation, or leaked worktree.
- Restart a parent with an unacknowledged child event and confirm the same event
  is redelivered before new dispatch; then acknowledge it and confirm it is not
  delivered again.
- Exercise every neutral execution intent and both speed modes supported by
  each provider, verifying requested/resolved/observed receipts and recovery
  reuse the same selector and controls.
- Restart each desktop host while its separately managed runtime survives;
  record whether mobile reattaches to the exact lane without changing project
  identity or routing to another app-server process. Codex pre-restart lane
  reattachment is a known limitation.
- Break each setup precondition in turn (logged-out Claude CLI, unattached
  Codex Desktop, missing runtime) and confirm the doctor names the owner action
  and that spawn fails closed with that reason rather than an unknown outcome.
- Leave a dirty managed worktree and confirm cleanup blocks without data loss.
- Seed foreign sessions with colliding names and short IDs and confirm no
  mutation reaches them.

No GUI automation is part of the control plane. Native deep links may present an
already-owned session, but session identity and lifecycle control come from
provider or measured local interfaces.

### Run record

2026-09-03, releases 0.2.2 through 0.2.5, Nick at Codex Desktop, Claude
Desktop, and iPhone. Exercised and green: skill loaded in both hosts; doctor
with runtime reuse and `setup.ready`; Claude lane from the Claude host with
live Desktop and iPhone visibility; Codex lane from the Claude host with the
measured Desktop attachment, mid-turn steer, interrupt, and archive; Claude
lane from a Codex Desktop thread; directed steer receipts on both providers;
mobile-originated input on Claude; whole-session stop; unacknowledged-event
redelivery to a new process with single acknowledgement; private-archive
retirement with guarded managed-seat removal and local record removal;
dirty-seat refusal and manual-removal acknowledgement; the logged-out-CLI
setup path; unbound-spawn settlement. Found and fixed during the run: the
spawn receipt window, the wrapped delivery marker, the provenance block
wording, fork containment on recovery, and the null-effort provenance refusal.
Not available: in-place resume of a stopped Claude lane (a fork on this CLI,
now contained). Not exercised live: mobile reattachment after a Desktop host
restart, and seeded same-name foreign sessions (unit-tested only).

2026-09-03, wave 0.3 checkpoints 0.2.7, 0.2.8, and 0.3.0, unattended
maintainer run with disposable probes on the shared runtime. Exercised and
green at each checkpoint: doctor with `setup.ready`; Codex lane attached to
Desktop, boundary recover with input, mid-turn steer, interrupt, archive;
Claude lane spawn, steer verified by reconcile, whole-session stop,
private-archive retirement with seat and local record removal; parent event
delivery and acknowledgement; a stalled `localRemovalUnknown` retirement
from the previous day finished by observation. Found and fixed: lane
operations that did not accept `--timeout-ms`, usage errors that hid their
text. Observed twice: a Claude steer reported `DELIVERY_UNCERTAIN` inside
its verification window and settled as `steerDeliveredObserved` on the next
reconcile.

2026-09-03, wave 0.4 (0.3.1), unattended maintainer run with disposable
probes on the shared runtime from a Claude Code host. Exercised and green:
turnkey wakes in real time for every child transition (spawned, completed,
attention, stopped, failed, retired) through the parent's own Remote
Control bridge, for Codex and Claude children; Codex spawn, boundary
recover with input, mid-turn steer, interrupt, archive; Claude spawn,
steer verified in the command (`consumedObserved`), whole-session stop,
private-archive retirement; both providers' reconcile in the unified
shape; a runtime endpoint move is unit-tested only. Found and fixed during
the run: a spawn that failed before reserving a lane left the parent a
dispatch it was asked to attend forever (now settled as `failed` with one
terminal event); the CLI's follow-up acknowledgement URL form (a
`session_` prefix plus a query string) made every landed Claude steer
`DELIVERY_UNCERTAIN`, which is the cause of the earlier observations
above; a Claude stop failed after the worker exit when the watcher had
recorded the same exit first; retired Claude lanes on an older runtime
reported `differentRuntime` on every reconcile. Not exercised live: a
Codex host acting as the parent end to end (its mechanisms are verified
individually), and the two owner-present rows below.

2026-09-03, wave 0.5 (0.5.0), unattended maintainer run with disposable
probes on the shared runtime from a Claude Code host, after the adapter
split and the phase decompositions. Exercised and green: a Claude child's
session hook nudged the watcher at its turn end and the parent was woken
within four seconds; a Codex runtime notification nudged the watcher at
turn completion and the parent was woken at once; wakes carried
`ack --through` and their acknowledgements were accepted by the CLI; the
parent's own stop and retirements were acknowledged at observation and
produced no wake and no pending event; the child hook settings file was
removed with the lane; the watcher exited on request. Found and fixed
during the pass: wake discovery ignored `CLAUDE_CONFIG_DIR`, a re-adopted
parent context kept an earlier session's bridge, the maintenance tests
still used the pre-unification reconcile shape, and a scratch `pkill`
during the test-runner investigation stopped a test run from another
project on the same machine (reported to the owner).

2026-09-04, Dock-launch attachment, owner present. With
`launchctl setenv CODEX_APP_SERVER_WS_URL ws://127.0.0.1:8843` in the GUI
environment and the shared runtime listening, Codex Desktop launched through
LaunchServices without any per-launch environment attached to the shared
runtime by itself (attach receipt `attached`, one socket to 8843, no
private app-server child). The setting lasts until logout; persistence
across logins and the app's behavior when the runtime is not listening at
launch are not yet measured.

2026-09-04, managed daemon experiments, owner present. Passed on a scratch
Codex home with the pinned 0.151.0 CLI: `daemon start` (it requires the
installer's managed standalone install at `<home>/packages/standalone/
current`), `enable-remote-control` on the running daemon without a
restart, `daemon version` read through the socket by the app's bundled
0.153.0 CLI (the app accepts any daemon at 0.141.0 or newer, read from
its bundle), and two websocket clients on the daemon's unix socket at
`/rpc` where one received the other's `thread/started`,
`thread/name/updated`, and `thread/status/changed`. Failed with Codex
Desktop 26.901.22334 on the owner's real home: relaunched with
`CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` it started its private runtime
anyway, because its daemon branch also requires that the app pass no
config overrides and this build always passes `features.code_mode_host`
and its bundled `codex_app` MCP server; relaunched with
`CODEX_APP_SERVER_WS_URL=ws+unix://<socket>:/rpc` it failed to start
(`connect ECONNREFUSED 127.0.0.1:1080`), because the app routes any
websocket host that is not loopback through a SOCKS proxy meant for SSH
hosts. Desktop was restored attached to the shared loopback runtime. Next
candidate: a loopback TCP relay to the daemon's socket, so Desktop reaches
the daemon through the supported `CODEX_APP_SERVER_WS_URL` path.

2026-09-04, loopback relay to the managed daemon, owner present. With the
managed daemon running in the owner's real home and a 20-line Node relay
listening on 127.0.0.1:8844 and piping bytes to the daemon's unix socket,
Codex Desktop relaunched with `CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:8844/rpc`
attached through the relay (one TCP connection to the relay, one client on
the daemon socket, no private runtime, nothing on 8843), and a disposable
thread created by a second client on the daemon's socket ran a real turn
to completion with the full notification stream (`thread/started`,
`turn/started`, `item/agentMessage/delta`, `turn/completed`) and was
archived. Two things the daemon design must absorb: the daemon's
`initialize` user agent starts with the originator of its first client
(not `codex_cli_rs/…`), so the verified-runtime check needs to read the
version rather than the product name; and a daemon started from the
managed install reports its own version (0.151.0 here) independently of
the CLI on `PATH`.

2026-09-04, wave 0.6 first harvest, unattended maintainer run on the managed
daemon. Three Codex lanes (runtime daemon, compatibility by range, host
context) ran in parallel on the daemon through the relay, each in its own
managed worktree, with the parent watcher delivering completion wakes into
this session; all three were reviewed, merged into `wave/0.6` (suite 523
green), and retired. Measured in the process: a lane under the default
`workspace-write` sandbox can write only its worktree and `/tmp`; the
shared git directory, the state root, `ps`, loopback and unix sockets, and
the keychain are denied, so two lanes could not write the handback the packet
asked for and did not commit, and the third lane's commit succeeded only
because the owner's personal Codex rules run `git add` and `git commit`
outside the sandbox. Every lane copied `ws` into its seat to run tests, which
the retirement census counts as dirt, so cleanup was finished through the
manual-removal acknowledgement. The exchange contract moves into the
worktree (packet 7 below). Also verified live after the merge: the runtime
probe over the daemon's unix socket and over the relay, `runtime-up.sh`
reusing both without starting anything, the doctor reaching the runtime
through the relay record, the Claude build measurement cached by digest, and
the Codex method probe cached by runtime version.

## The 0.6.0 wave

Goal: a runtime that survives relaunches, app updates, and logins, and an
onboarding that works from any first entry point. Seven lane packets, each
with disjoint files, dispatched to Codex lanes on the managed daemon and
reviewed before merge into `wave/0.6`:

1. Runtime daemon: the managed daemon as the shared runtime, reached over
   its unix socket by Transmogrify and over a loopback relay by Codex
   Desktop; `runtime-up.sh` ensures both and falls back to today's
   standalone launch.
2. Desktop attach through the daemon: attachment measured against the
   relay, a Codex host inside an attached app counted as attached, and an
   owner-consented, reversible `persist` that keeps Dock launches attached
   across logins.
3. Compatibility by range and measurement (docs/ONBOARDING.md, section 1).
4. Host context detection and the explaining doctor (sections 2 and 3).
5. Guided setup with consent and one install for both hosts (sections 4
   and 5).
6. The start handoff and skill bootstrap rewritten around the above
   (sections 6 and 7).
7. Lane exchange under the default sandbox: the child hands back inside
   its own worktree, the operator commits with the handed-back title and
   body (`harvest --commit`), and seat provisioning (dependencies, the
   exchange directory) is recorded so retirement cleanup stays clean by
   construction.

Already on the branch: the Codex runtime is accepted by version (0.151.0
or newer) whatever product name it reports, and the client's handshake
offers no per-message deflate, both required by the daemon. Release when
the live acceptance matrix in docs/ONBOARDING.md passes on this machine
and one machine that has never seen Transmogrify.

## Priority 1: compatibility and acceptance hardening

- Onboarding that works wherever the start prompt lands: compatibility by
  range and measurement instead of exact pins, host context detection, a
  doctor that explains its plan in plain words, guided installs with
  consent, one install for both hosts, and a rewritten start handoff. The
  brief, specification, and implementation plan are in
  [docs/ONBOARDING.md](docs/ONBOARDING.md); queued for a Codex worker.

- Claude resume lineage. On CLI `2.1.258` a background resume of a stopped
  job forks a new session; the adapter stops that fork and leaves the lane
  stopped. Plan: (1) measure on a disposable lane what the CLI produces on
  resume (census rows before and after, the new transcript path, any parent
  reference in `~/.claude/sessions/<pid>.json`, and whether `claude attach`
  or a foreground `--resume` keeps the id); (2) if no in-place resume exists,
  adopt the fork as the lane's next session only on proof (a parent reference
  or our replayed prompt marker), recording a `lineage` of sessions in the
  Claude identity schema with transitions like the runtime epochs, targeting
  the newest session for status and steer, and stopping and archiving every
  session in the lineage at retirement; an unproven fork stays
  `forkedCopyStopped`. Acceptance: stop, recover, steer lands in the newest
  transcript, retire clears every row. About 400 lines with tests.
- Two acceptance rows still need Nick present: mobile reattachment after a
  Desktop restart (spawn a narrating Codex probe, quit and relaunch Desktop
  attached, confirm the lane is listed and streams on the iPhone, steer from
  the phone, retire; if the thread is missing after the relaunch, `recover
  --input` is the repair to test), and a seeded same-name foreign session
  (Nick starts a hand-run `claude --bg --remote-control` and a hand-run Codex
  thread with a lane's exact title; spawn, steer, and retire the lane; verify
  by hand that the foreign sessions never receive anything and survive).
- Replace the environment-variable attach with Codex's managed daemon
  (researched 2026-09-03, plan in docs/NOTIFICATIONS.md's sibling notes and
  the maintainer's plan). Findings: Desktop's SSH projects run a plain
  `app-server --listen unix://` on the remote with `app-server proxy` over
  SSH, not the daemon subsystem; Desktop's local host has an Electron-side
  switch `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` that attaches it to the
  managed daemon's control socket (`~/.codex/app-server-control/
  app-server-control.sock`) with reconnect support instead of spawning a
  private stdio child; `codex app-server daemon enable-remote-control`
  claims to apply to a running managed daemon; Desktop bundles
  `0.153.0-alpha.5` against the pinned `0.151.0`. Target: the managed daemon
  becomes the shared runtime (our client speaks `ws+unix://`), Desktop
  attaches on every Dock launch through a persisted `launchctl setenv`, and
  the visibility receipt becomes the unix-socket connection. Experiments in
  order, on a scratch `CODEX_HOME` and never on 8843: (1) `daemon start`,
  `enable-remote-control`, same pid, second client through `proxy --sock`;
  (2) `daemon bootstrap --remote-control`, our client over the socket,
  cross-client `thread/status/changed` and `turn/completed` for a thread
  another client created, steer, interrupt, archive, plus a schema diff
  between 0.151.0 and 0.153.0-alpha.5; (3) with Nick, one deliberate Desktop
  launch with the switch on a disposable profile, lsof receipt of the socket
  connection, a thread from our client rendering on Desktop and iPhone;
  (4) persistence across a Dock relaunch and a login. Kill criteria: pid
  changes on enable, no cross-client fan-out, Desktop still spawns the stdio
  child, or the thread does not render. Until it passes, the measured attach
  receipt stays the supported native path.
- Re-test the `mcp_servers.codex_app` launcher override counterfactual on a
  disposable runtime: confirm whether an attached Desktop still opens threads
  when the override is absent, so the launcher rule rests on a current receipt.
- Run and record the complete fresh bidirectional acceptance suite above,
  including mobile-originated input on both providers.
- Add a reproducible compatibility refresh command that inventories the Codex
  schema and Claude CLI/Desktop hashes without enabling mutations.
- Define a signed compatibility-manifest format so newly verified provider
  tuples can be added without weakening fail-closed defaults.
- Add explicit fixtures for account switches, config-directory migration,
  device/inode reuse, renamed binaries, and provider response expansion.
- Exercise long-disconnect Remote Control recovery and documented session
  expiry behavior.
- Measure what name and row a `--resume <session> --bg` copy carries when the
  original session is not resumed in place; today fork detection correlates by
  exact seat, dispatch window, and lane name, so an unnamed copy would run
  untracked rather than be refused.
- Add a compatibility refresh fixture for every documented Claude selector and
  Codex catalog lifecycle state, including account-restricted and retired
  outcomes, without weakening the pre-mutation refusal policy.
- Add explicit profile-migration as an owner-authorized operation. Recovery
  must continue using the original resolved profile until that new operation
  records and verifies a replacement.
- Measure provider-reported effective model, effort, and speed fields whenever
  a native surface adds them; keep absence represented as unknown rather than
  copying requested values into observed receipts.

## Priority 2: autonomous maintenance without overreach

- Add configurable maintenance cadence and stale-journal alerts for hosts that
  expose scheduling (`maintain.js` is the bounded runner; nothing schedules
  it yet).
- Add an explicit review queue for dirty or post-harvest-changed managed
  worktrees. Never auto-delete these seats.
- Replace direct eligible-seat deletion with a recoverable quarantine where the
  platform permits it. Preserve the current final census, and close the
  same-user write window between that census and irreversible removal.
- Reap acknowledged parent events once the dispatch store offers a pruning
  primitive that keeps duplicate detection intact (`maintain --retention`
  moves aged journals and superseded backups today, never events). Parent
  event stores are bounded; a long-lived parent that reaches the bound must
  start a new context.

## Priority 3: reduce private and version-specific surface

- Replace Claude private archival when Anthropic exposes a documented exact
  Remote Control archive/status API.
- Request a Codex `thread/start` idempotency key so a response-loss window can be
  reconciled without an unknown orphan. Until then, this is a launch-relevant
  recovery boundary: the adapter refuses blind replay but cannot discover a
  thread whose created ID was lost before durable persistence.
- If the Desktop-owned SSH daemon/proxy route cannot safely accept a second
  client, request a documented Desktop-host registration or exact
  thread-adoption contract for independently managed app-server runtimes. It
  must preserve the same provider identity and project seat across Desktop
  restarts so paired mobile clients can reattach without duplication or routing
  drift.
- Evaluate Claude's public multi-session Remote Control server mode for shared
  runtime reuse if Anthropic documents an exact external spawn/ownership API;
  do not adopt its transient private daemon socket as a control contract.
- Move Claude's initial background-session prompt off the positional argument
  when Anthropic documents a noninteractive stdin or file-based Remote Control
  spawn with the same native visibility and identity receipts.
- Track a public Codex authenticated local transport or per-client capability
  boundary if one becomes available.
- Expand Claude support beyond Darwin arm64 only after every platform-specific
  process, socket, credential, and Desktop visibility claim is measured.

## Priority 4: provider-neutral host integration

- Publish a small host adapter contract for native same-provider task tools:
  exact identity, visibility, directed input, status, stop, recovery, archive,
  and durable ownership receipts.
- Add conformance tests that run the same lifecycle scenarios against built-in
  Codex tasks, Codex app-server lanes, native Claude sub-agents where applicable,
  and Claude Remote Control lanes.
- Standardize structured handback and mailbox schemas while keeping repository
  authority in the host skill.
- Support multiple machines and multiple explicitly owned runtimes without
  broad discovery or name-based adoption.
- Research Cursor's documented and measured native task/session surfaces, then
  define an adapter only if exact identity, live app visibility, directed
  control, recovery, and safe retirement can meet the same conformance suite.

## Website: transmogrify.sh

The repository contains a self-contained static Astro package in `site/`. It
builds repository facts from their canonical Markdown sources, exposes the
versioned agent bootstrap at `/start`, and keeps all website build dependencies
outside the `ws`-only lifecycle runtime and installed skill.

Ongoing acceptance work:

- Complete a rendered desktop/mobile, keyboard, screen-reader, reduced-motion,
  theme, copy, and no-JavaScript acceptance pass against the final tree.
- Run a clean-agent test from the one-line homepage prompt through `/start`,
  installation, doctor, and exact-owned operation in a disposable repository.
- Reverify `/start`, redirects, headers, cache behavior, default no-analytics
  output, social/search metadata, bundle budgets, and the custom domain on each
  compatibility release.
- Keep analytics disabled until the Privacy Policy names the controller and
  private contact channel and documents retention, processor, and transfer
  terms for the configured service.
- Keep lifecycle installation, local operation, and recovery independent of
  DNS and the hosted website.

## Deliberate boundaries

- Consumer Claude Chat is out of scope.
- Generic GUI automation is out of scope.
- Foreign or unregistered provider sessions are out of scope even when their
  names or paths resemble owned lanes.
- Automatic merge, deployment, spend, and repository policy remain host-skill
  concerns.
- A lane is not automatically disposable because it is idle, stopped, old, or
  disconnected. Durable harvest plus exact retirement receipts are required.
