# Changelog

## 0.6.1 (in progress)

- Create managed seats as clones so children can commit within their sandbox.
  Pin clone metadata and alternates, record the measured dissociation choice,
  fetch and verify child handback SHAs under the repository lock, and refuse
  non-fast-forward updates or deletion of unfetched work. Preserve legacy
  worktree cleanup and the operator commit fallback.

- Add GPT-6 Astra to Codex execution guidance for `deep` and `max-quality`,
  with a receipted GPT-5.6 Sol fallback on older live catalogs, explicit model
  upgrade hints, and catalog-gated Ultra effort guidance.
- A dispatched child's first message reads provenance box, exchange preamble,
  then packet again. The exchange preamble had been prepended after the
  provenance box was rendered, burying the `╭─ Transmogrify` block that names the
  parent session.
- Classify an absent Claude Code executable as an installable setup need and
  report permission failures as a non-executable CLI instead of falling into
  generic manual recovery.
- Identify Claude and Codex desktop hosts from verified bundle identifiers at
  relocated, system, or per-user app paths. Export the same read-only bundle
  inventory and bundled CLI paths for later doctor and attachment reuse.
- Describe newer Claude CLI measurement as vendor observations plus option
  checks. The local follow-up acknowledgment fixture is no longer presented as
  a live vendor probe.
- Make the published start handoff verify Git, Node.js 20 or newer, npm, a
  committed repository, and a visibly resolved repository root before it
  creates any preparation directory.
- Record whether a relay was launched or merely adopted. Stop only a launched
  relay whose live process birth exactly matches its receipt.
- Make Desktop persistence a receipt-backed transaction that preserves foreign
  login settings, rolls back partial writes, and refuses unowned removal.
- Mark installer backups with owner-only receipts. Retention now moves only
  valid receipted backups and refuses symlinked trash paths.
- Receipt every created seat provision and refuse automatic cleanup when an
  entry was replaced, gained unexpected output, or came from a version 0.6.0
  name-only record.
- Require an affirmative quiescent provider observation before harvest.
- Fsync durable handbacks before journaling them as copied and retain one
  immutable content-addressed copy for every distinct harvested handback.
- Compose doctor observations, typed setup plans, and guided setup execution:
  distinguish missing Codex binaries, sign-in, and runtime state; execute one
  non-interactive action per invocation; preserve provider limitations; use
  launch-only and authorized persistence operations; and keep terminal summary
  output separate from JSON.

## 0.6.0

- A Claude lane spawned by a measured CLI persists the same exact runtime
  tuple as before: preflight's build-measurement receipt is diagnostic output
  for the doctor and is stripped before any registry write or identity
  comparison. Found in the release smoke, where every Claude spawn had failed
  registry validation on the new field.
- Guided setup selects the Codex runtime with the same precedence as every
  other command (`TRANSMOGRIFY_URL`, the live relay record, then the legacy
  port), and the attachment LaunchAgent names a stable Node alias when one
  resolves to the running executable, so a Node upgrade does not break login
  persistence.
- A lane's own completed retirement or stop no longer wakes the parent when
  the watcher records the terminal event late: `child.retired` after a
  completed `retire`, and `child.stopped` after a completed `stop`, are
  acknowledged at observation whatever their age, because neither can happen
  without the parent's command (measured 2026-09-04: three retirements woke
  the parent once each, four minutes after the fact).
- Add a sandbox-true lane exchange: every child receives a worktree-local
  packet and handback contract, managed seats share the project's existing
  `node_modules` by symlink, and the operator-side journaled `harvest` command
  validates and preserves the handback, optionally commits the reviewed diff,
  removes recorded provisions, and prints the exact retirement command.
- Prefer Codex's installer-managed app-server daemon and reach its Unix control
  socket directly from Transmogrify or through an owned loopback TCP relay for
  Desktop. `runtime-up.sh` now returns the relay URL, socket, and daemon version
  as JSON, and explicitly reports its legacy standalone fallback. Runtime URL
  selection reads the live relay record before falling back to port 8843.
- Make Desktop attachment use that same runtime precedence in both `check` and
  the doctor, receipt the relay's daemon socket, and ensure a missing relay via
  `runtime-up` before launching Desktop. Add reversible, owner-authorized
  `persist`/`unpersist` commands for the login environment and per-user
  LaunchAgent so Dock launches stay on the shared daemon across app updates.
- Claude Code CLI compatibility now has a measured minimum of 2.1.258 with no
  maximum: newer builds are probed once and cached by executable digest, failed
  probes are named, and setup advice never proposes a downgrade. The doctor
  also caches required Codex app-server method probes by runtime version and
  inventories the PATH, Desktop-bundled, and explicitly selected Codex CLIs.
- Detect whether setup is running in a desktop app, terminal, IDE, or plain
  shell from environment markers and shared process ancestry, and let
  `doctor --explain` describe one ordered setup plan for both lane hosts in
  plain language without changing the doctor's existing owner actions.
- Add consent-gated guided setup for both hosts, with measured doctor reruns,
  protected hosting CLIs, owned-runtime checks, Desktop attach persistence,
  vendor-documented installers, and machine-wide install readiness guidance.
- Make the one-line start handoff install both host skills, run the explaining
  doctor, and guide only the first consented setup step at a time. Terminal,
  IDE, and unsupported-machine narration now comes from the same context
  sentences as the doctor's plan.
- The Codex runtime is accepted by version, 0.151.0 or newer, whatever
  product name it reports: the managed daemon names itself after the
  originator of its first client. The client's handshake no longer offers
  per-message deflate, which the daemon refuses.

## 0.5.0

- Wake economy ([docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md#cost-model)):
  the watcher delivers one wake per observation round naming every event
  of that round, retries a refused wake at most three times, and never
  resends one that may have landed; an observation that only confirms the
  parent's own completed retire, stop, or interrupt is recorded already
  acknowledged. `ack --through <sequence>` acknowledges every pending
  event up to the highest sequence a wake or wait named.
- Cheaper polling: a working child is read every three seconds, an idle
  child every thirty, and a parent's own spawn, steer, recover, interrupt,
  stop, and retire nudge the watcher to read that child at once; settled
  children are skipped; the watcher exits fifteen minutes after the last
  child settled. A Codex wake now reads the newest turn (the oldest was
  being consulted) before choosing between steer and start.
- Cheaper reads: a long-running observer (the watcher, one `wait`) measures
  the Claude runtime once per CLI file and reads the census once per round
  (`lib/observer-cache.js`), shares one loopback connection per round for
  Codex reads, and subscribes to the app-server's notifications so an
  outstanding Codex child is read the moment the runtime reports a change.
- Claude children spawned for a parent carry session hooks (one private
  settings file per lane, passed with `--settings`) that nudge the parent's
  watcher when a turn ends, the session ends, or a notification is raised,
  so a child is read the moment it finishes instead of being polled;
  `TRANSMOGRIFY_CHILD_HOOKS=off` disables it. Verified live on the pinned
  CLI.
- Both adapters are split along their lifecycle: `lib/codex-runtime.js`,
  `lib/codex-retire.js`, and `lib/codex-recover.js` beside
  `lib/codex-adapter.js`; `lib/claude-runtime.js`, `lib/claude-spawn.js`,
  `lib/claude-retire.js`, and `lib/claude-recover.js` beside
  `lib/claude-adapter.js`. Pure moves; the adapters' public surfaces are
  unchanged. The largest lifecycle functions (Codex spawn, resume, retire,
  and recovery; Claude spawn, retire, and reconciliation; the lane CLI
  entry) are each decomposed into named phases that share one context, with
  behavior, journal phases, and error shapes unchanged.

## 0.3.1

- Turnkey child notifications ([docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md)).
  `parent-init` discovers and records how the running session can be woken
  (a Claude Code session's own Remote Control bridge, or a Codex thread from
  `CODEX_THREAD_ID` verified on the runtime by the command it is running).
  `spawn` starts a per-parent watcher (`scripts/watch.js`) that observes every
  child every few seconds and delivers a short fixed message into the
  parent's session when a child completes, needs attention, or ends; the
  message names the lane, the event kind, and the two commands to run, and
  never carries child output. Events read back carry `kind` (`progress`,
  `complete`, `attention`, `terminal`) and `terminal`; both providers report
  a finished assignment as `child.turn-completed`.
- `wait` observes every outstanding child on every call and returns old and
  new unacknowledged events together, so an old event can never hide a new
  completion; it takes `--until any|complete|terminal` and blocks up to
  thirty minutes for background use. `children --observe` refreshes every
  child's live phase and reports the watcher and wake channel.
- Claude `steer` retries transcript verification for up to 20 s within the
  command deadline before reporting `DELIVERY_UNCERTAIN`.
- Codex reconciliation settles a spawn whose input never appeared
  (`spawnInputAbsent`) after a bounded grace period and settles a steer
  left unknown from its `clientUserMessageId` receipt (`steerInputReceipt`,
  `steerInputAbsent`); steers now carry that id.
- One reconcile result shape for both adapters: `results[]` entries carry
  `state`, `phase`, `providerPhase`, `outcome`, `delivery`, `repaired`,
  and `pendingOperation`, `receipt.providerConnection` says whether the
  provider was consulted, and `ok` is computed from the same keys on both
  sides; a forked Claude copy that had to be stopped is no longer reported
  as ok. Exit code 2 is reserved for safe deferrals (cleanup retryable,
  retirement pending, different runtime), 3 for everything else.
- A Codex runtime endpoint change is a repairable transition: `recover`
  moves a lane bound on another endpoint to the connected one when the
  runtime identifies itself as the same Codex home on the same platform and
  the lane's thread is readable at its reserved seat (`runtimeRebound`,
  `repaired: ['runtimeEndpoint']`); any other runtime, or an unreadable
  thread, is still reported as `differentRuntime` and nothing is written.
- Every Claude adapter deadline reads the injected clock; the timing tests
  advance a fake clock instead of waiting.
- A spawn that fails before reserving a lane settles its parent dispatch as
  `failed` with one terminal `child.failed` event (reason
  `spawn-not-registered`) instead of leaving a child the parent is asked
  to attend forever; a dispatch abandoned by a crashed spawn is settled the
  same way five minutes after creation.
- Claude `steer` and the watcher's wake accept the CLI's follow-up
  acknowledgement as printed by 2.1.258 (the bridge in either prefix form
  and a query string on the URL); a steer that landed within a second was
  previously reported `DELIVERY_UNCERTAIN`.
- Claude `stop` no longer fails after the worker exit when the parent's
  watcher observed and recorded the same exit first.
- Claude reconciliation reports a retired lane with nothing pending as
  `alreadyRetired` before comparing runtimes.
- `scripts/maintain.js`: a bounded maintenance runner (doctor plus each
  available provider's exact-owned reconcile, aggregate counts only) and a
  recoverable `--retention` pass over aged, worktree-released journals and
  superseded installer backups.
- Observation and provider lookup live in `lib/observe.js` and
  `lib/providers.js`; wake discovery and delivery in `lib/wake.js`.
- Retired the test-only `reserveLane`/`bindClaudeProviderIdentity`/
  `bindLaneProviderBridge` state primitives, superseded by the atomic
  `reserveSpawn`/`bindClaudeSpawnObservation` path, and the dead
  `waitForTranscriptDelivery` transcript-polling helper in
  `lib/claude-surface.js` (steer now polls `verifyDeliveryTranscript`).

## 0.3.0

- Output contract. Success output is now an allowlist per operation
  (`scripts/lib/output-schema.js`, printed by `lane.js schema`, documented in
  `docs/OUTPUT.md`): a key that is not declared public never prints, where
  0.2 dropped a denylist of private keys. Golden tests pin every shape. Any
  consumer that read undeclared keys must move to the declared ones.
- `status` reports one `phase` vocabulary for both providers (`executing`,
  `waiting`, `idle`, `stopped`, `failed`, `retired`, `unknown`) and keeps the
  provider's own word in `providerPhase`; parent events and observations keep
  the 0.2 vocabulary. Codex `interrupted` and `notLoaded` read as `idle`.
- SKILL.md is rewritten around the happy path: a numbered eight-step
  overview, a doctor decision table, per-host attach rules, one phase table,
  the listen loop, recovery, harvest and retire, and a "when it fails" table,
  with the mechanism prose living in the docs it links. `parent-init` accepts
  only the enumerated host applications (`codex-desktop`, `codex-cli`,
  `codex-web`, `claude-code`, `claude-desktop`, `claude-web`).
- Cleanup. One sleep helper (`scripts/lib/async.js`) and one owner-only JSON
  reader (`record-guards.readOwnedJson`) replace per-module copies; the
  unused `named` and `logicallyRetired` lane states are gone; the Claude
  adapter reads its dispatch windows and absence grace through
  `options.clock` so tests can move time; the installer's swap rollback is
  covered by a test; the troubleshooting index gains ownership/identity and
  uncertain-steer sections.

## 0.2.8

- One adapter seam. Each provider adapter publishes a descriptor (its
  operations, the provider flags it accepts, whether recovery takes input)
  and `lane.js` dispatches from it; no operation branches on a provider by
  name any more. Shared invariants live in `scripts/lib/adapter-kit.js`:
  the coded `AdapterError`, the managed worktrees root, the execution
  request, the profile-failure projection, and one lane result envelope
  (Codex results now carry `providerId`, Claude results `operationId`).
- The unstarted-spawn crash repair is one function in the state store that
  both adapters call; the Claude identity schema moves to
  `scripts/lib/claude-identity.js` behind backend-keyed dispatch; loopback
  listener inspection moves to `scripts/lib/listeners.js` so the Desktop
  attach tool no longer imports the runtime launcher; the Codex client is
  injectable through `options.clientFactory`. `test/adapter-contract.test.js`
  pins the contract a third adapter must satisfy.
- Codex recovery repairs an unbound reservation locally before comparing
  runtime endpoints, closes a resume journal that never reached `turn/start`
  (`resumeDispatching`, `resumeAcknowledged`, `unknownResume`) as input
  not delivered instead of probing for a turn that cannot exist, and accepts
  `--finish-retirements` for symmetry with Claude.

## 0.2.7

- Enumerate the states each operation journal type may hold and refuse any
  other write before it reaches disk. A Claude retirement's nested stop and
  the observation-bound `providerObserved` spawn phase are part of the table,
  and a test checks every state literal handed to a journal writer against it.
- Stamp operation records with `schemaVersion` (absent reads as 1), migrate
  the registry on read when an upgrade path exists, and refuse a state
  directory written by a newer Transmogrify with an upgrade instruction.
- Add `lane.js abandon --lane <id> --reason <text>`: closes a stranded
  spawn, steer, stop, recover, resume, or interrupt journal as failed with the
  owner's reason and `providerOutcome: unknown`. It never abandons a
  retirement (`ABANDON_REFUSED`) and never implies a provider outcome.
- One command surface. `scripts/transmogrify.js <doctor|attach|runtime|probe|lane|rpc|listen>`
  forwards to each tool and shares its exit status; every tool now uses the
  same exit table (0 confirmed, 2 usage or safe refusal, 3 failure or
  uncertain outcome, 1 internal) and the fixed public messages in
  `scripts/lib/public-error.js`, with a test that every thrown code has one.
  `rpc.js` usage errors exit 2 instead of 3 and RPC errors exit 3 instead of
  1; `runtime-probe.js` and `runtime-launch.js` failures exit 3 instead of 1;
  `desktop-attach.js ensure` exits 2 for a refusal before acting and 3 after;
  `lane-status-listen.js` exits 2 for an ownership refusal before subscribing.
- `--timeout-ms` is the one timeout flag: `doctor.js`, `rpc.js`, and
  `runtime-probe.js` rename `--timeout`, and provider-touching `lane.js`
  operations accept it to bound each request.
- Remove `scripts/steer.js`; `lane.js steer|recover|interrupt` has covered
  it since 0.1. `PENDING_OPERATION` replaces the duplicate `OPERATION_PENDING`
  code.

## 0.2.6

- Fix a `wait` failure path introduced in 0.2.4: a child whose observation
  failed made the command throw instead of returning `OBSERVATION_FAILED`
  with the failing children named.
- Mark each doctor owner action `blocking` or advisory. A Codex Desktop that
  is not attached no longer makes `setup.ready` false, since Codex lanes stay
  available protocol-only; a logged-out Claude CLI or a missing runtime does.
- Keep `FORKED_COPY` as the public code when a Claude recovery forks, pass the
  census deadline through the absent-job settlement, make the ownership lock
  loop sleep instead of spinning when its holder is not yet observable, and
  reject an empty or repeated `--url` in `runtime-up.sh`.
- Document the per-provider status phases, correct the examples that branched
  on the Codex vocabulary for Claude lanes, link the troubleshooting index and
  the phase table from SKILL.md, show `--worktrees` in the spawn example, and
  add a test that the skill's published pins equal the enforced constants.

## 0.2.5

- Render a provenance block for a model that has no effort selector. Since
  0.2.1 every Claude `fast-loop` dispatch, which resolves to Haiku with a null
  effort, was refused with "profile effort must be a string" before any
  provider mutation. Found by the Codex-host acceptance run.

## 0.2.4

- Contain a forked Claude recovery: on the pinned CLI a background resume of
  a stopped job starts a new session, so `recover` now stops the copy its own
  command created, closes the journal as `forkedCopyStopped`, and leaves the
  lane stopped for retirement or replacement; a recovery whose window passes
  with no running session settles as `recoveryNotAchieved` on reconcile.
- Name each child whose observation failed inside a `wait` error.
- Record the resume behaviour honestly in the Claude integration document,
  the troubleshooting guide, and the roadmap.

## 0.2.3

- Wait for a Claude session's first receipts: spawn retries the transcript
  receipt and the Remote Control bridge inside a 30 s window instead of
  declaring the spawn uncertain on the first read, and the public refusal
  now carries `causeCode`, `causeMessage`, and `ownerAction`.
- Match a Claude delivery receipt anywhere in the record: the CLI wraps a
  peer follow-up as "Another Claude session sent a message: …" with guidance
  appended after the marker, which made every delivered steer report as
  unknown.
- Reword the provenance block (version 3) to say the task comes from the
  user's own session and that the child works within its normal permissions,
  after an acceptance probe read the anonymous dispatch banner as a takeover
  attempt and declined.

## 0.2.2

- Name the failing check when a Claude spawn cannot be verified: the refusal
  and the journal carry `causeCode` and `causeMessage`, a session that never
  registered Remote Control reports `REMOTE_CONTROL_UNAVAILABLE` with the
  owner action, and `reconcile` repeats that guidance.
- Settle a dispatched Claude spawn whose job has vanished: after a grace period
  and repeated absence, `reconcile` closes the journal as `spawnJobAbsent`,
  the parent receives `child.failed`, and `retire` frees the managed seat
  without any provider mutation.
- Let the doctor say what setup the owner still has to do: `setup.ownerActions`
  names the exact command for a logged-out or unpinned Claude CLI, a missing
  Codex runtime, or an unattached Codex Desktop, and SKILL.md and `/start`
  make the operator ask before spawning.
- Editorial pass over SKILL.md, README, and every document under `docs/`:
  shorter, current, without historical narrative; module and function
  comments across `scripts/`.

## 0.2.1

- Restore the Codex Desktop attachment path as a measured receipt. The new
  `desktop-attach.js` reads whether the app holds a live loopback connection
  to the selected runtime, launches it attached when it is not running, and
  relaunches a running unattached app only with explicit or standing owner
  authorization, never from a session hosted by the app itself, and never by
  touching the runtime.
- Let the doctor report `nativeVisibility.verified:true` from that receipt and
  let Codex spawn record `desktopAttached` lanes without
  `--allow-protocol-only`; the flag now only labels a deliberately unattached
  lane, and every refusal names the Desktop state that was observed.
- Redesign the first-message provenance block (version 2): a box-drawing
  frame, readable host and target labels, and printable-ASCII values that
  cannot forge a frame line.
- Document the attach mechanism, its tested Desktop builds, the shared-runtime
  reuse rule, and the Codex-host guidance that were dropped while preparing
  0.1.0.

## 0.2.0

- Require `--allow-protocol-only` for every Codex spawn and record those lanes
  protocol-only until a machine-verifiable native-visibility receipt exists.
- Add `retire --accept-manual-seat-removal` for both providers so an
  owner-removed blocked seat can close its retirement journal exactly once.
- Let exact retirement close a Codex spawn journal whose first turn never
  receipted, after proving no turn is active and without replaying input.
- Observe every outstanding child on each parent wait, raise one attention
  event for an unresolved spawn or an unavailable child repository, and report
  a verified spawn honestly when its parent event cannot be recorded.
- Keep provider catalog identifiers intact in `capabilities`, `children`, and
  `wait` output while still redacting provider control handles.
- Reclaim ownership locks whose holder no longer exists, code lock timeouts as
  safe refusals, and ignore Finder metadata in private state directories.
- Add provider-neutral execution intents with explicit model, effort, and
  Standard/Fast controls, immutable requested/resolved/observed receipts, and
  recovery-safe provider compilation.
- Prefix every managed task with `::: ` and every first message with a safe,
  versioned parent/dispatch provenance block.
- Add durable parent contexts, child dispatch lineage, restart-safe status
  events, explicit acknowledgement, and at-least-once redelivery until handled.
- Harden lifecycle reconciliation, exact CLI identity, bounded state scans,
  repository isolation, and provider retirement/cleanup notifications.
- Canonicalize every new Codex and Claude Code lane title to `::: <summary>`.
- Keep legacy terminal Claude receipts readable while active identity checks
  continue to require the current runtime shape.
- Complete exact Claude retirement after an owner-reviewed blocked worktree is
  removed, without replaying provider archival.

## 0.1.0 — initial public release

Transmogrify provides one operator skill for exact-owned Codex and Claude Code
lanes: native app visibility, provider-specific lifecycle control, isolated Git
worktrees, durable mutation receipts, restart-safe recovery, verified archive,
guarded cleanup, startup diagnostics, and protocol documentation.
