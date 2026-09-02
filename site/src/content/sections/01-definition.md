---
order: 1
anchor: definition
label: What it is
number: '01'
title: One lifecycle, two providers, no pretending
lede: >-
  Codex and Claude Code do not share a transport, and Transmogrify does not
  invent one. It gives both the same observable contract — and the same
  refusals — over each provider's own native channel.
module: ledger
ledger:
  - term: One provider-neutral lifecycle
    tone: affirm
    detail: >-
      Spawn, steer, status, stop or interrupt, recover, harvest, retire,
      reconcile. The same eight verbs whichever provider is behind them.
  - term: A single common transport
    tone: deny
    detail: >-
      Codex lanes speak JSON-RPC to a shared `codex app-server` WebSocket.
      Claude lanes use public background Remote Control sessions and `--cloud`
      follow-ups. Transport symmetry is not the goal; lifecycle parity is.
  - term: Native app visibility, with a receipt
    tone: affirm
    detail: >-
      Claude lanes present through Remote Control with a recorded deep-link
      receipt. Codex lanes carry a measured Desktop attachment receipt: the
      app holds a live connection to the shared runtime, or the lane is
      labelled protocol-only by explicit flag. The support matrix below is
      rendered from the repository.
  - term: GUI automation
    tone: deny
    detail: >-
      No part of the control plane drives a desktop application. Deep links may
      present a session that is already owned; identity and control come from
      provider or measured local interfaces.
  - term: Exact ownership, recorded before the provider is touched
    tone: affirm
    detail: >-
      Every mutation resolves a lane registered by this installation, with an
      exact provider identity, seat identity, runtime identity, and one pending
      operation pointer.
  - term: Adoption by name, path, age, or short ID
    tone: deny
    detail: >-
      Those are discovery evidence. They are never ownership. Ambiguity is a
      hard refusal, not a reason to mutate every match.
  - term: Worktree seating
    tone: affirm
    detail: >-
      Each lane gets its own Git worktree seat, pinned by absolute path, kept
      outside the repository's tracked tree.
  - term: A server, an account, or a hosted service
    tone: deny
    detail: >-
      Transmogrify is an installed skill plus standalone Node tools. Operation
      and recovery never depend on DNS or on this website, and neither does
      installation from a Git checkout; the `/start` prompt is a convenience,
      not a dependency.
---

The host repository stays the authority for **what** a lane may do — scope,
reviews, merges, deployments, spend, owner approvals. Transmogrify only owns
**how** the lane runs.
