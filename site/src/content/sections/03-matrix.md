---
order: 2
anchor: how
label: How it works
number: '02'
title: How it works
lede: >-
  Each provider keeps its own native channel. What they share is the lifecycle,
  so a job looks the same whichever agent is running it.
module: matrix
---

Transmogrify installs as a skill. When your agent needs another agent, it calls
a handful of local Node scripts: one to open a lane, one to steer it, one to
collect what came back.

Underneath, nothing is faked. Codex lanes speak JSON-RPC to a shared
`codex app-server`; Claude lanes run as named Remote Control sessions on your
machine. That is why the work shows up in the real apps instead of a hidden
terminal — and why a lane can survive the agent that started it.

Before it touches a provider, Transmogrify writes down exactly which lane,
which seat, and which operation it is about to run. Every later command
re-resolves that exact record. A session with the right name in the right
directory is not good enough: an ambiguous match is a refusal, not a guess.
