# Changelog

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
