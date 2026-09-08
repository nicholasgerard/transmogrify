---
order: 1
anchor: what
label: What it is
number: '01'
title: What it is
lede: >-
  Install it once. After that, Claude Code and Codex can hand each other work
  and watch it run.
module: ledger
ledger:
  - term: Work in either direction
    tone: affirm
    detail: >-
      Claude Code can hand a job to Codex, and Codex can hand one to Claude
      Code. The commands are the same either way.
  - term: A separate checkout for every job
    tone: affirm
    detail: >-
      Each job gets its own clone of your repository, so two agents never edit
      the same files. A job commits its work and hands the commit back; nothing
      is copied out of the clone by hand.
  - term: Jobs you can see and steer
    tone: affirm
    detail: >-
      Every job has a name. Codex jobs show up in the ChatGPT app when it is
      connected to the same runtime, and Claude jobs show up in the Claude app
      through Remote Control. Send more instructions while a job runs.
  - term: Jobs that outlive the agent that started them
    tone: affirm
    detail: >-
      Close the agent that kicked off a job and the job keeps running under the
      same name. Pick it up again whenever you want.
  - term: A server, an account, or telemetry
    tone: deny
    detail: >-
      Transmogrify collects nothing and needs no account or server of its own.
      Your Claude and ChatGPT accounts work as they already do. Jobs keep
      running if this website disappears.
---

Give a coding agent a big piece of work and it will spawn helpers. What you get
back is a terminal full of unnamed processes: you cannot tell which one is doing
what, you cannot send any of them a follow-up, and when the session that started
them ends, so do they.

Transmogrify gives each job a name and its own clone of your repository. You can
watch it in the app, send it more instructions, collect the commit it hands
back, and close it out. It works the same way whichever agent started it.
