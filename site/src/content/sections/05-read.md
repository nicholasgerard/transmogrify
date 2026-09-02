---
order: 5
anchor: read
label: Read the source
number: '05'
title: Everything on this page has a receipt
lede: >-
  Protocol and provider claims in this project carry a named generated schema
  definition, a dated live verification against an exact runtime tuple, or an
  explicit `unverified` label. Nothing on this website is the authority; these
  documents are.
module: docs
docs:
  - title: SKILL.md
    detail: >-
      The executable operator policy the agent loads. Host parameters,
      ownership and seating rules, per-provider steering semantics, the harvest
      and retirement ordering, and the exit-code contract.
    path: SKILL.md
  - title: Protocol contract
    detail: >-
      Codex wire-level truth: JSON-RPC framing and handshake, the lifecycle
      method table with its generated schema receipts, turn selection rules,
      status semantics, and the security-relevant schema surface.
    path: docs/PROTOCOL.md
  - title: Claude Code integration
    detail: >-
      What Anthropic documents publicly, the measured compatibility tuple, how
      spawn correlation works, the safe-point steering receipt, and exactly
      where the pinned private archive boundary sits.
    path: docs/CLAUDE-CODE.md
  - title: Execution profiles
    detail: >-
      Provider-neutral task intents, exact model selectors and aliases, effort
      guidance, Standard/Fast controls, immutable receipts, and recovery rules.
    path: docs/EXECUTION-PROFILES.md
  - title: Dispatch and parent notification
    detail: >-
      Durable parent identity, child lineage, the visible provenance block,
      at-least-once events, acknowledgement, and restart-safe waiting.
    path: docs/DISPATCH.md
  - title: Security policy
    detail: >-
      Trust boundaries, the ownership rules, credential handling for the gated
      Claude archive, input and output handling, cleanup guarantees, and the
      private vulnerability reporting route.
    path: SECURITY.md
  - title: Roadmap
    detail: >-
      The release acceptance gate, compatibility hardening, the plan to shrink
      private and version-specific surface, and the deliberate out-of-scope
      boundaries.
    path: ROADMAP.md
  - title: Contributing
    detail: >-
      Development setup, community expectations, the receipt requirement for
      every behavior claim, protocol change procedure, and the verification
      commands a pull request must pass.
    path: CONTRIBUTING.md
  - title: Troubleshooting
    detail: >-
      Setup failures, runtime safety, upgrade and rollback procedures, and
      recovery when cleanup is blocked.
    path: docs/TROUBLESHOOTING.md
  - title: Examples
    detail: >-
      A runnable walkthrough of one lane from startup through packet, mailbox,
      directive, durable handback, harvest digest, and retirement.
    path: examples/README.md
---
