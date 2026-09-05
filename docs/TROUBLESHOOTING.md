# Troubleshooting

Transmogrify fails closed when provider identity, runtime identity, ownership,
or a destructive cleanup precondition cannot be proved. Every command shares
one exit table: 2 means a usage error or a safe refusal that attempted
nothing; 3 means a failure or an uncertain outcome after an attempt, which
requires observation before any retry; 1 is an unexpected internal error.

Set the installed skill root before running lifecycle commands. Use the Claude
path for a Claude-only installation.

```bash
export SKILL_ROOT="$HOME/.agents/skills/transmogrify"
# Claude-only alternative: $HOME/.claude/skills/transmogrify
```

Start with the command's `--help`, then run the read-only doctor for the target:

```bash
node "$SKILL_ROOT/scripts/doctor.js" --repo-root /absolute/path/to/repository --target codex
node "$SKILL_ROOT/scripts/doctor.js" --repo-root /absolute/path/to/repository --target claude
```

Codex commands select an explicit `--url`, then `TRANSMOGRIFY_URL`, then the
live managed-relay record, and only then the legacy `ws://127.0.0.1:8843`
endpoint. Add `--url` only to override that selection.

## Symptom index

| Symptom or code | Section |
| --- | --- |
| Install, upgrade, rollback, or uninstall | [Installation and upgrades](#installation-and-upgrades) |
| `consent-required`, `hosting-cli-protected`, `foreign-runtime`, `manual-action-required`, `step-not-verified` | [Guided setup stops](#guided-setup-stops) |
| Refused `WORKTREES` root inside the repository | [Managed worktree is not ignored](#managed-worktree-is-not-ignored) |
| Ownership or mode refusal on state and seat paths | [Private state or worktree permissions](#private-state-or-worktree-permissions) |
| `EPERM` on operator state, sockets, `ps`, or the Keychain inside a child lane | [Lane sandbox denials](#lane-sandbox-denials) |
| `boundary:sandbox-loopback-denied`, `runtime-unsupported`, occupied or incompatible endpoint | [Codex runtime is unavailable or occupied](#codex-runtime-is-unavailable-or-occupied) |
| `NATIVE_VISIBILITY_REQUIRED`, `DESKTOP_RELAUNCH_REQUIRED`, `DESKTOP_HOST_SESSION`, `ATTACHED_ELSEWHERE`, `RUNTIME_UNAVAILABLE`, `ATTACH_TIMEOUT`, `DESKTOP_QUIT_TIMEOUT` | [Codex Desktop is not attached](#codex-desktop-is-not-attached) |
| `NO_ACTIVE_TURN`, unmarked or foreign native rows | [Codex lane and native row symptoms](#codex-lane-and-native-row-symptoms) |
| `NOT_OWNED`, `RUNTIME_MISMATCH`, `OWNERSHIP_MISMATCH`, `SEAT_MISMATCH`, `EXECUTION_EPOCH_UNBOUND`, `ADAPTER_MISMATCH` | [Ownership or identity refused](#ownership-or-identity-refused) |
| `DELIVERY_UNCERTAIN` on a Claude steer | [Claude steer delivery is uncertain](#claude-steer-delivery-is-uncertain) |
| Mobile task fails after a Desktop restart | [Codex mobile Remote access](#codex-mobile-remote-access) |
| Claude CLI, account, Desktop, or Keychain refusal | [Claude compatibility or authentication problems](#claude-compatibility-or-authentication-problems) |
| `SPAWN_UNCERTAIN` with `causeCode` `TRANSCRIPT_RECEIPT_PENDING` or `REMOTE_CONTROL_UNAVAILABLE`, `spawnJobAbsent` | [Claude spawn did not verify](#claude-spawn-did-not-verify) |
| `FORKED_COPY`, `forkedCopyStopped`, `recoveryNotAchieved` | [Claude recovery forked or did not resume](#claude-recovery-forked-or-did-not-resume) |
| `TARGET_ACTIVE` during harvest | [Harvest is not quiescent](#harvest-is-not-quiescent) |
| `PENDING_OPERATION`, `PARENT_EVENT_UNRECORDED`, `LOCAL_STATE_LIMIT`, `LOCAL_LOCK_TIMEOUT`, `NO_PENDING_OPERATION`, `ABANDON_REFUSED`, crash or timeout | [Pending or uncertain operation](#pending-or-uncertain-operation) |
| `CLEANUP_RETRYABLE`, `CLEANUP_BLOCKED` | [Cleanup is blocked](#cleanup-is-blocked) |

## Installation and upgrades

`./install.sh --help` prints options without installing. `--dry-run` validates
source files, the bundled `ws` dependency, and destination ownership without
writing a skill target.

Every existing install ancestor must belong to the current user and must not be
group/world writable. If a selected target sits under a shared writable parent,
choose a private host-owned skills root; do not broadly `chmod` a shared
directory to satisfy the installer.

An occupied target is replaced only when it has Transmogrify's exact install
sentinel. Install a single host from the source checkout with:

```bash
./install.sh --target codex
./install.sh --target claude
```

The default install covers both hosts. Its final line tells you that Claude
Desktop and the ChatGPT app can load the skill, and a new session in the other
app picks it up. Inspect the remaining machine setup without changing it:

```bash
export SKILL_ROOT="$HOME/.agents/skills/transmogrify"
node "$SKILL_ROOT/scripts/doctor.js" \
  --repo-root /absolute/path/to/repository --target all --explain
```

For guided setup, run `setup.js --repo-root /absolute/path/to/repository`. A
TTY asks before each consented step. A non-interactive run needs only the
matching flag for the first step. Do not pre-authorize later steps.

### Guided setup stops

Start by rerunning the read-only explanation so the repair is based on the
current machine rather than the previous attempt:

```bash
node "$SKILL_ROOT/scripts/doctor.js" \
  --repo-root /absolute/path/to/repository --target all --explain
```

| Setup result | Meaning | Repair |
| --- | --- | --- |
| `consent-required` | The first needed step was not authorized. | Read its reason, ask one question, then rerun setup with only the matching consent flag. |
| `hosting-cli-protected` | Installation would replace the Claude or Codex CLI hosting this session. | Open the other host or a plain terminal and authorize that one install step there. |
| `foreign-runtime` | A compatible Codex runtime appeared, but this setup did not start it. | Rerun the doctor and explicitly reuse it; never adopt, replace, or restart it. |
| `manual-action-required` | The doctor found a safe repair outside setup's fixed allowlist. | Follow the exact doctor guidance or repair that provider directly, then rerun the doctor. |
| `step-not-verified` | The action returned, but the same need was still measured. | Repair the provider directly and start a fresh setup run; do not blindly repeat an install, sign-in, app relaunch, or runtime start. |

Setup reruns the doctor after every successful action. Report what was found,
ready, needed, and next in plain words, then handle only the new first step.

To upgrade, update a trusted source checkout, reinstall its exact dependency
lock, inspect the dry run, and install:

```bash
git pull --ff-only
npm ci --ignore-scripts
./install.sh --dry-run
./install.sh
```

Each successful replacement moves the prior target outside the scanned skill
directory. Claude backups live under `$HOME/.claude/transmogrify-backups/`;
Codex backups live under `$HOME/.agents/transmogrify-backups/`. Names begin with
`transmogrify.backup-`. The install is transactional across selected
destinations; a failed new copy is also preserved outside discovery as
`transmogrify.failed-…` for inspection.

For a manual rollback, stop if either path is unclear. Select one exact live
target and one exact backup for the same host, verify both contain `SKILL.md`
and `.transmogrify-install.json`, move the live target into that host's backup
directory under a new unique name, then move the chosen backup to the original
target path. Do not merge contents or place a second copy under `skills/`.
Open a new host session after the swap.

To uninstall from one host without deleting recovery material, first retire its
owned lanes. Then replace `YYYYMMDD-HHMMSS` below with a unique timestamp and
move the exact sentinel-authenticated installation outside the scanned
`skills/` directory:

Claude Code:

```bash
test -f "$HOME/.claude/skills/transmogrify/.transmogrify-install.json" && \
  mkdir -p "$HOME/.claude/transmogrify-backups" && \
  mv "$HOME/.claude/skills/transmogrify" \
    "$HOME/.claude/transmogrify-backups/transmogrify.disabled-YYYYMMDD-HHMMSS"
```

Codex:

```bash
test -f "$HOME/.agents/skills/transmogrify/.transmogrify-install.json" && \
  mkdir -p "$HOME/.agents/transmogrify-backups" && \
  mv "$HOME/.agents/skills/transmogrify" \
    "$HOME/.agents/transmogrify-backups/transmogrify.disabled-YYYYMMDD-HHMMSS"
```

Run only the block for the host being removed. This does not retire provider
lanes or remove Transmogrify state. The ownership registry remains under
`TRANSMOGRIFY_STATE_DIR` or
`${XDG_STATE_HOME:-$HOME/.local/state}/transmogrify`; preserve it for recovery
and audit. If `XDG_STATE_HOME` is set, it must be absolute; a relative value is
rejected for registry state and must not be used to construct a mailbox path.

## Managed worktree is not ignored

Transmogrify refuses an in-repository `WORKTREES` root unless Git ignores it.
Add the directory to the target repository's `.gitignore`, or configure an
absolute root outside every Git worktree. Verify an in-repository path with:

```bash
git -C /absolute/path/to/repository check-ignore --quiet --no-index -- \
  /absolute/path/to/repository/.worktrees/
```

The refusal prevents untracked worktree administration files from dirtying the
host checkout or an unrelated repository. Transmogrify does not edit another
repository's `.gitignore`.

## Private state or worktree permissions

State directories are mode `0700`, JSON state files are mode `0600`, and a
pre-existing managed `WORKTREES` root must be mode `0700`. Each path and its
nearest existing ancestor must belong to the current user; ancestors must not
be group/world writable.

For a known dedicated root, repair only that exact path:

```bash
chmod 700 /absolute/private/transmogrify-state
chmod 700 /absolute/private/transmogrify-worktrees
```

Do not apply this to a shared directory. Prefer a fresh private root when
ownership or purpose is unclear:

```bash
install -d -m 700 "$HOME/.local/share/transmogrify/worktrees/example-repository"
```

## Lane sandbox denials

A managed child lane has `workspace-write` access to its exact worktree and
`/tmp`. The private state root, Git common directory, loopback and Unix sockets,
process inspection such as `ps`, and the macOS Keychain remain outside that
boundary. `EPERM` from those resources inside a lane means the sandbox is
working as designed; it does not prove the resource is missing or unhealthy.

The child writes its packet response only to
`<seat>/.transmogrify/handback.md` and never commits. The operator runs
`lane.js harvest --commit` on the host, where private state, Git metadata, and
provider observation are available. Tests that require socket binding,
process inspection, Keychain access, or writes to the shared Git directory
must likewise run on the host. Do not widen a child's writable roots or infer a
provider outage from its sandbox denial.

## Codex runtime is unavailable or occupied

`boundary:sandbox-loopback-denied` means the operator's current execution
sandbox refused even a loopback client connection. The runtime may still be
healthy. Grant the doctor and exact provider-control commands a scoped host
execution authorization, or use a same-provider native control API only when it
supplies the full spawn, steer, status, interrupt, recover, retire, and
ownership contract. Re-run the doctor before declaring readiness.

If the doctor reports an occupied or incompatible endpoint, do not kill or
replace its process. Check the loopback listener and clients:

```bash
lsof -nP -iTCP:8843 -sTCP:LISTEN
lsof -nP -iTCP:8843 -sTCP:ESTABLISHED
```

Reuse a listener only after the initialize handshake succeeds. Run
`"$SKILL_ROOT/scripts/runtime-up.sh"` only when no compatible runtime exists and
the machine owner authorizes this Transmogrify installation to own a relay or
standalone fallback. A successful command prints JSON. `runtime:"managed-daemon"`
names the loopback relay in `url`, the daemon's `socket` and `daemonVersion`,
and `relayState`. `runtime:"standalone-fallback"` names the legacy endpoint and
`fallbackReason`.

The daemon must come from
`<CODEX_HOME>/packages/standalone/current/codex`; a `codex` elsewhere on `PATH`
is not used to manage it. A present daemon socket that cannot answer `daemon
version` is never started over. Resolve the permission or sandbox boundary and
retry. The command never bootstraps, stops, restarts, or reconfigures the
daemon.

The relay record is under the private Transmogrify state root. A stale record
is ignored. An occupied relay port is reused only when its TCP endpoint and the
daemon's Unix socket identify the same runtime and the listener's process birth
can be measured; otherwise the command refuses without signalling it. Use
`TRANSMOGRIFY_RELAY_PORT` to choose another deterministic loopback port.

When the daemon is unavailable, the standalone launcher refuses non-loopback
endpoints and never cleans up a process it did not launch and identify exactly.
A newly launched standalone child runs
with `-c mcp_servers.codex_app={command="",enabled=false}` so the Desktop-only
`codex_app` MCP bridge stays off on the runtime this installation owns; a reused
listener keeps its own configuration.

`runtime-unsupported` means either the app-server is older than `0.151.0` or
its first compatibility measurement rejected a required method or parameter
shape. The doctor names the first failed method. It probes `thread/list`,
`thread/turns/list`, `turn/steer`, `thread/name/set`, and `thread/archive`
against bounded reads or the nil thread ID, then caches the result once per
runtime version under the private state root. It also lists every executable
found on `PATH`, in Codex Desktop, and through `TRANSMOGRIFY_BIN`, with the
result of `--version`. A listed CLI is discovery evidence, not permission to
start it.

Use `TRANSMOGRIFY_BIN` for the standalone fallback executable,
`TRANSMOGRIFY_URL` or `TRANSMOGRIFY_PORT` for its loopback endpoint,
`TRANSMOGRIFY_RELAY_PORT` for the daemon relay, and `TRANSMOGRIFY_LOG` for the
standalone log path. A command-line `--url` takes precedence over the URL
environment variables. `TRANSMOGRIFY_DEBUG_STACK=1`
makes `lane.js` print the stack of an uncoded failure (`OPERATOR_ERROR`) to
stderr before its fixed public body, for maintainers. Two switches
turn off turnkey notification mechanisms for a run: `TRANSMOGRIFY_WATCH=off`
makes `spawn` skip starting the parent's watcher, and
`TRANSMOGRIFY_CHILD_HOOKS=off` launches Claude children without the session
hooks that nudge it ([docs/NOTIFICATIONS.md](NOTIFICATIONS.md)).

The detached child receives a bounded allowlist containing ordinary process,
locale, home, temp, and certificate-path settings. Ambient API keys, access
tokens, proxy credentials, `NODE_OPTIONS`, and unrelated secrets are excluded.
The launcher therefore expects an existing Codex login available under its
`HOME`/`CODEX_HOME`. An API-key-only or authenticated-proxy environment requires
a future explicit credential channel; never add the secret to the launcher log
or command line.

## Codex Desktop is not attached

An initialize handshake proves protocol compatibility, not native-app
attachment. Attachment is a separate measured receipt: on macOS,
`scripts/desktop-attach.js check` reports whether the Codex Desktop process
holds an ESTABLISHED loopback connection to the selected runtime, and
`doctor.js` turns that into `nativeVisibility.verified`. Desktop joins a runtime
only when it is launched with `CODEX_APP_SERVER_WS_URL` pointing at it; a normal
launch starts a private bundled app-server instead. If Desktop was restarted or
updated while an independent app-server survived, the two are different
processes even though the old endpoint still responds, and the doctor shows
`desktop-attachment:unattached`.

```bash
node "$SKILL_ROOT/scripts/desktop-attach.js" check
node "$SKILL_ROOT/scripts/desktop-attach.js" ensure
```

`check` is read-only and exits 0 only with a live attachment receipt. `ensure`
reuses an existing attachment as is, including one another operator set up;
launches Desktop attached when it is not running; and quits and relaunches a
running unattached Desktop only after the owner authorizes it. A relaunch ends
whatever the app's private runtime was doing, so ask first.

When the selected URL is the managed relay, the receipt includes both the
Desktop connection to the relay port and the live relay record's daemon socket.
`check` and the doctor use the same URL precedence as every Codex lifecycle
command, so an active relay on 8844 cannot be mistaken for the legacy endpoint
on 8843.

**Live-verified, 2026-09-04, Desktop 26.901.22334 (7746).** Launching Desktop
with `CODEX_APP_SERVER_WS_URL` pointed at a relay port that had no listener did
not produce an attachment, and bringing the relay up afterward did not turn
that launch into a verified attachment. A fresh launch with the relay already
listening attached normally. `ensure` therefore delegates to `runtime-up`
before it launches or, with owner approval, relaunches Desktop; it never starts
the daemon or relay by itself.

To keep Dock launches attached across logins and Desktop updates, inspect and
then authorize the reversible per-user setup:

```bash
node "$SKILL_ROOT/scripts/desktop-attach.js" persist --dry-run
node "$SKILL_ROOT/scripts/desktop-attach.js" persist --authorize
node "$SKILL_ROOT/scripts/desktop-attach.js" unpersist --dry-run
node "$SKILL_ROOT/scripts/desktop-attach.js" unpersist --authorize
```

`persist` sets `CODEX_APP_SERVER_WS_URL` in the login launch environment and
writes `~/Library/LaunchAgents/sh.transmogrify.attach.plist`. At login that job
uses `runtime-up` to ensure the daemon and relay first, then reapplies the
environment variable. `unpersist` removes only that marked LaunchAgent and
unsets the variable. Neither command relaunches Desktop; a running app keeps
its current runtime until the owner separately authorizes a relaunch.

| Code | Meaning | Repair |
| --- | --- | --- |
| `NATIVE_VISIBILITY_REQUIRED` | Codex spawn found no attachment receipt | Attach, or pass `--allow-protocol-only` for a deliberately unattached lane |
| `DESKTOP_RELAUNCH_REQUIRED` | Desktop is running unattached and the repair quits it | Run `ensure --relaunch-desktop` after the owner agrees, or set the standing `TRANSMOGRIFY_DESKTOP_RELAUNCH=auto` |
| `DESKTOP_HOST_SESSION` | The command runs inside a Desktop-hosted session, so the relaunch would end it | Attach from a session outside the app, or spawn Claude lanes and `--allow-protocol-only` Codex lanes |
| `ATTACHED_ELSEWHERE` | Desktop already streams another loopback Codex runtime | Point `TRANSMOGRIFY_URL` at the reported endpoint instead of competing with it |
| `RUNTIME_UNAVAILABLE` | `runtime-up` could not establish a listener on the selected endpoint | Repair the daemon, relay, or standalone runtime, then retry |
| `ATTACH_TIMEOUT` | Desktop launched but no connection appeared inside the wait window | Re-run `check`; raise `--timeout-ms` if the host is slow to start the app |
| `DESKTOP_QUIT_TIMEOUT` | Desktop did not exit after its own quit request | Finish or discard the app's open work, then retry |

`TRANSMOGRIFY_DESKTOP_ATTACH=off` reports the check as disabled without probing;
`ensure` then refuses with `ATTACH_DISABLED`. The app is located by bundle
identifier, `com.openai.codex` first and then `com.openai.chat`;
`TRANSMOGRIFY_DESKTOP_BUNDLE_ID` overrides that list for a differently packaged
build.

Never repair any of this by restarting a shared runtime or by adopting rows from
either process. Until the attachment receipt is verified, exact-owned recovery
and retirement on the recorded runtime remain available and a new Codex lane
needs `--allow-protocol-only`.

The app's own local-daemon switch is not a replacement on Desktop 26.901: the
app supplies config overrides that keep it unreachable. A `ws+unix://` attach
URL is not a Desktop path either; the app routes its non-loopback host through
the configured SOCKS path and fails to start. The owned loopback relay keeps
the Desktop transport local while the daemon remains on its Unix socket.

## Codex lane and native row symptoms

`steer` or `interrupt` returning `NO_ACTIVE_TURN` with exit code 2 means the
exact owned thread has no current turn. It is not evidence that the thread is
foreign, broken, or safe to delete. Inspect status and continue at an explicit
turn boundary.

A native row whose title lacks the `::: ` marker, or that shows a "controlled
from another app" banner with no live activity, was not created by this
installation's current runtime. Never rename, adopt, or replay it. Continue
harvesting and retiring only the exact registry-owned lanes through their
recorded runtime, and do not resume new Codex dispatches until a current-launch
visibility check passes.

## Codex mobile Remote access

Codex mobile Remote access is a Desktop-host integration, not an app-server
handshake guarantee. OpenAI's
[Remote connections documentation](https://learn.chatgpt.com/docs/remote-connections)
says setup begins in ChatGPT Desktop, the paired host supplies the execution
environment, and closing Desktop, sleep, or network loss suspends access until
the host returns. Keep Desktop awake and signed into the same account and
workspace, update both apps, and re-pair the phone when Remote is unavailable
for every task.

If a pre-restart exact-owned task remains visible on mobile but returns a server
error while a fresh disposable post-restart task works, do not keep pressing
Retry and do not restart or replace a shared app-server. This is the measured
host-integration reattachment seam, and native Desktop rehydration did not
repair the affected task. Continue only through a control channel whose exact
receipts still verify, preserve the lane and worktree, and follow
[the protocol boundary](PROTOCOL.md#mobile-and-remote-hosts). Do not archive or
replace the task until its output is harvested and the operator explicitly
chooses a successor-lane recovery.

## Claude compatibility or authentication problems

Claude mutations require the measured Apple Silicon macOS, CLI version, CLI
hash, first-party account, and config identity. Check the public setup with:

```bash
claude --version
claude auth status
claude agents --json --all
```

A CLI below `2.1.258` reports `cli-unsupported`; upgrade it through Claude's
own installer with `claude install`. A newer unknown build is probed once. If
one of its public JSON or argument-shape checks fails, the doctor reports
`cli-unmeasured-failed` and names the probe. It never recommends an older
version. An unsupported Desktop build disables only private native archival.

Transmogrify sets `DISABLE_UPDATES=1` only in the Claude subprocesses it owns,
as documented by Anthropic's
[environment-variable reference](https://code.claude.com/docs/en/env-vars).
It does not change user settings or the global Claude updater. Existing lanes
default to their recorded versioned executable. If a managed worker has already
restarted under another verified build, exact-lane `reconcile` may append a
runtime-transition receipt only after account, config, session, bridge, name,
cwd, process, executable, and socket identity all match. Unknown builds and
identity drift remain hard stops.

Private archive additionally requires `--private-archive`, the pinned Desktop
bundle receipt, the exact account/organization identity, and the existing
`Claude Code-credentials` Keychain item. Transmogrify never enrolls a device,
refreshes login, searches Keychain broadly, or falls back to another endpoint.
A 401, untrusted-device 403, or changed response shape requires manual provider
setup or a compatibility refresh, not a blind retry. If the exact stop was
already verified, the error receipt says so separately. An auth/trust failure
before archive dispatch leaves archive not attempted; the same failure after
POST dispatch is archive-unknown and requires observation, not replay.

## Ownership or identity refused

Every mutating command resolves an exact registry-owned lane, then proves the
live provider still matches its receipt. Each refusal exits 2 and mutates
nothing:

| Code | Meaning | Do |
| --- | --- | --- |
| `NOT_OWNED` | the id is not a complete lane id this installation owns; a prefix, a name, or a provider id is discovery evidence, never ownership | pass the full `laneId` from `children` or `parent-list`; never adopt by name |
| `ADAPTER_MISMATCH` | the lane belongs to the other provider, or the flag is provider-specific | use the operation and flags the lane's provider accepts |
| `RUNTIME_MISMATCH` | the Codex runtime endpoint, Codex home, or platform, or the Claude CLI path, digest, account, or config identity, differs from the lane's receipt | rerun the doctor; point `TRANSMOGRIFY_URL` or `CLAUDE_BIN` at the recorded runtime, or run `recover` against the new endpoint: when it serves the same Codex home on the same platform and the thread is readable there, the lane is moved to it (`runtimeRebound`); never mutate across runtimes |
| `OWNERSHIP_MISMATCH` | the provider reports a different cwd, session, or selector than the receipt | stop and report; the row is not this lane |
| `SEAT_MISMATCH`, `EXECUTION_EPOCH_UNBOUND` | the worktree or the live worker no longer matches the recorded identity | inspect the seat or session by hand; reconcile; retire if the lane is gone |

## Claude steer delivery is uncertain

`DELIVERY_UNCERTAIN` after a Claude `steer` means the public CLI accepted the
follow-up but the owned transcript still had not shown its marker after the
command retried verification for up to 20 s (`steerVerifyTimeoutMs`, polled
every `steerVerifyDelayMs`, both within the command deadline); the lane
moves to `deliveryUnknown`. Do not re-send.
Run `reconcile --target claude --lane <laneId>`: it verifies the transcript
and settles the journal as `steerDeliveredObserved`, restoring the lane
state, or keeps it open as `steerUnknown` for the next observation.

## Claude spawn did not verify

A Claude spawn returns `SPAWN_UNCERTAIN` when the session launched but one of
its receipts could not be verified. The refusal and the lane's journal carry
`causeCode` and `causeMessage`:

| Cause | Meaning | Repair |
| --- | --- | --- |
| `TRANSCRIPT_RECEIPT_PENDING` | The session had not written its first message inside the 30 s verification window | Run `reconcile --target claude --lane <laneId>`; it binds the lane from the durable receipt once the transcript has caught up |
| `REMOTE_CONTROL_UNAVAILABLE` | The worker never registered Remote Control, almost always because the Claude login broke at launch (`claude auth status` shows logged out, the session log shows `/rc failed`) | Restore the login with `claude auth login`; the lane cannot be bound. Stop and remove that exact session (`claude agents --all` lists it under the lane title), run `reconcile` so the lane settles as `spawnJobAbsent`, then `retire` it with a harvest digest to free its seat |
| `spawnJobAbsent` (reconcile outcome) | The dispatched job is absent from every census more than a minute after launch | Nothing to repair: the journal is closed, the parent receives `child.failed`, and `retire` frees the managed seat without any provider mutation |

Reconcile never replays a spawn. A lane whose job is still listed keeps its
journal open and repeats the cause and the owner action on every reconcile.

## Claude recovery forked or did not resume

`recover` on a stopped Claude lane runs `claude --resume <session> --bg`. On
the verified 2.1.258 CLI that command starts a new job with a new session id
and its own transcript instead of reviving the stopped one, so the adapter reports
`RECOVERY_UNCERTAIN` with `causeCode` `FORKED_COPY`: it stopped the copy its
own command created (never removed it, never adopted it), closed the journal
as `forkedCopyStopped`, and left the lane stopped with its original session.
Retire the lane with a harvest digest, or spawn a new lane; do not resume by
hand. A recovery whose dispatch window passes with no running session and no
copy settles on the next `reconcile` as `recoveryNotAchieved`, also leaving
the lane stopped. The stopped fork's local record can be removed with
`claude rm <job>` after review, and its Remote Control row archived in the
app.

## Harvest is not quiescent

`TARGET_ACTIVE` during harvest means it did not receive an affirmative provider
observation of `idle`, `stopped`, `completed`, or `retired`. It also covers an
absent or `unknown` observation; neither proves that the child has stopped
writing. Run the exact `lane.js status --lane <lane-id>` command named by the
refusal. Repair or reconcile provider observation before trying harvest again.
Do not infer quiescence from a cached lane state.

## Pending or uncertain operation

Provider mutations are journaled before dispatch. After a crash, timeout, or
transport loss, observe the exact owned lane:

```bash
node "$SKILL_ROOT/scripts/lane.js" reconcile \
  --repo-root /absolute/path/to/repository \
  --target codex \
  --lane LANE_ID
```

Use `--target claude` for Claude. Reconciliation may complete a proved receipt,
mark a proved non-delivery, or leave the operation uncertain. It does not replay
an unknown spawn, steer, stop, recovery, archive, or removal.

Claude retirement cleanup that already has a durable harvest receipt can be
continued explicitly with `--finish-retirements --private-archive`. Do not use
that flag for general reconciliation.

A Codex lane whose thread was created but whose first turn never receipted
stays pending, and its parent receives one `child.needs-attention` event per
journal state, until the `turn/start` dispatch is older than the spawn-absence
grace period (`spawnAbsenceGraceMs`, 60 s by default). Once that period has
passed with no turn in progress and no turn carrying the client's message
marker, reconciliation proves the input absent: it settles the spawn journal
`notDelivered` (`spawnInputAbsent`) and moves the lane to `failed`, still
without replaying the input or touching the thread. Either way, the exact
`retire` command with the harvest digest of whatever output exists
re-inspects the thread, refuses while a turn is active, closes any journal
still open, and archives the thread. A lane that never received its thread
ID is unaffected by the grace period: it keeps its attention event and its
seat for owner review, and no provider call can be replayed for it.

A Codex steer left unknown by a crash or transport failure is provable by
reconciliation as well: every steer carries its operation id as the
`clientUserMessageId`, so reconciliation searches the target turn's items for
that marker and settles the journal `complete` (`steerInputReceipt`) when it
is found, or `notDelivered` (`steerInputAbsent`) once that turn is no longer
in progress and the marker is absent. It stays open only while the target turn
is still active and unreceipted. The marker on `turn/steer` is schema-derived,
and its parameter shape is included in the runtime compatibility measurement.

When reconciliation leaves a spawn, steer, stop, recover, resume, or interrupt
journal open and the owner decides to stop waiting, `abandon` closes it:

```bash
node "$SKILL_ROOT/scripts/lane.js" abandon \
  --repo-root "$REPO_ROOT" --lane <laneId> --reason "<one line>"
```

The journal is closed as failed with the reason recorded and
`providerOutcome: unknown`. Nothing is inferred about the provider: the
request may still have landed, so observe the lane before steering it again.
A lane with no bound provider identity becomes `failed` and can be retired
to free its seat; a bound lane keeps its state. A pending retirement is
refused (`ABANDON_REFUSED`, exit 2) because retirement receipts record
provider effects; reconcile settles those. `NO_PENDING_OPERATION` (exit 2)
means there was nothing to close.

`PARENT_EVENT_UNRECORDED` with exit code 3 means the spawn itself is verified
and journaled, but the durable parent event could not be written, most often
because the parent's bounded event store is full (`LOCAL_STATE_LIMIT`). Do not
respawn: the lane is exact-owned and can be steered, observed, and retired by
its `laneId`. Create a fresh parent context for further dispatches.

`LOCAL_LOCK_TIMEOUT` with exit code 2 means another live Transmogrify process
holds the private state lock. Nothing was attempted; retry after it finishes.
A lock left by a process that no longer exists is reclaimed automatically.

## Cleanup is blocked

`CLEANUP_RETRYABLE` with exit code 2 means provider retirement is already
verified and only a local Git or filesystem cleanup step failed. Resolve the
local condition, then rerun the exact lane's `retire` command or exact-owned
reconciliation. The pending harvest and retirement receipt are reused; the
provider archive is not replayed.

`CLEANUP_BLOCKED` means provider retirement may be complete while the local seat
remains for review. Transmogrify preserves a managed worktree when it was dirty
at harvest, is dirty now, changed HEAD after harvest, no longer matches the
recorded filesystem identity, or is outside its managed root. Once dirt or a
changed HEAD is observed, automatic deletion remains permanently blocked.
Ignored files are included in the dirt census and remain preserved.

Provisioned paths are exempt only while their typed creation receipts still
match. A dependency symlink replaced by a directory, an exchange directory
with a different device or inode, or any unexpected name inside that directory
returns `UNSAFE_CLEANUP_STATE` and leaves the seat intact. Version 0.6.0 seats
store only provision names, so their entries are counted as dirt and are never
removed automatically. Remove those exact legacy provisions manually only
after review, then retry the guarded cleanup.

Review and harvest the preserved worktree manually. Do not edit the ownership
registry to make it appear eligible, and do not run `claude rm` against an
external or deferred seat: the Claude CLI may delete the session's worktree.
If the owner keeps the seat, stop and leave the refusal intact. If the owner
manually removes that exact managed seat, rerun only its exact retirement with
`--accept-manual-seat-removal`. The retry refuses any surviving filesystem
entry, including a dangling symlink, and verifies that Git no longer lists the
path and the preserved branch remains at the harvested HEAD. Fleet-wide
reconciliation cannot acknowledge a manual removal.

## Getting help

Use [GitHub Discussions](https://github.com/nicholasgerard/transmogrify/discussions)
for setup questions and [GitHub Issues](https://github.com/nicholasgerard/transmogrify/issues)
for reproducible defects. For private support, privacy, or conduct matters,
email [support@thebkapp.co](mailto:support@thebkapp.co), but do not send
credentials, private transcripts, or session identifiers in ordinary email.
Report sensitive security findings through the
[private vulnerability form](https://github.com/nicholasgerard/transmogrify/security/advisories/new),
not a public issue.
