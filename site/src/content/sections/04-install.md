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
      The one-line bootstrap installs the complete skill and tools into the
      selected host's personal skill location. An explicit dual-host install can
      populate both. Existing Transmogrify installs move to timestamped backups
      outside scanned skill directories. Keep the absolute root it reports.
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
        --target all
  - title: Reuse a runtime; provision only after authorization
    body: >-
      A compatible Codex listener may be reused for protocol control. Native app
      visibility is a separate current-launch check; a surviving runtime may no
      longer be attached after Desktop restarts. Start a runtime only when the
      machine's owner authorizes this installation to own it — never replace an
      occupied endpoint or another program's runtime. The safe command below
      only shows the launcher contract; run it without `--help` only after that
      explicit authorization.
    code: |
      "$SKILL_ROOT/scripts/runtime-up.sh" --help
  - title: Open the lane
    body: >-
      Create or recover one durable parent context, then pass prompt text
      through stdin so it never appears in the operator command's arguments.
      The result carries installation-scoped `laneId` and `dispatchId` values;
      persist those exact handles and keep listening until the child returns.
      The example explicitly creates a protocol-only Codex lane; it does not
      claim current Desktop/mobile attachment.
    code: |
      export HOST_PROVIDER=codex       # or: claude
      export HOST_APP=codex-desktop    # or: claude-desktop
      PARENT_JSON=$(node "$SKILL_ROOT/scripts/lane.js" parent-init \
        --host-provider "$HOST_PROVIDER" \
        --host-app "$HOST_APP" \
        --name 'Repository operator')
      export PARENT_CONTEXT=$(printf '%s' "$PARENT_JSON" | node -e \
        'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).contextFile)')
      printf '%s\n' 'Inspect the failing tests and report the smallest safe fix.' |
        node "$SKILL_ROOT/scripts/lane.js" spawn \
          --repo-root "$REPO_ROOT" \
          --worktrees "$WORKTREES" \
          --target codex \
          --name 'tests: diagnose failure' \
          --parent-context-file "$PARENT_CONTEXT" \
          --intent balanced \
          --allow-protocol-only \
          --input-file -
footnote: >-
  Every advertised tool accepts `--help`. Standalone Codex turns run with the
  fixed `workspace-write` sandbox and approval policy `never`; an action that
  needs approval returns to the host rather than quietly widening a lane's
  authority.
---

Before you begin, confirm the requirements: Git, Bash, `ps`, and `lsof`; a
target repository that is its exact absolute Git worktree root with at least
one commit; and — because Transmogrify's accepted root-path loopback Codex
configuration does not use WebSocket authentication — the understanding that
every local client on that machine is inside that configuration's trust
boundary.
