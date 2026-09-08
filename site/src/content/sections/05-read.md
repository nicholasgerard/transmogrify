---
order: 3
anchor: docs
label: Docs
number: '03'
title: Docs
lede: >-
  This page is the short version. Where it disagrees with the repository, the
  repository is right.
module: docs
docs:
  - title: SKILL.md
    detail: >-
      What your agent loads: the rules for who owns a job, where it runs, how
      to steer it, how to close it out, and what each exit code means.
    path: SKILL.md
  - title: Examples
    detail: >-
      One job from start to finish, with every file it produces along the way.
    path: examples/README.md
  - title: Protocol contract
    detail: >-
      How Codex jobs are driven on the wire: framing, handshake, the lifecycle
      methods, and what each status means.
    path: docs/PROTOCOL.md
  - title: Claude Code integration
    detail: >-
      How Claude Code jobs are driven, which versions were verified, and where
      the one private boundary sits.
    path: docs/CLAUDE-CODE.md
  - title: Security policy
    detail: >-
      Trust boundaries, credential handling, cleanup guarantees, and how to
      report a vulnerability.
    path: SECURITY.md
  - title: Troubleshooting
    detail: >-
      Setup failures, runtime safety, upgrading and rolling back, and what to
      do when cleanup is blocked.
    path: docs/TROUBLESHOOTING.md
---
