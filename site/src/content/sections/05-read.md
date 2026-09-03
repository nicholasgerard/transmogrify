---
order: 4
anchor: docs
label: Docs
number: '04'
title: Docs
lede: >-
  Every claim on this page is written up properly somewhere in the repository.
  These are the documents that decide, not this website.
module: docs
docs:
  - title: SKILL.md
    detail: >-
      The policy your agent actually loads: ownership rules, seating, steering,
      harvest and retirement order, exit codes.
    path: SKILL.md
  - title: Protocol contract
    detail: >-
      Codex on the wire — framing, handshake, the lifecycle method table, turn
      selection, and status semantics.
    path: docs/PROTOCOL.md
  - title: Claude Code integration
    detail: >-
      What Anthropic documents publicly, the tuple this was verified against,
      and exactly where the pinned private boundary sits.
    path: docs/CLAUDE-CODE.md
  - title: Execution profiles
    detail: >-
      Task intents, model selectors, effort guidance, Standard and Fast
      controls, and how a profile is recovered.
    path: docs/EXECUTION-PROFILES.md
  - title: Dispatch and notification
    detail: >-
      How a parent keeps its identity, how children report lineage, and how
      waiting survives a restart.
    path: docs/DISPATCH.md
  - title: Security policy
    detail: >-
      Trust boundaries, credential handling, input and output rules, cleanup
      guarantees, and how to report a vulnerability.
    path: SECURITY.md
  - title: Troubleshooting
    detail: >-
      Setup failures, runtime safety, upgrade and rollback, and what to do when
      cleanup is blocked.
    path: docs/TROUBLESHOOTING.md
  - title: Examples
    detail: >-
      One lane end to end: packet, mailbox, directive, handback, harvest, and
      retirement.
    path: examples/README.md
---
