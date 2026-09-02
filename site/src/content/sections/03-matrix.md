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
    Reliable mobile execution is not yet claimed for a Codex lane created
    before ChatGPT Desktop restarts. A fresh post-restart lane succeeds, but
    exact pre-restart reattachment remains a documented 0.1.0 limitation.
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

Both orchestrators can create Codex lanes that render in the Codex and ChatGPT
desktop and mobile apps. The Claude adapter creates named local Claude Code
Remote Control sessions, which execute on your machine and connect outward
through Anthropic over TLS.

A same-provider orchestrator may prefer its own built-in task tool — but only
when that tool exposes the full contract: exact identity, native visibility,
directed steering, status, stop, recovery, archival, and a durable ownership
receipt. Otherwise the standalone adapter is used, so that the guarantees on
this page keep holding.
