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

## Priority 1: compatibility and acceptance hardening

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

- Add a bounded maintenance runner around doctor and exact-owned reconcile.
  It may close interrupted journals and eligible cleanup, but it may not infer
  completion or harvest output on its own.
- Add configurable maintenance cadence and stale-journal alerts for hosts that
  expose scheduling.
- Report aggregate owned-active, owned-stopped, pending-retirement, and
  cleanup-blocked counts without provider IDs or private paths.
- Add an explicit review queue for dirty or post-harvest-changed managed
  worktrees. Never auto-delete these seats.
- Replace direct eligible-seat deletion with a recoverable quarantine where the
  platform permits it. Preserve the current final census, and close the
  same-user write window between that census and irreversible removal.
- Add retention policy for completed operation receipts, acknowledged parent
  events, and superseded installer backups, with dry-run output and
  recoverable deletion. Parent event stores are bounded today; a long-lived
  parent that reaches the bound must start a new context.
- Widen or decouple the Claude steer verification window: the transcript
  marker regularly lands after the public command returns, so `steer`
  reports `DELIVERY_UNCERTAIN` and only the next reconcile observes
  delivery. Verify asynchronously, or wait for the transcript up to the
  command deadline before reporting.
- Give Codex a spawn-absence settlement like Claude's `spawnJobAbsent`: a
  Codex spawn whose input receipt never appears stays pending forever and
  only raises repeated attention events.
- Make a Codex steer reconcilable. Codex has no steer receipt to observe, so a
  crashed steer journal can only be abandoned; record the `turn/steer`
  response or the resulting turn item so recovery can settle it.
- Unify the reconcile result shape: Codex reports `delivery` and
  `repaired[]`, Claude reports `outcome`, and `ok` is computed on different
  keys; `forkedCopyStopped` keeps `ok:true` although it came from a thrown
  `FORKED_COPY`.
- Treat a Codex runtime endpoint change like Claude's identity-matching
  runtime transition instead of refusing or skipping the lane.
- Inject the clock into the Claude command deadline as well as the dispatch
  windows, so the reconcile test that needs a 3 s real deadline on loaded
  runners becomes deterministic.
- Retire the test-only state primitives (`reserveLane`,
  `bindClaudeProviderIdentity`, `bindLaneProviderBridge`) by seeding the
  remaining state tests through the atomic spawn observation, then split the
  400-line adapter spawn and retire functions along the phases the journal
  already names.

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
