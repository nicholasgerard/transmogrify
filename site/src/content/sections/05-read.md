---
order: 4
anchor: docs
label: Docs
number: '04'
title: Docs
lede: >-
  This page is a summary. Where it disagrees with the repository, the
  repository is right.
module: docs
docs:
  - title: SKILL.md
    detail: >-
      The policy your agent loads. Ownership rules, seating, steering, the
      order of harvest and retirement, and the exit codes.
    path: SKILL.md
  - title: Protocol contract
    detail: >-
      Codex on the wire. Framing, handshake, the lifecycle method table, turn
      selection, and what each status means.
    path: docs/PROTOCOL.md
  - title: Claude Code integration
    detail: >-
      What Anthropic documents publicly, the versions this was verified
      against, and where the pinned private boundary sits.
    path: docs/CLAUDE-CODE.md
  - title: Execution profiles
    detail: >-
      Task intents, model selectors, effort settings, Standard and Fast, and
      how a profile survives a recovery.
    path: docs/EXECUTION-PROFILES.md
  - title: Dispatch and notification
    detail: >-
      How a parent keeps its identity, how children report back, and how
      waiting survives a restart.
    path: docs/DISPATCH.md
  - title: Security policy
    detail: >-
      Trust boundaries, credential handling, what goes in and out, cleanup
      guarantees, and how to report a vulnerability.
    path: SECURITY.md
  - title: Troubleshooting
    detail: >-
      Setup failures, runtime safety, upgrading and rolling back, and what to
      do when cleanup is blocked.
    path: docs/TROUBLESHOOTING.md
  - title: Examples
    detail: >-
      One lane from start to finish: packet, mailbox, directive, handback,
      harvest, retirement.
    path: examples/README.md
---
