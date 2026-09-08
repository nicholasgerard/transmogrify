---
order: 2
anchor: how
label: How it works
number: '02'
title: How it works
lede: >-
  Claude Code and Codex speak completely different languages. Transmogrify
  speaks both and gives you one set of commands.
module: matrix
---

Transmogrify installs as a skill: a folder your agent reads. When your agent
needs another agent, it runs a few small scripts on your machine. One opens a
job, one sends it instructions, one collects the result.

The scripts talk to each tool through its own front door. Codex jobs run as
threads on a shared Codex server on your machine, so the ChatGPT app can show
them live once it is connected to that server. Claude jobs run as named Remote
Control sessions, so the Claude app shows them. Jobs keep running after the
agent that started them is gone.

Before it starts anything, Transmogrify writes down which job, which clone, and
which step it is about to run. Later commands look that record up rather than
guessing which session looks right. If two sessions could match, it stops and
asks you.

It runs on macOS or Linux with Node.js 20 or newer. Claude jobs need an Apple
Silicon Mac. Everything runs on your machine, and the shared Codex server
accepts connections from any program running there, so treat that machine as
trusted.
