# Changelog

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
