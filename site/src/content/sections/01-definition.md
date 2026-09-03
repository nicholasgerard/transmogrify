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
  - term: Either app drives either agent
    tone: affirm
    detail: >-
      Claude Code can hand a job to Codex, and Codex can hand one back. The
      commands are the same in either direction.
  - term: Every job gets its own worktree
    tone: affirm
    detail: >-
      Jobs run in separate checkouts, so two agents never edit the same files.
      A worktree is removed only if nothing changed in it after you collected
      the work.
  - term: You can watch it in the app
    tone: affirm
    detail: >-
      Jobs show up as named sessions in Codex Desktop, the ChatGPT app, and
      Claude's Remote Control, on your laptop or your phone.
  - term: Work outlives the session that started it
    tone: affirm
    detail: >-
      Close the agent that kicked a job off and the job keeps running under the
      same name. Pick it up again whenever you want.
  - term: No server, no account, no telemetry
    tone: deny
    detail: >-
      A skill and a few Node scripts on your machine. Nothing phones home, and
      nothing needs this website in order to keep working.
---

Give one coding agent a big piece of work and it will spawn helpers. What you
get back is a terminal full of unnamed subprocesses. You cannot tell which one
is doing what, you cannot send any of them a follow-up, and when the session
that started them exits, so do they.

Transmogrify names each job and gives it its own Git worktree. It calls them
lanes. You can watch a lane in the app, send it more instructions while it
runs, collect what it wrote, and close it out, and that works the same way
whichever agent started it.
