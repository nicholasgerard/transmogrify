---
order: 1
anchor: what
label: What it is
number: '01'
title: What it is
lede: >-
  One skill, installed in Claude Code or Codex. From then on either app can put
  the other to work and watch it happen.
module: ledger
ledger:
  - term: Either app drives either agent
    tone: affirm
    detail: >-
      Claude Code can hand a job to Codex. Codex can hand one to Claude Code.
      The same commands work in both directions.
  - term: Every job gets its own worktree
    tone: affirm
    detail: >-
      A lane runs in its own checkout, so two agents never edit the same files.
      The seat is only cleaned up if it is still clean.
  - term: You can watch it in the app
    tone: affirm
    detail: >-
      Lanes appear as named sessions in Codex Desktop, the ChatGPT app, and
      Claude's Remote Control — on your laptop and on your phone.
  - term: Work outlives the session that started it
    tone: affirm
    detail: >-
      If the orchestrating agent exits, the lane keeps running under the same
      name and you can pick it back up.
  - term: No server, no account, no telemetry
    tone: deny
    detail: >-
      A skill and a few Node scripts on your machine. Nothing phones home, and
      this website is not a dependency.
---

Coding agents are good at working alone and bad at working together. Hand one a
big job and you get a terminal full of unnamed subprocesses: no way to tell
which is doing what, no safe way to send a follow-up, and nothing left to
inspect when the session that started them exits.

Transmogrify gives every agent job a name, a seat, and a receipt. You can see it
in the app, steer it while it runs, collect what it produced, and retire it —
whichever agent started it.
