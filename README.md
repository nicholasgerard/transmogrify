# Transmogrify

Transmogrify is an agent skill and a set of zero-framework Node tools for
operating worktree-seated Codex and Claude Code lanes. It gives either Codex or
Claude a provider-neutral lifecycle—spawn, steer, status, stop, recover,
durable output harvest, retire, and reconcile—and records each lane's
native-visibility state from a measured receipt: Claude lanes carry a Remote
Control receipt, and Codex lanes carry the Desktop attachment receipt whenever
Codex Desktop is a client of the shared runtime.

The transport is deliberately provider-specific:

- Codex lanes use one shared loopback `codex app-server` WebSocket runtime.
  OpenAI currently labels WebSocket transport experimental and unsupported for
  production.
- Claude lanes use public Claude Code background Remote Control sessions and
  `--cloud` follow-ups, exact transcript receipts, and a tightly pinned
  archival adapter.
- A same-provider orchestrator may use a native built-in task tool when that
  tool exposes the required identity, visibility, and retirement semantics.

All standalone lifecycle mutations are ownership-gated. The installation keeps
an exact lane registry and durable monotonic operation records outside the
target repository; existing operation details cannot be rewritten as phases
advance. It never adopts a lane by name and never reconciles or removes an
unowned session or worktree.

Transmogrify pins the exact Codex app-server method and shape contract it has
verified for this release, and Claude's archival endpoint remains a private,
version-pinned surface. Read [Security](SECURITY.md) before using Transmogrify
on sensitive work.

## Why “Transmogrify”?

To transmogrify is to change something completely, as if by magic. Think of
cucumbers becoming pickles: the result remains recognizable, but its form and
possibilities are transformed. The word has been in English since the
mid-17th century, although its origin remains uncertain
([Merriam-Webster](https://www.merriam-webster.com/dictionary/transmogrify),
[Etymonline](https://www.etymonline.com/word/transmogrify)).

The name fits the architecture: Transmogrify turns provider-specific native
agent mechanisms into one lifecycle without flattening them into a fake common
transport. Codex, Claude Code, and future desktop integrations can each keep
their native channel while exposing consistent ownership, visibility, steering,
recovery, retirement, and cleanup semantics.

## Support matrix

| Orchestrator | Codex target | Claude Code target |
| --- | --- | --- |
| Codex | Shared app-server protocol; live app visibility by measured Codex Desktop attachment receipt | Claude Code Remote Control adapter |
| Claude Code | Shared app-server protocol; live app visibility by measured Codex Desktop attachment receipt | Claude Code Remote Control adapter |

Provider-native host tools can accelerate bounded internal delegation or exact
waiting when they expose a suitable receipt. A Transmogrify-managed app-visible
lane still goes through `lane.js` so its provenance, execution profile,
lineage, events, retirement, and cleanup remain portable across hosts.

Codex lanes render and stream in Codex Desktop, and in the ChatGPT mobile app
through it, while the app is a client of the shared runtime. That attachment
is measured, never assumed: `scripts/desktop-attach.js` reports whether Codex
Desktop holds a live connection to the selected runtime and can launch or,
with owner authorization, relaunch the app attached; `spawn` records
`desktopAttached` lanes from that receipt and otherwise refuses unless
`--allow-protocol-only` labels a deliberately unattached lane. Claude lanes are
named local Claude Code Remote Control sessions with live-verified Desktop and
mobile visibility, mobile-originated input, and native archive behavior. The
verified builds and receipts are in the
[protocol contract](docs/PROTOCOL.md) and
[Claude Code integration](docs/CLAUDE-CODE.md).

## Requirements

- [Node.js](https://nodejs.org/en/download) 20 or newer with npm.
- Git, Bash, `ps`, and `lsof`. Confirm them with `node --version`,
  `npm --version`, `git --version`, and `lsof -v`.
- Codex CLI/app-server `0.151.x` for Codex targets, verified with `0.151.0`.
  Attached live visibility is verified with Codex Desktop `26.901.20858`
  (`7658`) and `26.825.51511` (`7377`), and mobile visibility with ChatGPT for
  iOS `1.2026.230` (`32543289983`). Install and sign in using the
  [official Codex CLI guide](https://learn.chatgpt.com/docs/codex/cli).
- Standalone Codex tools are CI-tested on macOS and Linux; Windows is not a
  supported host in this release.
- For Claude targets: Apple Silicon macOS and the pinned Claude Code CLI
  `2.1.258`, signed into a first-party `claude.ai` account. Native archive also
  requires the pinned Claude Desktop `1.40609.1` build. Native mobile behavior
  was verified with Claude for iOS `1.260828.1` (`33349478298`). Unmeasured CLI builds
  fail closed for lifecycle mutations; unmeasured Desktop builds disable only
  the private archive step. Install the pinned CLI with
  `claude install 2.1.258`, then run `claude auth login` and
  `claude auth status`; the commands are defined in Anthropic's
  [CLI reference](https://code.claude.com/docs/en/cli-usage).
- One operator runtime dependency: `ws`. The isolated static website package
  under `site/` has build-time dependencies and is not installed with the skill.
- The target repository must be its exact absolute Git worktree root and must
  contain at least one commit.

## Install

The recommended release path is the one-line, commit-pinned agent handoff:

```text
Fetch https://transmogrify.sh/start and follow its instructions.
```

CI generates `/start` from one exact published release commit. It refuses to
install when that pin is absent and never falls back to a branch or tag.

Contributors and evaluators can install the current source checkout explicitly:

```bash
git clone https://github.com/nicholasgerard/transmogrify.git
cd transmogrify
npm ci --ignore-scripts
./install.sh --dry-run
./install.sh
```

By default the installer copies the complete skill and tools to both
`~/.claude/skills/transmogrify` and
`~/.agents/skills/transmogrify`, Codex's documented personal skill location
([official OpenAI documentation](https://learn.chatgpt.com/docs/build-skills)). Existing installations are
moved to timestamped backups outside scanned skill directories. An occupied
target without Transmogrify's install sentinel is refused. Use `--target codex` or
`--target claude` for a single host and `./install.sh --help` for all installer
options. Existing install ancestors must belong to the current user and must
not be group/world writable; the installer refuses unsafe parents before
staging or replacing a target.

The supported distribution path is a Git checkout followed by `npm ci` and
`install.sh`. The package is not published to npm; `npm pack --dry-run` is an
inclusion audit, not a self-installing distribution artifact.

Open a new host session after first installation, then invoke the skill by its
stable command:

```text
Codex:       $transmogrify operate this repository
Claude Code: /transmogrify operate this repository
```

The stable host parameters are documented in
[SKILL.md](SKILL.md#host-parameters). Upgrade, rollback, and removal procedures
are in [Troubleshooting](docs/TROUBLESHOOTING.md#installation-and-upgrades).

## Startup

The remaining manual commands run from an installed skill. Set its absolute
root once; a Claude-only installation can use
`$HOME/.claude/skills/transmogrify` instead.

```bash
export SKILL_ROOT="$HOME/.agents/skills/transmogrify"
```

Run the doctor before every operator session:

```bash
node "$SKILL_ROOT/scripts/doctor.js" \
  --repo-root /absolute/path/to/repository \
  --target codex
```

The doctor is read-only with respect to both providers. It creates or validates
the installation-owned registry and, for each requested target, performs an
initialize-only Codex handshake or Claude public preflight and agent listing.
It prints aggregate owned and pending counts. It never starts, stops, restarts,
steers, archives, removes, or adopts a provider session.

For Codex, `ok:true` means the selected WebSocket runtime matches the pinned
protocol contract. `nativeVisibility` is a separate measured receipt:
`verified:true` when Codex Desktop holds an established loopback connection to
that runtime, with the client pid, the connection, the app version, and
whether that build is on the tested list; otherwise the Desktop state that was
observed and the next action, normally `desktop-attach.js ensure`. After a
Desktop restart or update, rerun the doctor: a surviving independent runtime
shows as unattached until Desktop is relaunched against it, while exact-owned
recovery and retirement on that runtime remain available.

The doctor also prints `setup.ownerActions`: every precondition only the owner
can satisfy, each with the exact command and a `blocking` flag. A blocking
action (a logged-out or unpinned Claude CLI, a Codex runtime that needs
authorization) stops lanes on that provider until it is done; an advisory one
(Codex Desktop not attached) only withholds native visibility, so Codex lanes
remain available protocol-only. `setup.ready` is true when nothing blocks.

The registry is private local control state. Transmogrify creates its
directories with mode `0700` and JSON records with mode `0600`; existing state
paths must retain those owner-only permissions.

Use `--target all` to preflight both providers on the pinned macOS Claude
host, or `--target claude` when only the Claude surface is needed. A
Codex-only Linux host should keep `--target codex`.

If a verified Codex runtime is already listening, reuse it. If none exists,
`scripts/runtime-up.sh` can create a detached loopback runtime only when the
machine owner authorizes this installation to own that runtime:

```bash
"$SKILL_ROOT/scripts/runtime-up.sh"
```

The launcher accepts loopback listeners only, refuses an occupied endpoint
that does not complete the Codex initialize handshake, reuses a compatible
listener without touching it, and verifies the exact identity of any child it
launches or cleans up. The child runs with
`-c mcp_servers.codex_app={command="",enabled=false}` so the Desktop-only
`codex_app` bridge stays off on a shared runtime, and it inherits only a
bounded non-secret environment (`HOME`, `CODEX_HOME`, and the like), relying on
the existing file-backed Codex login. Never use the launcher to replace or
reconfigure a runtime owned by another program.

Codex Desktop adopts that runtime when the app is launched with
`CODEX_APP_SERVER_WS_URL` set to the endpoint, and
`scripts/desktop-attach.js ensure` does that for you: it reuses an existing
attachment, including one another operator set up, launches Desktop attached
when it is not running, and quits and relaunches a running unattached Desktop
only after the owner agrees (`--relaunch-desktop` for one run, or the standing
`TRANSMOGRIFY_DESKTOP_RELAUNCH=auto`). It never relaunches from a session
hosted inside the app and never touches the runtime. The variable is an
observed launcher behavior on the tested Desktop builds, not a documented
OpenAI contract; because the receipt is measured on every check and every
spawn, a build that ignores it fails closed. OpenAI's Desktop-owned SSH
daemon/proxy surface is the roadmap candidate to replace this mechanism.

## Quick start

Every command is independently runnable. Use an absolute repository root and
pass prompt text to the operator through stdin so it does not appear in the
operator command's arguments. The Claude CLI currently requires the initial
background-session prompt as its documented positional argument; see the local
process-list boundary in [Security](SECURITY.md#input-and-output-handling).

```bash
export REPO_ROOT=/absolute/path/to/repository
export WORKTREES="$HOME/.local/share/transmogrify/worktrees/example-repository"
export HOST_PROVIDER=codex       # or: claude
export HOST_APP=codex-desktop    # or: claude-desktop
install -d -m 700 "$WORKTREES"
git -C "$REPO_ROOT" rev-parse --show-toplevel
git -C "$REPO_ROOT" rev-parse --verify HEAD

node "$SKILL_ROOT/scripts/lane.js" parent-init \
  --host-provider "$HOST_PROVIDER" \
  --host-app "$HOST_APP" \
  --name 'Repository operator'

# Copy contextFile from the command result.
export PARENT_CONTEXT=/absolute/path/to/parent-context.json

printf '%s\n' 'Inspect the failing tests and report the smallest safe fix.' |
  node "$SKILL_ROOT/scripts/lane.js" spawn \
    --repo-root "$REPO_ROOT" \
    --worktrees "$WORKTREES" \
    --target codex \
    --name 'tests: diagnose failure' \
    --parent-context-file "$PARENT_CONTEXT" \
    --intent balanced \
    --input-file -
```

Spawn measures the Desktop attachment first and records the lane
`desktopAttached` with that receipt. Without it, spawn refuses and names the
Desktop state it saw; `--allow-protocol-only` is the explicit admission that
this particular lane may run without a native-app receipt. Do not use it when
the requested outcome requires Desktop/mobile visibility; run
`desktop-attach.js ensure` instead. Claude Code spawn does not use this flag;
its pinned Remote Control adapter carries the native visibility receipt.

Use `--target claude` for a named Claude Code Remote Control lane. Omit
`--cwd` to get a managed worktree under `WORKTREES`, or pass an absolute
`--cwd` to use an existing Git worktree inside that root, which is then
preserved at retirement. The root rules (Git-ignored when inside the
repository, outside every other worktree when external, owned by you with mode
`0700`) are in [SKILL.md](SKILL.md#host-parameters).

Both adapters accept a provider-neutral `--intent` plus explicit `--model`,
`--effort`, and `--speed standard|fast` overrides; Fast is always explicit, and
Claude's `--effort ultracode` selects its typed Ultracode setting. Inspect the
live matrix with `lane.js capabilities --target codex|claude`; the contract and
recommendations are in [Execution profiles](docs/EXECUTION-PROFILES.md).

The first message is automatically prefixed with safe dispatch provenance, and
the native title is canonicalized to `::: <summary>`. Keep the parent active
until its children return:

```bash
node "$SKILL_ROOT/scripts/lane.js" wait \
  --parent-context-file "$PARENT_CONTEXT" \
  --repo-root "$REPO_ROOT" \
  --timeout-ms 60000

node "$SKILL_ROOT/scripts/lane.js" ack \
  --parent-context-file "$PARENT_CONTEXT" \
  --event EVENT_ID
```

Repeat the bounded wait while children remain. Events persist across restart
and redeliver until acknowledged after handling. Completion wakes the parent;
it never authorizes automatic output injection, archival, or cleanup. See
[Dispatch and parent notification](docs/DISPATCH.md).

The result contains an installation-scoped `laneId`. Use that identifier for
every later operation:

```bash
printf '%s\n' 'Prioritize the regression test before refactoring.' |
  node "$SKILL_ROOT/scripts/lane.js" steer \
    --repo-root /absolute/path/to/repository \
    --lane LANE_ID \
    --input-file -

node "$SKILL_ROOT/scripts/lane.js" status \
  --repo-root /absolute/path/to/repository \
  --lane LANE_ID
```

Harvest is a workflow phase, not a provider-generic transcript command.
Require the child to write a bounded `handback.md` or another project-defined
artifact in its owned worktree. The parent reads that exact seat, reviews the
Git diff and status, persists the needed result outside fragile chat history,
and hashes the accepted artifact or handback. Pass that lowercase SHA-256 to
`retire`. A provider-native task read can accelerate review, but it is not the
portable harvest contract and never substitutes for repository evidence.

Standalone Codex lanes use the fixed `workspace-write` sandbox and approval
policy `never`; approval-required actions return to the host rather than
escalating. See the [protocol contract](docs/PROTOCOL.md#codex-lane-lifecycle).

Retirement requires a SHA-256 receipt for output that has already been durably
harvested. For Claude, remote archival is explicitly gated because its current
adapter uses a pinned private API:

```bash
node "$SKILL_ROOT/scripts/lane.js" retire \
  --repo-root /absolute/path/to/repository \
  --lane LANE_ID \
  --harvested-output-sha256 LOWERCASE_SHA256

node "$SKILL_ROOT/scripts/lane.js" retire \
  --repo-root /absolute/path/to/repository \
  --lane CLAUDE_LANE_ID \
  --private-archive \
  --harvested-output-sha256 LOWERCASE_SHA256
```

Retirement is ordered and provider-safe: the managed worktree must be clean at
harvest and unchanged at cleanup, any tracked, untracked, or ignored file
counts as dirt, and observed dirt or a changed HEAD permanently blocks
automatic cleanup and preserves the seat. Because `claude rm` can delete a
background session and its worktree, the Claude adapter runs it only after its
own guarded seat removal has made the path absent. A transient local failure
after verified provider retirement returns `CLEANUP_RETRYABLE` (exit 2);
`CLEANUP_BLOCKED` marks an unsafe invariant. The full ordering is in
[SKILL.md](SKILL.md#8-harvest-retirement-and-cleanup), the Claude receipts in
[docs/CLAUDE-CODE.md](docs/CLAUDE-CODE.md#retirement-and-archive-boundary), and
a complete packet, handback, digest, and retirement walkthrough in
[Examples](examples/README.md).

## Tool reference

| Tool | Purpose |
| --- | --- |
| `scripts/doctor.js` | Read-only startup discovery and aggregate ownership check |
| `scripts/lane.js` | Provider-neutral spawn, steer, status, interrupt/stop, recover, retire, and reconcile |
| `scripts/runtime-up.sh` | Reuse or explicitly launch a detached Codex app-server |
| `scripts/desktop-attach.js` | Measure, launch, or (with owner authorization) relaunch Codex Desktop as a client of the shared runtime |
| `scripts/lane-status-listen.js` | Listen for state transitions on exact owned Codex lanes |
| `scripts/steer.js` | Compatibility CLI for exact owned Codex steering, resume, and interrupt |
| `scripts/rpc.js` | Default-deny, read-only Codex diagnostics |

`lane.js` accepts these operations:

| Operation | Targets | Notes |
| --- | --- | --- |
| `parent-init` / `parent-list` | Host | Create or recover durable parent identity without exposing private native references |
| `capabilities` | Codex, Claude | Show the verified model, effort, speed, execution-setting, and recommendation catalog |
| `spawn` | Codex, Claude | Requires a parent context, target, name, and input; adds `::: ` and first-message provenance. Codex records the Desktop attachment receipt, or needs `--allow-protocol-only` for a deliberately unattached lane. |
| `children` | Host | Enumerate one parent's durable dispatches and unacknowledged event count |
| `wait` / `ack` | Host | Observe durable at-least-once child events and acknowledge them after handling |
| `steer` | Codex, Claude | Codex steers the newest active turn; Claude queues to the exact session safe point |
| `status` | Codex, Claude | Reads and revalidates exact owned identity |
| `interrupt` | Codex | Cancels only the newest exact active turn |
| `stop` | Claude | Stops the whole exact background session |
| `recover` | Codex, Claude | Codex observes/reconciles by default or resumes the same thread with input; Claude resumes the same recorded session |
| `retire` | Codex, Claude | Requires a harvest digest; Claude also requires `--private-archive` and defers local removal unless a managed seat is safely removed first; a manually removed blocked seat requires exact-lane `--accept-manual-seat-removal` |
| `reconcile` | Codex, Claude | Repairs exact-owned pending state and eligible cleanup; never name-adopts or replays an unknown mutation |

Every advertised tool accepts `--help`; use
`"$SKILL_ROOT/scripts/runtime-up.sh" --help` for the shell launcher and
`node "$SKILL_ROOT/scripts/<tool>.js" --help` for Node tools.
`--finish-retirements` applies only to Claude reconciliation and still requires
the recorded harvest and explicit private archive gates. Use `--input-file -`
for substantial steer and Codex recovery input.

`CLEANUP_BLOCKED` never clears through fleet-wide reconciliation. Preserve the
seat and stop, or review and remove that exact managed seat manually; only then
rerun its exact `retire` command with `--accept-manual-seat-removal`. The retry
proves the path is absent, Git no longer lists it, and the preserved branch is
still at the harvested HEAD before the retirement journal closes; for Claude,
local record removal then continues.

## Documentation

- [SKILL.md](SKILL.md): executable operator policy loaded by Codex or Claude.
- [Protocol contract](docs/PROTOCOL.md): Codex schemas, lifecycle semantics,
  failure classes, and dated receipts.
- [Claude Code integration](docs/CLAUDE-CODE.md): public surface, measured local
  control path, pinned archival boundary, and acceptance status.
- [Execution profiles](docs/EXECUTION-PROFILES.md): model, effort, speed,
  execution-setting, recommendation, receipt, and recovery contract.
- [Dispatch and parent notification](docs/DISPATCH.md): lineage, visible
  provenance, durable child events, waiting, acknowledgement, and restart.
- [Troubleshooting](docs/TROUBLESHOOTING.md): setup failures, runtime safety,
  upgrade/rollback, and cleanup recovery.
- [Roadmap](ROADMAP.md): launch gate and forward priorities.
- [Examples](examples/README.md): runnable packet, mailbox, handback, and
  retirement lifecycle.
- [Contributing](CONTRIBUTING.md): development, receipt, review, and release
  requirements.
- [Code of Conduct](CODE_OF_CONDUCT.md): community standards and private
  enforcement contact.
- [Website](https://github.com/nicholasgerard/transmogrify/blob/main/site/README.md):
  Astro source, static verification, privacy posture, and the Cloudflare
  deployment contract for `transmogrify.sh`.

## Support

Use [GitHub Discussions](https://github.com/nicholasgerard/transmogrify/discussions)
for setup and usage questions, and
[GitHub Issues](https://github.com/nicholasgerard/transmogrify/issues) for
reproducible defects. For private support, privacy, or conduct matters, email
[support@thebkapp.co](mailto:support@thebkapp.co). Report security
vulnerabilities through the private route in [SECURITY.md](SECURITY.md); never
send credentials, private transcripts, session identifiers, or exploit details
to a public channel.

## Security model

Transmogrify accepts only a root-path loopback WebSocket endpoint and does not
configure app-server authentication for that local mode. Treat that accepted
configuration as a local control plane. Bind it
only to loopback and trust every local client before connecting sensitive work.
The Claude lifecycle adapter refuses an unknown CLI build, account, session,
worker, or execution identity. Its optional native-archive step additionally
pins the Desktop build and private response shape, reads one narrowly named
macOS Keychain item only during explicitly authorized retirement, and never
prints the credential. Full details are in [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
