# Minimal managed-lane lifecycle

This example starts from the installed skill root and exercises one lane from
startup through durable handback and retirement. The operator host owns the
packet, mailbox, and handback files; the executor lane reads authority from the
packet and returns acknowledgments over its provider transport.

## 1. Prepare the host records

Set the stable host parameters. Replace the repository path and use a unique
mailbox directory for each lane.

```bash
set -euo pipefail

export SKILL_ROOT="$(pwd -P)"
export REPO_ROOT=/absolute/path/to/repository
export WORKTREES=/absolute/path/outside-the-repository/transmogrify-worktrees
export MAILBOX_DIR="$HOME/.local/state/transmogrify/mailboxes/example"
export RUNTIME_URL=ws://127.0.0.1:8843
export THREAD_NAME_FORMAT='::: <summary>'

test -f "$SKILL_ROOT/SKILL.md"
test "$(git -C "$REPO_ROOT" rev-parse --show-toplevel)" = "$REPO_ROOT"
git -C "$REPO_ROOT" rev-parse --verify HEAD
case "$WORKTREES/" in
  "$REPO_ROOT"/*)
    git -C "$REPO_ROOT" check-ignore --quiet --no-index -- "$WORKTREES/"
    ;;
esac

umask 077
mkdir -p "$MAILBOX_DIR"
test ! -e "$MAILBOX_DIR/packet.md"
test ! -e "$MAILBOX_DIR/mailbox.md"
test ! -e "$MAILBOX_DIR/handback.md"
cp examples/packet.md "$MAILBOX_DIR/packet.md"
cp examples/mailbox.md "$MAILBOX_DIR/mailbox.md"
cp examples/handback.md "$MAILBOX_DIR/handback.md"
```

The ignore check must pass before Transmogrify creates an in-repository managed
seat. Add `.worktrees/` to the target repository's `.gitignore`, or set
`WORKTREES` to an absolute directory outside every Git worktree. Replace every
placeholder in `packet.md`, including the exact mailbox and handback paths,
before spawning.

## 2. Run the read-only startup check

For a Codex lane:

```bash
node "$SKILL_ROOT/scripts/doctor.js" \
  --repo-root "$REPO_ROOT" \
  --target codex \
  --url "$RUNTIME_URL"
```

For a Claude Code lane on the pinned macOS compatibility tuple:

```bash
node "$SKILL_ROOT/scripts/doctor.js" \
  --repo-root "$REPO_ROOT" \
  --target claude
```

Doctor may create the installation's empty ownership registry. It does not
start, stop, steer, archive, remove, or adopt a provider session.

## 3. Create the parent context

Create one durable parent identity before dispatch. Use the actual host provider,
app surface, and visible parent task name; the private native task reference is
optional and is never copied into a child prompt.

```bash
PARENT_JSON=$(node "$SKILL_ROOT/scripts/lane.js" parent-init \
  --host-provider codex \
  --host-app codex-desktop \
  --name 'Example repository operator')
printf '%s\n' "$PARENT_JSON"
PARENT_CONTEXT=$(printf '%s' "$PARENT_JSON" | node -e \
  "const fs=require('node:fs');process.stdout.write(JSON.parse(fs.readFileSync(0,'utf8')).contextFile)")
test -f "$PARENT_CONTEXT"
```

After a restart, use `parent-list` to recover the same context instead of
creating a replacement. Run `children` and `wait --timeout-ms 0` before making
another dispatch so an older unacknowledged result cannot be forgotten.

## 4. Spawn and retain the lane ID

The following Codex example writes the public JSON receipt to the terminal and
extracts its installation-scoped `laneId` without exposing provider IDs:

```bash
KICKOFF="Read the authorized packet at $MAILBOX_DIR/packet.md. Work only in the assigned seat. Return directive acknowledgments and the final structured handback over this lane; the operator host persists them outside the repository."

SPAWN_JSON=$(
  printf '%s\n' "$KICKOFF" |
    node "$SKILL_ROOT/scripts/lane.js" spawn \
      --repo-root "$REPO_ROOT" \
      --worktrees "$WORKTREES" \
      --url "$RUNTIME_URL" \
      --target codex \
      --name 'example: packet execution' \
      --parent-context-file "$PARENT_CONTEXT" \
      --intent balanced \
      --input-file -
)
printf '%s\n' "$SPAWN_JSON"
LANE_ID=$(printf '%s' "$SPAWN_JSON" | node -e \
  "const fs=require('node:fs');process.stdout.write(JSON.parse(fs.readFileSync(0,'utf8')).laneId)")
test -n "$LANE_ID"
```

The Codex example records the measured Desktop attachment receipt; run
`desktop-attach.js ensure` first on macOS, or add `--allow-protocol-only` for
a deliberately unattached lane. For Claude, change the target and name, omit
the Codex-only `--url` option, and use the pinned Remote Control adapter:

```bash
SPAWN_JSON=$(
  printf '%s\n' "$KICKOFF" |
    node "$SKILL_ROOT/scripts/lane.js" spawn \
      --repo-root "$REPO_ROOT" \
      --worktrees "$WORKTREES" \
      --target claude \
      --name 'example: packet execution' \
      --parent-context-file "$PARENT_CONTEXT" \
      --intent balanced \
      --input-file -
)
printf '%s\n' "$SPAWN_JSON"
LANE_ID=$(printf '%s' "$SPAWN_JSON" | node -e \
  "const fs=require('node:fs');process.stdout.write(JSON.parse(fs.readFileSync(0,'utf8')).laneId)")
test -n "$LANE_ID"
```

Store `LANE_ID` and the returned `dispatchId` with the host packet and mailbox
record. Never recover ownership from a display name. The native title is
canonicalized to `::: example: packet execution`; the first provider message
starts with the safe dispatch provenance block before `KICKOFF`.

## 5. Listen, acknowledge, direct, and observe exact work

Spawn produces a durable `child.spawned` event. Handle it, acknowledge it by
exact event ID, and keep returning to this bounded loop while children remain:

```bash
EVENT_JSON=$(node "$SKILL_ROOT/scripts/lane.js" wait \
  --parent-context-file "$PARENT_CONTEXT" \
  --repo-root "$REPO_ROOT" \
  --timeout-ms 60000)
printf '%s\n' "$EVENT_JSON"
EVENT_ID=$(printf '%s' "$EVENT_JSON" | node -e \
  "const fs=require('node:fs'),j=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(j.events[0].eventId)")

# Acknowledge only after the parent handled this exact event.
node "$SKILL_ROOT/scripts/lane.js" ack \
  --parent-context-file "$PARENT_CONTEXT" \
  --event "$EVENT_ID"
```

Unacknowledged events are redelivered across timeout, compaction, and process
restart. An idle/completed event is a prompt to inspect and harvest the child;
it is not permission to archive or delete the lane.

The templates include packet amendment 1 and its matching `directive 001`.
After replacing their placeholders, send only the short directive reference.
First inspect status. This Codex example chooses active-turn steering or an
explicit boundary recovery from the measured Codex phase (Claude phases are
`working`, `waiting`, `idle`, `stopped`; see
[docs/DISPATCH.md](../docs/DISPATCH.md#status-phases)):

```bash
STATUS_JSON=$(node "$SKILL_ROOT/scripts/lane.js" status \
  --repo-root "$REPO_ROOT" \
  --lane "$LANE_ID")
printf '%s\n' "$STATUS_JSON"
PHASE=$(printf '%s' "$STATUS_JSON" | node -e \
  "const fs=require('node:fs');process.stdout.write(JSON.parse(fs.readFileSync(0,'utf8')).phase)")

if [ "$PHASE" = executing ]; then
  ACTION=steer
else
  ACTION=recover
fi

printf '%s\n' 'Read directive 001 from the durable mailbox and acknowledge it before applying it.' |
  node "$SKILL_ROOT/scripts/lane.js" "$ACTION" \
    --repo-root "$REPO_ROOT" \
    --lane "$LANE_ID" \
    --input-file -
```

For a Claude lane, `steer` queues to the session's next safe point whether it
is `working`, `waiting`, or `idle`. A stopped Claude lane is not resumed in
place on the pinned CLI: retire it and spawn a new lane.

The operator host appends the lane's exact acknowledgment and provider receipt
to `mailbox.md`. It does not grant new authority from chat text alone.

If the host exits during a mutation, observe before retrying:

```bash
node "$SKILL_ROOT/scripts/lane.js" reconcile \
  --repo-root "$REPO_ROOT" \
  --target codex \
  --lane "$LANE_ID" \
  --url "$RUNTIME_URL"
```

Use `--target claude` and omit `--url` for a Claude lane. Reconciliation never
blindly replays an operation whose delivery may have occurred.

## 6. Harvest, hash, and retire

Review the final lane output and committed repository state. Persist the exact
reviewed result in `handback.md`, replacing the template fields. Confirm the
managed seat was clean at harvest; a dirty or subsequently changed seat is
intentionally preserved for manual review.

```bash
HARVEST_SHA=$(node -e \
  "const fs=require('node:fs'),c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" \
  "$MAILBOX_DIR/handback.md")
test "${#HARVEST_SHA}" -eq 64
```

Wait for a Codex lane to become idle. If status still reports an active newest
turn and the work should stop, interrupt it. This guarded form preserves the
documented exit-2 refusal when the lane is already idle:

```bash
STATUS_JSON=$(node "$SKILL_ROOT/scripts/lane.js" status \
  --repo-root "$REPO_ROOT" \
  --lane "$LANE_ID" \
  --url "$RUNTIME_URL")
PHASE=$(printf '%s' "$STATUS_JSON" | node -e \
  "const fs=require('node:fs');process.stdout.write(JSON.parse(fs.readFileSync(0,'utf8')).phase)")

if [ "$PHASE" = executing ]; then
  node "$SKILL_ROOT/scripts/lane.js" interrupt \
    --repo-root "$REPO_ROOT" \
    --lane "$LANE_ID" \
    --url "$RUNTIME_URL"
fi
```

Once status reports idle, retire:

```bash
node "$SKILL_ROOT/scripts/lane.js" retire \
  --repo-root "$REPO_ROOT" \
  --lane "$LANE_ID" \
  --url "$RUNTIME_URL" \
  --harvested-output-sha256 "$HARVEST_SHA"
```

For Claude, retirement stops the exact session, then uses the explicitly
authorized pinned archive path:

```bash
node "$SKILL_ROOT/scripts/lane.js" retire \
  --repo-root "$REPO_ROOT" \
  --lane "$LANE_ID" \
  --private-archive \
  --harvested-output-sha256 "$HARVEST_SHA"
```

Successful managed-seat retirement archives the exact native row, removes only
the recorded clean worktree, and verifies cleanup. External seats are preserved.
If retirement stops after provider archive, finish the recorded operation with
exact-owned reconciliation rather than issuing a new retirement:

```bash
node "$SKILL_ROOT/scripts/lane.js" reconcile \
  --repo-root "$REPO_ROOT" \
  --target claude \
  --lane "$LANE_ID" \
  --finish-retirements \
  --private-archive
```

Finish the lifecycle by handling and acknowledging the durable retirement
event. Do this even after a parent restart; the same unacknowledged event will
be returned until its exact ID is acknowledged:

```bash
EVENT_JSON=$(node "$SKILL_ROOT/scripts/lane.js" wait \
  --parent-context-file "$PARENT_CONTEXT" \
  --repo-root "$REPO_ROOT" \
  --timeout-ms 60000)
printf '%s\n' "$EVENT_JSON"
EVENT_ID=$(printf '%s' "$EVENT_JSON" | node -e \
  "const fs=require('node:fs'),j=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(j.events[0].eventId)")
node "$SKILL_ROOT/scripts/lane.js" ack \
  --parent-context-file "$PARENT_CONTEXT" \
  --event "$EVENT_ID"
```

The templates are [packet.md](packet.md), [mailbox.md](mailbox.md), and
[handback.md](handback.md).
