---
order: 4
anchor: install
label: Install and start
number: '04'
title: Install once, then start every session with the doctor
lede: >-
  The prompt at the top of this page does all of this for you. Here is what it
  is actually asking your agent to do, so you can check the work.
module: steps
steps:
  - title: Pin the target and its private seat root
    body: >-
      Run this from the repository you want to operate before entering any
      installation directory. Preserve the exact target root, and keep managed
      worktrees in a private external, per-repository directory that
      Transmogrify owns.
    code: |
      export REPO_ROOT="$(git rev-parse --show-toplevel)"
      export TRANSMOGRIFY_DATA_ROOT="$HOME/.local/share/transmogrify"
      install -d -m 700 "$TRANSMOGRIFY_DATA_ROOT"
      install -d -m 700 "$TRANSMOGRIFY_DATA_ROOT/worktrees"
      export TRANSMOGRIFY_REPO_KEY="$(node -e 'const { createHash } = require("node:crypto"); process.stdout.write(createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 16))' "$REPO_ROOT")"
      export WORKTREES="$TRANSMOGRIFY_DATA_ROOT/worktrees/$TRANSMOGRIFY_REPO_KEY"
      install -d -m 700 "$WORKTREES"
  - title: Use the release-pinned start document
    body: >-
      Give the agent the same one-line instruction shown at the top of this
      page. The production `/start` document names and verifies one exact
      published commit, previews the installation, and refuses branch fallback.
    code: |
      Fetch https://transmogrify.sh/start and follow its instructions.
  - title: Point at the installed skill
    body: >-
      The installer copies the complete skill and tools to Claude's and Codex's
      documented personal skill locations, moving any existing installation to a
      timestamped backup outside scanned skill directories. Keep the absolute
      root it reports.
    code: |
      export SKILL_ROOT="$HOME/.agents/skills/transmogrify"
  - title: Run the read-only doctor
    body: >-
      Run this before every operator session. The doctor performs an
      initialize-only Codex handshake and a Claude public preflight and agent
      listing, then prints aggregate owned and pending counts. It never starts,
      stops, restarts, steers, archives, removes, or adopts a provider session.
    code: |
      node "$SKILL_ROOT/scripts/doctor.js" \
        --repo-root "$REPO_ROOT" \
        --target codex
  - title: Reuse a runtime before you provision one
    body: >-
      If a verified Codex runtime is already listening, use it. Start one only
      when the machine's owner has authorized this installation to own it — the
      launcher accepts loopback listeners only, refuses an occupied endpoint
      that fails the Codex handshake, and reuses a compatible listener instead
      of killing it.
    code: |
      "$SKILL_ROOT/scripts/runtime-up.sh"
  - title: Open the lane
    body: >-
      Pass prompt text through stdin so it never appears in the operator
      command's arguments. The result carries an installation-scoped `laneId` —
      the only handle you should persist or pass to later operations.
    code: |
      printf '%s\n' 'Inspect the failing tests and report the smallest safe fix.' |
        node "$SKILL_ROOT/scripts/lane.js" spawn \
          --repo-root "$REPO_ROOT" \
          --worktrees "$WORKTREES" \
          --target codex \
          --name '[codex] tests: diagnose failure' \
          --input-file -
footnote: >-
  Every advertised tool accepts `--help`. Standalone Codex turns run with the
  fixed `workspace-write` sandbox and approval policy `never`; an action that
  needs approval returns to the host rather than quietly widening a lane's
  authority.
---

Before you begin, confirm the requirements: Git, Bash, `ps`, and `lsof`; a
target repository that is its exact absolute Git worktree root with at least
one commit; and — because the Codex app-server socket is an unauthenticated
local control plane — the understanding that every local client on that machine
is inside the trust boundary.
