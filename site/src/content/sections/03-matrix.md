---
order: 3
anchor: matrix
label: Host to target
number: '03'
title: Which combinations exist, and what is still gated
lede: >-
  Either host can drive either target. The table below is rendered from the
  repository's own support matrix at build time, so it cannot drift from the
  README.
module: matrix
gated:
  - >-
    Native Claude Code behavior is not claimed for Desktop or mobile client
    builds outside the exact live-verified tuple recorded in the skill and
    Claude integration contract.
  - >-
    A compatible Codex app-server handshake does not prove that the current
    ChatGPT Desktop launch or paired mobile app is attached to that runtime.
    After a Desktop restart or update, pause new cross-host dispatches until a
    disposable exact-owned lane visibly streams in the current app.
  - >-
    Claude lifecycle mutations run only on Apple Silicon macOS with the pinned
    Claude Code CLI, a first-party `claude.ai` account, and the default config
    directory. An unmeasured CLI build fails closed.
  - >-
    Claude's native archive has no documented public API for an exact Remote
    Control session, so it uses one narrowly pinned private request. It stays
    disabled unless the caller passes `--private-archive`, and an unmeasured
    Claude Desktop build disables that step without disabling the public
    lifecycle.
  - >-
    The standalone Codex tools are CI-tested on macOS and Linux. Windows is not
    a supported host in this release.
  - >-
    Codex `thread/start` exposes no client idempotency key, so a lost response
    leaves a window the adapter records as unknown and refuses to replay. This
    is a known recovery boundary, not a solved problem.
  - >-
    Releases are cut only after the acceptance gate in the roadmap is green on
    one fresh installation.
footnote: >-
  Roadmap intent is never presented as current support. If a capability is not
  on this page as implemented and verified, treat it as unavailable.
---

On the recorded compatibility tuple, both orchestrators created Codex lanes
that rendered in the Codex and ChatGPT desktop and mobile apps. A current-launch
visibility receipt remains required because the app can own a different runtime
after restart. The Claude adapter creates named local Claude Code Remote Control
sessions, which execute on your machine and connect outward through Anthropic
over TLS.

A same-provider orchestrator may prefer its own built-in task tool — but only
when that tool exposes the full contract: exact identity, native visibility,
directed steering, status, stop, recovery, archival, and a durable ownership
receipt. Otherwise the standalone adapter is used, so that the guarantees on
this page keep holding.
