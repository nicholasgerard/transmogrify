---
order: 2
anchor: how
label: How it works
number: '02'
title: How it works
lede: >-
  Codex and Claude Code talk over completely different channels. Transmogrify
  keeps both and puts one set of commands on top.
module: matrix
---

Transmogrify installs as a skill. When your agent needs another agent, it runs
a few Node scripts on your machine: one opens a lane, one sends it
instructions, one collects the result.

Those scripts use each provider's own interface. Codex lanes go over JSON-RPC
to a shared `codex app-server`. Claude lanes run as named Remote Control
sessions. Because they are real sessions, they appear in the apps you already
have open, and they keep running after the agent that started them is gone.

Before it starts anything, Transmogrify writes down which lane, which worktree,
and which operation it is about to run. Later commands look that record up
again rather than searching for a session that looks about right. If two
sessions could match, it stops and tells you.
