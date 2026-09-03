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
gated:
  - >-
    A Codex lane only streams into Codex Desktop when the app is attached to the
    same runtime. Attachment is measured on macOS by `desktop-attach.js`; a lane
    created without that receipt is marked protocol-only and needs
    `--allow-protocol-only`. Run `desktop-attach.js ensure` again after a
    Desktop restart or update.
  - >-
    Claude lanes are created and controlled only on Apple Silicon macOS, with
    the pinned Claude Code CLI and a first-party `claude.ai` account. An
    unmeasured build fails closed rather than guessing.
  - >-
    Archiving a Claude session uses one narrowly pinned private request, because
    there is no public one. It stays off unless you pass `--private-archive`,
    and turning it off does not disable anything else.
  - >-
    macOS and Linux only. Windows is not a supported host in this release.
  - >-
    Codex `thread/start` has no idempotency key, so a lost response leaves a
    window that is recorded as unknown and never replayed. It is reconciled by
    looking at the provider, not by trying again.
footnote: >-
  Nothing on the roadmap is presented here as working. If a capability is not on
  this page as implemented and verified, treat it as unavailable.
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
