# Changelog

## 0.2.0

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
