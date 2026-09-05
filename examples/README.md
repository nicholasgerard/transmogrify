# Minimal managed-lane lifecycle

The operator owns scope and lifecycle decisions. The child edits and commits
inside its assigned clone, then writes a local handback. `harvest` verifies the
commit and preserves the result before retirement. These commands illustrate
one lane; replace every placeholder before use.

## 1. Prepare and check the host

```bash
export SKILL_ROOT="$HOME/.agents/skills/transmogrify"
export REPO_ROOT=/absolute/path/to/repository
export WORKTREES="$HOME/.local/share/transmogrify/worktrees/example-repository"
install -d -m 700 "$WORKTREES"
git -C "$REPO_ROOT" rev-parse --verify HEAD

node "$SKILL_ROOT/scripts/doctor.js" \
  --repo-root "$REPO_ROOT" --target all --explain
```

Use an absolute repository root. An external `WORKTREES` directory must be
outside every Git worktree; an internal root must be Git-ignored. Use a unique
root for this repository. The doctor reads provider and local state, probes
Codex methods against the nil thread ID, and writes local compatibility
receipts. It never mutates a real provider session. Follow its measured setup
plan one authorized step at a time before spawning.

Claude public lifecycle support uses CLI `2.1.258` or newer with compatibility
evidence. Private archival separately requires the exact archive tuple.
Codex runtime selection uses an explicit `--url`, `TRANSMOGRIFY_URL`, the live
relay record, `TRANSMOGRIFY_PORT`, then the legacy default. These examples let
the shared selector choose the endpoint.

## 2. Create the parent and dispatch the packet

Set the actual host provider and app; a Claude Code terminal host uses
`claude` and `claude-code`. Pass the repository root so a Codex parent's thread
can be checked against its seat.

```bash
node "$SKILL_ROOT/scripts/lane.js" parent-init \
  --repo-root "$REPO_ROOT" \
  --host-provider codex --host-app codex-desktop \
  --name 'Example repository operator'

# Copy contextFile from the result.
export PARENT_CONTEXT=/absolute/path/to/parent-context.json
```

Customize [packet.md](packet.md) with the exact scope and acceptance command.
Save it as an absolute, owner-only regular file accessible to the operator,
then pass its content to spawn. Spawn writes the packet into the child's seat;
the child does not need to read or write the operator's external mailbox.

```bash
node "$SKILL_ROOT/scripts/lane.js" spawn \
  --repo-root "$REPO_ROOT" --worktrees "$WORKTREES" \
  --target codex --name 'example: packet execution' \
  --parent-context-file "$PARENT_CONTEXT" \
  --intent balanced --input-file /absolute/path/to/authorized-packet.md

# Copy laneId from the result; retain dispatchId with the operator's records.
export LANE_ID=FULL_LANE_ID
```

Omit `--cwd` for a managed clone. An explicitly supplied existing seat is
preserved at retirement. Codex requires a measured Desktop attachment for live
app visibility. Use `--allow-protocol-only` only when that limitation is
acceptable. For a Claude lane, change `--target codex` to `--target claude`.
Never infer ownership from the visible `::: ` title.

## 3. Wait, review, and acknowledge

```bash
node "$SKILL_ROOT/scripts/lane.js" wait \
  --repo-root "$REPO_ROOT" --parent-context-file "$PARENT_CONTEXT" \
  --until complete --timeout-ms 60000
```

Keep the parent active and repeat on normal timeout. The watcher can wake a
parent through its recorded channel; the durable events remain authoritative.
After handling each event, acknowledge its exact ID or the highest sequence
that has been handled:

```bash
node "$SKILL_ROOT/scripts/lane.js" ack \
  --parent-context-file "$PARENT_CONTEXT" --through HIGHEST_HANDLED_SEQUENCE
```

A timeout may contain no events. Never assume an `events[0]` exists.
Unacknowledged events redeliver after restart. Recover the same parent with
`parent-list`, inspect `children`, and run `wait --timeout-ms 0` before a new
dispatch. A completion event prompts review; it does not authorize deletion.

For a scope change, amend the packet first and record the directive in the
operator's [mailbox](mailbox.md). Send the exact authorized amendment text
through stdin and retain the returned acknowledgment in that mailbox. Inspect
`status` first: Codex `steer` requires `phase: executing`; `recover --input-file`
starts a boundary turn only at `phase: idle`. Other phases require inspection
or reconciliation. Claude `steer` queues during `executing`, `waiting`, or
`idle`; the pre-measured CLI cannot resume a stopped session in place.

If delivery is uncertain, reconcile the exact lane before any retry:

```bash
node "$SKILL_ROOT/scripts/lane.js" reconcile \
  --repo-root "$REPO_ROOT" --target codex --lane "$LANE_ID"
```

Use `--target claude` for Claude. Never replay a mutation whose delivery is
unknown.

## 4. Harvest and retire

The child uses [handback.md](handback.md) as a format example, replacing its
illustrative SHA with the actual commit. Review the reported checks, changes,
and Git status in the exact seat. The child must be affirmatively idle or
stopped before harvest; unreadable provider state is not proof of quiescence.

```bash
node "$SKILL_ROOT/scripts/lane.js" harvest \
  --repo-root "$REPO_ROOT" --lane "$LANE_ID"
```

Harvest parses the bounded handback, verifies its SHA against the seat HEAD,
fetches the clone commit into the operator repository under a fast-forward
check, and preserves an immutable durable handback. If the child could not
commit, it omits the SHA and explains why; the operator can run the same command
with `--commit` to commit the reviewed changes with provider attribution.

Harvest removes only matching recorded provisions and returns `retireCommand`
with its `handbackSha256`. Run that exact command. For Claude, add
`--private-archive` only when private archival is authorized for this run.
A hand-computed digest is not a substitute for the durable harvest receipt.

Retirement archives the exact provider row and removes an eligible managed
seat only when it was clean at harvest, remains clean and unchanged, and its
commit is preserved in the operator repository. Replaced provisions and extra
ignored output block cleanup. External seats remain. Claude local `rm` occurs
only after the guarded seat removal has made its path absent.

For a retryable local cleanup failure, rerun the exact retirement command.
For a blocked invariant, preserve the seat for operator review. Handle and
acknowledge the retirement event even when a matching parent context suppressed
its wake; command completion never proves delivery to the parent.
