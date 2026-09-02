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
standalone adapters implement both target providers on the pinned compatibility
tuple. Claude Desktop/mobile visibility, mobile-originated input, and native
archive behavior are live-verified on the recorded build tuple. Codex mobile
visibility is also live-verified on its recorded build tuple, but Desktop
attachment is not implied by a successful app-server handshake. A Desktop
update or restart can leave an independently managed `0.151.x` runtime alive
while the app starts a distinct bundled runtime. Tasks on the surviving runtime
can remain controllable there yet appear in Desktop as controlled from another
app, without live activity. Every new Codex lane in 0.2.x is therefore
recorded protocol-only and requires `--allow-protocol-only` at spawn. Until
the official Desktop-owned SSH path and the CLI-exposed daemon/proxy surface
prove a safe attachment path, pause new cross-host Codex dispatches after a
Desktop lifecycle change and run a disposable exact-owned visibility check
against the selected runtime before claiming native control.

Managed dispatch now has two provider-neutral contracts. Execution profiles
resolve a task intent or explicit override to an immutable model, effort, and
Standard/Fast receipt; provider adapters compile that receipt to their native
controls and reapply it on recovery. Parent contexts reserve every child before
mutation, prefix its first message with safe visible provenance, and retain
durable sequenced events until the parent explicitly handles and acknowledges
them. The current contracts are in
[Execution profiles](docs/EXECUTION-PROFILES.md) and
[Dispatch and lineage](docs/DISPATCH.md).

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
  reattachment remains a known limitation in 0.2.x.
- Leave a dirty managed worktree and confirm cleanup blocks without data loss.
- Seed foreign sessions with colliding names and short IDs and confirm no
  mutation reaches them.

No GUI automation is part of the control plane. Native deep links may present an
already-owned session, but session identity and lifecycle control come from
provider or measured local interfaces.

## Priority 1: compatibility and acceptance hardening

- Close and rerun the Codex pre-restart-lane reattachment case after a Desktop
  restart; capture the exact failing provider boundary if the current app tuple
  still rejects it.
- Verify the supported Desktop-owned SSH runtime path. Determine whether
  Desktop's SSH launcher uses `app-server daemon` and `app-server proxy`,
  identify its CLI-exposed control socket and lifecycle owner, then prove that a
  second Transmogrify client can initialize, create one disposable task, stream
  live in Desktop and mobile, steer, stop, and archive without restarting or
  reconfiguring the Desktop-owned daemon. A healthy independent WebSocket
  runtime is insufficient, and private app sockets are not control surfaces.
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
- Add an explicit owner-authorized abandon operation for a lane whose
  `thread/start` outcome was lost before its thread ID became durable, so the
  reserved seat and journal can close without inferring provider state.

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
