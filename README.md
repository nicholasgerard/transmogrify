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

On the recorded compatibility tuple, both orchestrators created Codex lanes
that rendered in Codex Desktop and the ChatGPT mobile app. A later Desktop
restart demonstrated that a surviving standalone runtime can remain
protocol-compatible without remaining the app's live control plane, so
attachment is measured rather than assumed: `scripts/desktop-attach.js`
reports whether Codex Desktop holds a live connection to the selected runtime,
launches or (with owner authorization) relaunches the app attached, and
`spawn` records `desktopAttached` lanes from that receipt. Without it a Codex
lane is recorded protocol-only, and only with `--allow-protocol-only`. The
dated visibility and topology receipts are recorded in the
[protocol contract](docs/PROTOCOL.md#codex-lane-lifecycle). The Claude adapter
creates named local Claude Code Remote Control sessions. Desktop and mobile
visibility, mobile-originated input, and native archive behavior are
live-verified on the dated client and host tuple. See
[Claude Code integration](docs/CLAUDE-CODE.md).

## Requirements

- [Node.js](https://nodejs.org/en/download) 20 or newer with npm.
- Git, Bash, `ps`, and `lsof`. Confirm them with `node --version`,
  `npm --version`, `git --version`, and `lsof -v`.
- Codex CLI/app-server `0.151.x` for Codex targets, live-verified with `0.151.0`
  on 2026-09-01. Native surfaces were verified on 2026-09-02 with Codex Desktop
  `26.825.51511` (`7377`), the Codex surface of the ChatGPT desktop app, and
  ChatGPT for iOS `1.2026.230` (`32543289983`). Install and sign in using the
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

The launcher accepts loopback listeners only, refuses an occupied endpoint that
does not complete the Codex initialize handshake, and captures and verifies
exact process identity while launching or cleaning up its own child. A
concurrent compatible listener is reused without killing it. Never use the
launcher to replace or reconfigure a
shared runtime owned by another program. A newly launched child also runs with
`-c mcp_servers.codex_app={command="",enabled=false}`, which disables the
Desktop-only `codex_app` MCP bridge on the runtime this installation owns; a
reused listener is never reconfigured.

The standalone launcher inherits only a bounded non-secret environment,
including `HOME` and `CODEX_HOME`; it deliberately excludes ambient API keys,
access tokens, proxy credentials, and `NODE_OPTIONS`. Use an existing Codex
login stored under the selected home. On 2026-09-01, Codex CLI `0.151.0`
reported `Logged in using ChatGPT` with only `HOME` and `PATH` present. An
environment-only API-key login is outside the 0.2.x launcher contract.

The launcher establishes only the standalone app-server contract. Codex
Desktop adopts that runtime when it is launched with `CODEX_APP_SERVER_WS_URL`
set to the endpoint, and `scripts/desktop-attach.js ensure` does that for you:
it reuses an existing attachment, including one another operator set up,
launches Desktop attached when it is not running, and quits and relaunches a
running unattached Desktop only after the owner agrees (`--relaunch-desktop`
for one run, or the standing `TRANSMOGRIFY_DESKTOP_RELAUNCH=auto`). It never
relaunches from a session hosted inside the app, and it never touches the
runtime. The variable is an observed launcher behavior on the tested Desktop
builds (`26.825.51511` and `26.901.20858`), not a documented OpenAI contract;
the receipt is measured on every check and every spawn, so a build that
ignores it fails closed. See the
[protocol receipts](docs/PROTOCOL.md#codex-lane-lifecycle).

OpenAI separately documents Desktop-owned SSH projects that launch and manage
an app-server on the remote host. Transmogrify will move native Desktop/mobile
operation to that ownership direction only after the CLI-exposed,
local-help-observed daemon/proxy path and safe second-client behavior pass the
roadmap's live acceptance gate, and only if bootstrap stays turnkey.

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

Use `--target claude` to create a named Claude Code Remote Control lane. Omit
`--cwd` to let the operator reserve and create a managed worktree under
`WORKTREES`; pass an absolute `--cwd` to use an existing seat that the operator
must preserve. An existing seat must be a Git worktree inside the configured
`WORKTREES` root; set `--worktrees` or the `WORKTREES` environment variable to
its parent when it is outside the default `<repo>/.worktrees` tree.
If `WORKTREES` is inside the repository, Git must ignore that directory;
Transmogrify checks this and refuses to create a seat when it is not ignored.
An external root must be outside every Git worktree, not nested in an unrelated
repository or an existing linked worktree.
For managed-seat creation, the exact `WORKTREES` root must be owned by the
current user with mode `0700`, and its nearest existing ancestor must not be
group/world writable. Choose a new private root instead of changing permissions
on a shared directory.

Both adapters accept provider-neutral `--intent`, plus explicit `--model`,
`--effort`, and `--speed standard|fast` overrides. Fast is always explicit.
Claude additionally accepts `--effort ultracode` as native shorthand for its
typed Ultracode execution setting: resolved `xhigh` effort plus a request for
dynamic-workflow planning on supported models. When workflows are unavailable
for the current plan or configuration, Anthropic documents an `xhigh`-only
fallback.
Claude aliases such as `opus` are retained as requested input but compile to a
versioned selector for spawn and recovery. Inspect the current matrix with
`lane.js capabilities --target codex|claude`; the complete contract and model
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

Retirement is provider-safe and ordered. A managed worktree must be clean at
harvest and still clean and unchanged at cleanup. Because Claude documents
`claude rm` as deleting a background session and its worktree, the adapter may
run it only after its own guarded managed-seat removal has made the path absent;
external and deferred seats leave local removal explicitly deferred. Any
tracked, untracked, or ignored file counts as dirt; any observed dirt or
changed HEAD permanently blocks automatic cleanup and preserves the seat. The full
ordering is in [SKILL.md](SKILL.md#8-harvest-retirement-and-cleanup), with Claude
receipts in [docs/CLAUDE-CODE.md](docs/CLAUDE-CODE.md#retirement-and-archive-boundary).
Stop the owned lane before cleanup and keep other same-user processes from
writing into its managed seat during retirement; Git cannot make the final
file census and worktree removal one atomic operation.
A transient local Git or filesystem failure after verified provider retirement
returns `CLEANUP_RETRYABLE` with exit 2; retry the exact owned retirement or
reconciliation without repeating the provider archive. It becomes
`CLEANUP_BLOCKED` only when a cleanup invariant is unsafe.
A complete packet, handback, digest, and retirement walkthrough is in
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
