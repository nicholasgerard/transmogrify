---
order: 1
anchor: what
label: What it is
number: '01'
title: What it is
lede: >-
  Install it once in Claude Code or Codex. After that, either app can hand work
  to the other and watch it run.
module: ledger
ledger:
  - term: Work in either direction
    tone: affirm
    detail: >-
      Claude Code can hand a job to Codex, and Codex can hand one back. The
      commands are the same in either direction.
  - term: A separate clone per job
    tone: affirm
    detail: >-
      Jobs run in separate checkouts, so two agents never edit the same files.
      Removal requires a seat clean at harvest and cleanup, matching provision
      receipts, verified provider retirement, and unchanged commits preserved
      in the operator repository.
  - term: Named sessions you can watch
    tone: affirm
    detail: >-
      Codex jobs appear in the app when measured attachment connects it to
      their runtime; protocol-only lanes also work. Claude jobs use Remote
      Control. Phone access depends on the provider's connected host.
  - term: Jobs that outlive their operator
    tone: affirm
    detail: >-
      Close the agent that kicked a job off and the job keeps running under the
      same name. Pick it up again whenever you want.
  - term: A server, an account, or telemetry
    tone: deny
    detail: >-
      Transmogrify itself collects no telemetry and needs no Transmogrify
      account or server. Provider tools still use their own services and
      accounts. Lanes do not need this website to keep working.
---

Give one coding agent a big piece of work and it will spawn helpers. What you
get back is a terminal full of unnamed subprocesses. You cannot tell which one
is doing what, you cannot send any of them a follow-up, and when the session
that started them exits, so do they.

Transmogrify names each job and gives it a managed Git clone seat. It calls them
lanes. You can watch a lane in the app, send it more instructions while it
runs, collect what it wrote, and close it out, and that works the same way
whichever agent started it.
