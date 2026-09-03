---
order: 3
anchor: start
label: Get started
number: '03'
title: Get started
lede: >-
  The prompt at the top of this page runs all of this for you. The steps are
  written out so you can see what it did.
module: steps
steps:
  - title: Pin the repository and where seats live
    body: >-
      Run this from the repository you want to work on. Worktrees go in a
      private per-repository directory outside your checkout.
    code: |
      export REPO_ROOT="$(git rev-parse --show-toplevel)"
      export TRANSMOGRIFY_DATA_ROOT="$HOME/.local/share/transmogrify"
      install -d -m 700 "$TRANSMOGRIFY_DATA_ROOT"
      install -d -m 700 "$TRANSMOGRIFY_DATA_ROOT/worktrees"
      export TRANSMOGRIFY_REPO_KEY="$(node -e 'const { createHash } = require("node:crypto"); process.stdout.write(createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 16))' "$REPO_ROOT")"
      export WORKTREES="$TRANSMOGRIFY_DATA_ROOT/worktrees/$TRANSMOGRIFY_REPO_KEY"
      install -d -m 700 "$WORKTREES"
  - title: Hand your agent the start prompt
    body: >-
      The same line from the top of this page. It pins one exact published
      release commit, verifies it, shows you the install before running it, and
      refuses branch fallback.
    code: |
      Fetch https://transmogrify.sh/start and follow its instructions.
  - title: Note where the skill landed
    body: >-
      The bootstrap puts the skill and its tools in the host's personal skill
      directory and moves any existing install to a timestamped backup. Keep
      the path it prints.
    code: |
      export SKILL_ROOT="$HOME/.agents/skills/transmogrify"   # Claude Code host: $HOME/.claude/skills/transmogrify
  - title: Run the doctor before every session
    body: >-
      The doctor is read-only. It shakes hands with Codex, runs a Claude
      preflight, and prints what you own and what is still pending. It never
      starts, stops, steers, archives, or adopts anything.
    code: |
      node "$SKILL_ROOT/scripts/doctor.js" \
        --repo-root "$REPO_ROOT" \
        --target all
  - title: Reuse a runtime rather than starting one
    body: >-
      If a Codex listener is already running, Transmogrify uses it. Start a new
      one only if the machine's owner has said this install may own it, and
      never on top of a port another program is using. Drop the `--help` and the
      command below actually starts a runtime.
    code: |
      "$SKILL_ROOT/scripts/runtime-up.sh" --help
  - title: Open a lane
    body: >-
      Create one durable parent context, then pass the prompt through stdin so
      it never shows up in the command line. On macOS, `desktop-attach.js
      ensure` connects Codex Desktop to the runtime first, so the lane streams
      into the app. The result carries a `laneId` and a `dispatchId`;
      persist those exact handles and keep listening until the child returns.
    code: |
      export HOST_PROVIDER=codex       # or: claude
      export HOST_APP=codex-desktop    # or: claude-desktop
      PARENT_JSON=$(node "$SKILL_ROOT/scripts/lane.js" parent-init \
        --host-provider "$HOST_PROVIDER" \
        --host-app "$HOST_APP" \
        --name 'Repository operator')
      export PARENT_CONTEXT=$(printf '%s' "$PARENT_JSON" | node -e \
        'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).contextFile)')
      node "$SKILL_ROOT/scripts/desktop-attach.js" ensure
      printf '%s\n' 'Inspect the failing tests and report the smallest safe fix.' |
        node "$SKILL_ROOT/scripts/lane.js" spawn \
          --repo-root "$REPO_ROOT" \
          --worktrees "$WORKTREES" \
          --target codex \
          --name 'tests: diagnose failure' \
          --parent-context-file "$PARENT_CONTEXT" \
          --intent balanced \
          --input-file -
footnote: >-
  Every tool takes `--help`. A standalone Codex turn runs with the
  `workspace-write` sandbox and approval policy `never`, so anything that needs
  approval comes back to you instead of the lane granting itself more access.
---

**You need** macOS or Linux, Node 22.18 or newer, Git, and a repository that is
a Git worktree root with at least one commit. Codex lanes need a running
`codex app-server`. Claude lanes need the Claude Code CLI signed in to a
`claude.ai` account.

Worth knowing first: the loopback Codex setup has no WebSocket authentication,
so any program running on that machine can reach it.
