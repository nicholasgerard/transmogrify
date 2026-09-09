---
order: 3
anchor: docs
label: Docs
number: '03'
title: Docs
lede: >-
  Transmogrify is open source and released under the MIT license. You can
  check out the full source on GitHub and freely adapt it for your needs.
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
  - title: Execution profiles
    detail: >-
      How a job's intent becomes a model, an effort level, and a speed, and
      how to name a model yourself.
    path: docs/EXECUTION-PROFILES.md
  - title: Notifications
    detail: >-
      How the agent that started a job is woken when the job finishes, needs
      attention, or is gone.
    path: docs/NOTIFICATIONS.md
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
