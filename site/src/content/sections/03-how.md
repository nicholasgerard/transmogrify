---
order: 2
anchor: how
label: How it works
number: '02'
title: How it works
lede: >-
  Claude Code and Codex are driven in completely different ways. Transmogrify
  puts one set of commands on top of both.
module: providers
providers:
  - id: claude
    title: Claude
    body: >-
      A Claude job is a Claude Code session started in the background with
      Remote Control on, so the Claude app lists it on your Mac and your phone
      the way it lists your own sessions. Instructions you send land at the
      session's next safe point. Stopping a job stops that exact session, and
      closing it out archives it in the app.
    doc:
      label: Claude Code integration
      path: docs/CLAUDE-CODE.md
  - id: codex
    title: ChatGPT
    body: >-
      A Codex job is a thread on a shared Codex server that Transmogrify runs
      on your machine. The ChatGPT app connects to that same server, so the
      thread appears and streams there live; if the app is not connected, the
      job still runs, just without the live view. Instructions can be sent
      mid-turn, a turn can be interrupted, and closing out archives the thread.
    doc:
      label: Protocol contract
      path: docs/PROTOCOL.md
---

Transmogrify installs as a skill: a folder your agent reads. It gives your
agent one set of commands, open a job, steer it, collect its result, close it
out, and each command has an implementation for each app. Your agent uses the
same words whichever way the work is going.

Before it starts anything, Transmogrify writes down which job, which clone, and
which step it is about to run. Later commands look that record up rather than
guessing which session looks right. If two sessions could match, it stops and
asks you.

It runs on macOS or Linux with Node.js 20 or newer. Claude jobs need an Apple
Silicon Mac. Everything runs on your machine, and the shared Codex server
accepts connections from any program running there, so treat that machine as
trusted.
