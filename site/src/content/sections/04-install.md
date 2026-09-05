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
      Run this from the repository you want to work on. Check prerequisites
      before creating directories; stop with a visible error if repository-root
      resolution fails. Managed clone seats go in a private directory outside
      your checkout.
    code: |
      command -v git >/dev/null && command -v node >/dev/null && command -v npm >/dev/null || {
        printf '%s\n' 'Install Git, Node.js 20 or newer, and npm, then start again.' >&2
        exit 1
      }
      node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || {
        printf '%s\n' 'Upgrade to Node.js 20 or newer, then start again.' >&2
        exit 1
      }
      git rev-parse --verify HEAD >/dev/null || {
        printf '%s\n' 'Open a Git repository with at least one commit, then start again.' >&2
        exit 1
      }
      TRANSMOGRIFY_RESOLVED_REPO_ROOT="$(git rev-parse --show-toplevel)" && test -n "$TRANSMOGRIFY_RESOLVED_REPO_ROOT" || {
        printf '%s\n' 'The repository root could not be resolved. Fix Git, then start again.' >&2
        exit 1
      }
      export REPO_ROOT="$TRANSMOGRIFY_RESOLVED_REPO_ROOT"
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
      The default install covers both Codex and Claude Code personal skill
      directories and moves existing installs to timestamped backups. Keep
      the paths it prints.
    code: |
      export SKILL_ROOT="$HOME/.agents/skills/transmogrify"   # Claude Code host: $HOME/.claude/skills/transmogrify
  - title: Run the doctor before every session
    body: >-
      The doctor validates a Codex thread listing, probes methods against a
      nil thread ID, and runs a Claude preflight. It may create the registry
      and write local compatibility receipts. It never changes real provider
      sessions.
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
      Create one durable parent context, then pass the packet through stdin.
      Claude background spawn forwards its prompt as a positional argument,
      which may appear briefly in same-user process inspection. On macOS,
      `desktop-attach.js check` measures attachment before native dispatch.
      Connecting an unattached app requires guided setup from outside a Codex
      Desktop host. The result carries a `laneId` and a `dispatchId`;
      persist those exact handles and keep listening until the child returns.
    code: |
      export HOST_PROVIDER=codex       # or: claude
      export HOST_APP=codex-desktop    # or: claude-desktop
      PARENT_JSON=$(node "$SKILL_ROOT/scripts/lane.js" parent-init \
        --repo-root "$REPO_ROOT" \
        --host-provider "$HOST_PROVIDER" \
        --host-app "$HOST_APP" \
        --name 'Repository operator')
      export PARENT_CONTEXT=$(printf '%s' "$PARENT_JSON" | node -e \
        'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).contextFile)')
      node "$SKILL_ROOT/scripts/desktop-attach.js" check
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

**You need** macOS or Linux, Node.js 20 or newer, npm, Git, and a repository
that is a Git worktree root with at least one commit. Node.js 22.18 or newer
is needed only for site development. Codex lanes need a running
`codex app-server`. Claude lanes require Apple Silicon macOS and the Claude
Code CLI signed in to a `claude.ai` account.

Worth knowing first: the loopback Codex setup has no WebSocket authentication,
so any program running on that machine can reach it.
