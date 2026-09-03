---
order: 3
anchor: start
label: Get started
number: '03'
title: Get started
lede: >-
  Paste the prompt at the top of this page into Claude Code or Codex and it runs
  all of this for you. The steps are here so you can check its work.
module: steps
steps:
  - title: Pin the repository and where seats live
    body: >-
      Run this from the repository you want to operate on. Managed worktrees go
      in a private per-repository directory that Transmogrify owns, outside your
      checkout.
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
      The same line shown at the top of this page. It names one exact published
      release commit, verifies that commit, shows you the install before it runs
      it, and refuses branch fallback.
    code: |
      Fetch https://transmogrify.sh/start and follow its instructions.
  - title: Note where the skill landed
    body: >-
      The bootstrap installs the skill and its tools into the host's personal
      skill directory, and moves any existing install to a timestamped backup.
      Keep the absolute path it prints.
    code: |
      export SKILL_ROOT="$HOME/.agents/skills/transmogrify"   # Claude Code host: $HOME/.claude/skills/transmogrify
  - title: Run the doctor before every session
    body: >-
      Read-only. It does a Codex handshake and a Claude preflight, then prints
      what you own and what is pending. It never starts, stops, steers,
      archives, or adopts anything.
    code: |
      node "$SKILL_ROOT/scripts/doctor.js" \
        --repo-root "$REPO_ROOT" \
        --target all
  - title: Reuse a runtime rather than starting one
    body: >-
      An existing Codex listener is reused. Start a new one only when the
      machine's owner says this install may own it — never replace an occupied
      endpoint or another program's runtime. Without `--help`, the command below
      does start one.
    code: |
      "$SKILL_ROOT/scripts/runtime-up.sh" --help
  - title: Open a lane
    body: >-
      Create one durable parent context, then pass the prompt through stdin so
      it never appears in the command line. On macOS, `desktop-attach.js ensure`
      makes Codex Desktop a client of the runtime first, so the lane streams
      live in the app. The result carries `laneId` and `dispatchId`;
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
  Every tool takes `--help`. A standalone Codex turn runs with the fixed
  `workspace-write` sandbox and approval policy `never`, so anything needing
  approval comes back to you instead of quietly widening the lane's authority.
---

**Before you start:** macOS or Linux, Node 22.18 or newer, Git, and a
repository that is a Git worktree root with at least one commit. Codex lanes
need a running `codex app-server`; Claude lanes need the Claude Code CLI signed
in to a `claude.ai` account.

One thing worth knowing: the loopback Codex configuration Transmogrify accepts
has no WebSocket authentication, so every local program on that machine is
inside its trust boundary.
