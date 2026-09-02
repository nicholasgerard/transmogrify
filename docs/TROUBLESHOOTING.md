# Troubleshooting

Transmogrify fails closed when provider identity, runtime identity, ownership,
or a destructive cleanup precondition cannot be proved. For `lane.js` and
`doctor.js`, exit code 2 means a safe refusal or incomplete exact-owned
operation; exit code 3 means an uncertain or unexpected failure that requires
observation before any retry.

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

Add `--url` only to Codex commands when the runtime is not the default
`ws://127.0.0.1:8843`.

## Symptom index

| Symptom or code | Section |
| --- | --- |
| Install, upgrade, rollback, or uninstall | [Installation and upgrades](#installation-and-upgrades) |
| Refused `WORKTREES` root inside the repository | [Managed worktree is not ignored](#managed-worktree-is-not-ignored) |
| Ownership or mode refusal on state and seat paths | [Private state or worktree permissions](#private-state-or-worktree-permissions) |
| `boundary:sandbox-loopback-denied`, occupied or incompatible endpoint | [Codex runtime is unavailable or occupied](#codex-runtime-is-unavailable-or-occupied) |
| `NATIVE_VISIBILITY_REQUIRED`, `DESKTOP_RELAUNCH_REQUIRED`, `DESKTOP_HOST_SESSION`, `ATTACHED_ELSEWHERE`, `RUNTIME_UNAVAILABLE`, `ATTACH_TIMEOUT`, `DESKTOP_QUIT_TIMEOUT` | [Codex Desktop is not attached](#codex-desktop-is-not-attached) |
| `NO_ACTIVE_TURN`, unmarked or foreign native rows | [Codex lane and native row symptoms](#codex-lane-and-native-row-symptoms) |
| Mobile task fails after a Desktop restart | [Codex mobile Remote access](#codex-mobile-remote-access) |
| Claude CLI, account, Desktop, or Keychain refusal | [Claude compatibility or authentication problems](#claude-compatibility-or-authentication-problems) |
| `PARENT_EVENT_UNRECORDED`, `LOCAL_STATE_LIMIT`, `LOCAL_LOCK_TIMEOUT`, crash or timeout | [Pending or uncertain operation](#pending-or-uncertain-operation) |
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
the machine owner authorizes this Transmogrify installation to own the new
detached process. The launcher refuses non-loopback endpoints and never cleans
up a process it did not launch and identify exactly. A newly launched child runs
with `-c mcp_servers.codex_app={command="",enabled=false}` so the Desktop-only
`codex_app` MCP bridge stays off on the runtime this installation owns; a reused
listener keeps its own configuration.

Use `TRANSMOGRIFY_BIN` for an absolute Codex executable when it is not on
`PATH`, `TRANSMOGRIFY_URL` or `TRANSMOGRIFY_PORT` for the loopback endpoint, and
`TRANSMOGRIFY_LOG` for an absolute owned-runtime log path. A command-line
`--url` takes precedence over the URL environment variables.

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

| Code | Meaning | Repair |
| --- | --- | --- |
| `NATIVE_VISIBILITY_REQUIRED` | Codex spawn found no attachment receipt | Attach, or pass `--allow-protocol-only` for a deliberately unattached lane |
| `DESKTOP_RELAUNCH_REQUIRED` | Desktop is running unattached and the repair quits it | Run `ensure --relaunch-desktop` after the owner agrees, or set the standing `TRANSMOGRIFY_DESKTOP_RELAUNCH=auto` |
| `DESKTOP_HOST_SESSION` | The command runs inside a Desktop-hosted session, so the relaunch would end it | Attach from a session outside the app, or spawn Claude lanes and `--allow-protocol-only` Codex lanes |
| `ATTACHED_ELSEWHERE` | Desktop already streams another loopback Codex runtime | Point `TRANSMOGRIFY_URL` at the reported endpoint instead of competing with it |
| `RUNTIME_UNAVAILABLE` | Nothing listens on the selected endpoint yet | Reuse or start a runtime first |
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

OpenAI's CLI-exposed `app-server daemon`/`app-server proxy` surface remains the
candidate replacement for this mechanism. It is observed in local CLI help but
not documented in the official app-server reference, so it stays on the roadmap
until its launcher behavior, control socket, and safe multi-client semantics
pass a disposable live acceptance test. A private Desktop IPC or app-tools
socket is not an alternative.

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

An unsupported CLI build fails all Claude lifecycle mutations. An unsupported
Desktop build disables only private native archival. Install the current pinned
CLI with `claude install 2.1.258`; never weaken the version or hash checks to
make a new build pass.

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
stays pending after reconciliation, and its parent receives one
`child.needs-attention` event per journal state. Reconciliation never replays
the input. To abandon the lane, run its exact `retire` command with the harvest
digest of whatever output exists; retirement re-inspects the thread, refuses
while a turn is active, closes the spawn journal, and archives the empty
thread. A lane that never received its thread ID keeps its attention event and
its seat for owner review; no provider call can be replayed for it.

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

Review and harvest the preserved worktree manually. Do not edit the ownership
registry to make it appear eligible, and do not run `claude rm` against an
external or deferred seat: the pinned CLI may delete the session's worktree.
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
