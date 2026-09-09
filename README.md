# Transmogrify

Transmogrify is an open-source skill for Claude Code and Codex. Install it once
and either app can hand coding work to the other and watch it run: every job
gets its own clone of your repository and a name you can find in the app, and
the agent that started it can steer it, collect the commit it hands back, and
close it out. The commands are the same in both directions.

Under the hood each provider keeps its native channel. Codex jobs are threads
on a shared local `codex app-server` runtime; Claude jobs are named Claude
Code Remote Control sessions. Every lifecycle mutation is ownership-gated: the
installation keeps an exact lane registry and durable operation records
outside your repository, never adopts a session by name, and never touches a
session or worktree it does not own. Read [Security](SECURITY.md) before using
it on sensitive work.

The name: to transmogrify is to change something completely while keeping it
recognizable. Transmogrify turns two different native agent mechanisms into
one lifecycle without flattening them into a fake common transport.

## Support matrix

| Host app | Codex jobs | Claude Code jobs |
| --- | --- | --- |
| Codex | Yes. They run on the shared Codex server and show live in the ChatGPT app once the app is connected to that server. | Yes. They run as named Remote Control sessions and show in the Claude app. |
| Claude Code | Yes. They run on the shared Codex server and show live in the ChatGPT app once the app is connected to that server. | Yes. They run as named Remote Control sessions and show in the Claude app. |

Live streaming in the ChatGPT app is conditional and measured, never assumed:
`scripts/desktop-attach.js` reports whether the app holds a connection to the
selected runtime, and only on a verified app build. Without that receipt a
Codex lane runs protocol-only, which `spawn` accepts only with
`--allow-protocol-only`. Claude lanes carry their Remote Control receipt and
were live-verified on Desktop and iPhone. Verified builds and receipts are in
the [protocol contract](docs/PROTOCOL.md) and
[Claude Code integration](docs/CLAUDE-CODE.md).

## Requirements

- [Node.js](https://nodejs.org/en/download) 20 or newer with npm, plus Git,
  Bash, `ps`, and `lsof`. macOS and Linux are CI-tested; Windows is not
  supported.
- Codex CLI/app-server `0.151.0` or newer, signed in
  ([Codex CLI guide](https://learn.chatgpt.com/docs/codex/cli)). Live
  streaming in the ChatGPT app additionally needs an app build verified for
  relay attachment and thread resume; no current build passes (26.901.51231
  and 26.903.61454 both fail to resume threads on the relay path), and an
  owner records one that does with
  `desktop-attach.js persist --authorize --verified-build <version> <build>`.
  Mobile visibility was measured with ChatGPT for iOS `1.2026.230`
  (`32543289983`).
- For Claude jobs: Apple Silicon macOS and Claude Code CLI `2.1.258` or newer,
  signed in to a `claude.ai` account. Compatibility is a measured minimum plus
  probes, with no maximum version; a failed measurement blocks mutations. The
  private archive step separately pins the exact CLI hash and Claude Desktop
  `1.46388.4`. Mobile behavior was verified with Claude for iOS `1.260828.1`
  (`33349478298`). Details in
  [Claude compatibility](docs/CLAUDE-CODE.md#compatibility-receipts).
- One runtime dependency, `ws`. The website under `site/` is a separate
  package that is not installed with the skill.
- The target repository must be a Git worktree root with at least one commit.

## Install

Paste one line into Claude Code or the ChatGPT desktop app:

```text
Fetch https://transmogrify.sh/start and follow its instructions.
```

CI generates `/start` from one exact published release commit; it refuses to
install without that pin and never falls back to a branch. To install from a
source checkout instead:

```bash
git clone https://github.com/nicholasgerard/transmogrify.git
cd transmogrify
npm ci --ignore-scripts
./install.sh --dry-run
./install.sh
```

The installer copies the skill to `~/.claude/skills/transmogrify` and
`~/.agents/skills/transmogrify` (Codex's personal skill location), backs up
existing installations, and refuses an occupied target it did not write or an
unsafe parent directory. `--target codex|claude` installs one host;
`./install.sh --help` lists the rest. The package is not published to npm.

Then, in a new session, run the doctor and let guided setup handle whatever it
finds, one consent at a time:

```bash
export SKILL_ROOT="$HOME/.agents/skills/transmogrify"   # Claude-only: $HOME/.claude/skills/transmogrify
export REPO_ROOT=/absolute/path/to/repository
node "$SKILL_ROOT/scripts/doctor.js" --repo-root "$REPO_ROOT" --target all --explain
node "$SKILL_ROOT/scripts/setup.js" --repo-root "$REPO_ROOT"
```

The doctor reads provider state, measures compatibility, and writes only
local receipts; it never starts, stops, steers, or archives a real session.
Its `setup.ownerActions` names every step only the owner can take, with a
`blocking` flag: a logged-out or unmeasured Claude CLI blocks Claude lanes, a
runtime that needs authorization blocks Codex lanes, and an unattached Codex
app only withholds live streaming. In a non-interactive host, authorize one
step at a time with the matching `setup.js` flag
(`--install-claude-cli`, `--install-codex-cli`, `--sign-in`,
`--start-runtime`, `--relaunch-desktop`, `--persist-attach`). Invoke the skill
with `$transmogrify operate this repository` in Codex or
`/transmogrify operate this repository` in Claude Code. Upgrades, rollback,
and removal are in [Troubleshooting](docs/TROUBLESHOOTING.md#installation-and-upgrades).

## The Codex runtime and the ChatGPT app

Codex lanes need a shared `codex app-server` runtime. If a verified one is
listening, Transmogrify reuses it; otherwise `scripts/runtime-up.sh` ensures
Codex's installer-managed daemon and a private loopback relay, falling back to
a standalone loopback runtime on port 8843. It never replaces or reconfigures
a runtime owned by another program. Runtime selection is the same everywhere:
`--url`, then `TRANSMOGRIFY_URL`, then the live relay record, then
`TRANSMOGRIFY_PORT`, then port 8843.

The ChatGPT app shows lanes live when it is a client of that runtime, which
happens when it is launched with `CODEX_APP_SERVER_WS_URL` pointing at the
relay. `desktop-attach.js ensure` does that on a verified build (relaunching a
running app only with `--relaunch-desktop` or
`TRANSMOGRIFY_DESKTOP_RELAUNCH=auto`), `persist --authorize` keeps it across
logins with a LaunchAgent, and `unpersist --authorize` restores the previous
setting. An app update pauses persisted attachment until the new build is
verified again; lanes keep working protocol-only. After any Desktop restart or
update, rerun the doctor so attachment is measured again. The mechanism, its
limits, and the builds recorded as broken are in the
[protocol contract](docs/PROTOCOL.md#native-app-visibility).

## Quick start

Create a durable parent context, then spawn a child with the packet on stdin:

```bash
export WORKTREES="$HOME/.local/share/transmogrify/worktrees/example-repository"
install -d -m 700 "$WORKTREES"

node "$SKILL_ROOT/scripts/lane.js" parent-init \
  --repo-root "$REPO_ROOT" --host-provider codex --host-app codex-desktop \
  --name 'Repository operator'
# Copy contextFile from the result.
export PARENT_CONTEXT=/absolute/path/to/parent-context.json

printf '%s\n' 'Inspect the failing tests and report the smallest safe fix.' |
  node "$SKILL_ROOT/scripts/lane.js" spawn \
    --repo-root "$REPO_ROOT" --worktrees "$WORKTREES" \
    --target codex --name 'tests: diagnose failure' \
    --parent-context-file "$PARENT_CONTEXT" --intent balanced --input-file -
```

`--target claude` spawns a Claude Code lane instead. Both take a
provider-neutral `--intent` or explicit `--model`, `--effort`, and `--speed`
([Execution profiles](docs/EXECUTION-PROFILES.md)). The child gets a managed
clone under `WORKTREES`, or an existing worktree with `--cwd`. Its first
message is prefixed with dispatch provenance and its native title starts with
`::: `. Keep the parent listening until its children return:

```bash
node "$SKILL_ROOT/scripts/lane.js" wait --parent-context-file "$PARENT_CONTEXT" \
  --repo-root "$REPO_ROOT" --timeout-ms 60000
node "$SKILL_ROOT/scripts/lane.js" ack --parent-context-file "$PARENT_CONTEXT" --event EVENT_ID
```

Events persist across restarts and redeliver until acknowledged. A completion
wake tells the parent a child finished its turn; it never means the task
succeeded and never triggers automatic archival. Steer and inspect a lane by
its `laneId`:

```bash
printf '%s\n' 'Prioritize the regression test before refactoring.' |
  node "$SKILL_ROOT/scripts/lane.js" steer --repo-root "$REPO_ROOT" --lane LANE_ID --input-file -
node "$SKILL_ROOT/scripts/lane.js" status --repo-root "$REPO_ROOT" --lane LANE_ID
```

Every child receives `.transmogrify/packet.md` and writes
`.transmogrify/handback.md` in its seat. In a managed clone it commits on its
assigned branch and reports the full SHA; it never pushes or changes branches.
Once the child is idle, harvest and retire:

```bash
node "$SKILL_ROOT/scripts/lane.js" harvest --repo-root "$REPO_ROOT" --lane LANE_ID
node "$SKILL_ROOT/scripts/lane.js" retire --repo-root "$REPO_ROOT" --lane LANE_ID \
  --harvested-output-sha256 LOWERCASE_SHA256      # Claude lanes add --private-archive
```

Harvest verifies the handback and seat HEAD, fetches the commit into your
repository, saves the handback durably, and prints the retirement command;
`harvest --commit` is the fallback when a child could not commit. Retirement
needs that harvest digest, requires the seat clean and unchanged, and removes
only what it provisioned; anything else blocks cleanup and preserves the seat.
The full ordering is in [SKILL.md](SKILL.md#7-harvest-and-retire), and a
complete walkthrough with every file is in [Examples](examples/README.md).

## Tools

| Tool | Purpose |
| --- | --- |
| `scripts/transmogrify.js` | One entry point that forwards to the tools below |
| `scripts/doctor.js` | Read-only discovery, compatibility measurement, and the setup plan |
| `scripts/setup.js` | Guided setup, one consented step at a time |
| `scripts/lane.js` | `parent-init`, `parent-list`, `capabilities`, `spawn`, `children`, `wait`, `ack`, `steer`, `status`, `interrupt`, `stop`, `recover`, `harvest`, `retire`, `reconcile`, `abandon`, `schema` |
| `scripts/maintain.js` | The doctor plus each provider's exact-owned reconcile; `--retention` trashes aged journals and old install backups recoverably |
| `scripts/runtime-up.sh` | Ensure the managed Codex daemon and relay, or report the standalone fallback |
| `scripts/desktop-attach.js` | Measure, ensure, persist, or remove the ChatGPT app's attachment to the runtime |
| `scripts/watch.js` | Per-parent watcher started by `spawn`; records child events and wakes the parent ([Notifications](docs/NOTIFICATIONS.md)) |
| `scripts/lane-status-listen.js`, `scripts/rpc.js` | Read-only Codex listening and diagnostics |

Every tool takes `--help`. Commands exit 0 for a confirmed result, 2 for a
usage error or a safe refusal, 3 for a failure or an uncertain outcome, and 1
only for an internal error; failures print one JSON envelope with a fixed
message per code, and success output is an allowlist per operation
([Output contract](docs/OUTPUT.md)).

## Documentation

- [SKILL.md](SKILL.md): the operator policy an agent loads.
- [Protocol contract](docs/PROTOCOL.md): Codex wire contract, runtime and
  attachment mechanics, failure classes, and dated receipts.
- [Claude Code integration](docs/CLAUDE-CODE.md): public surface, measured
  control path, the pinned archive boundary, and acceptance status.
- [Execution profiles](docs/EXECUTION-PROFILES.md): intents, models, effort,
  speed, receipts, and recovery.
- [Dispatch and parent notification](docs/DISPATCH.md): lineage, provenance,
  durable child events, waiting, acknowledgement, and restart.
- [Child notifications](docs/NOTIFICATIONS.md): the watcher, wake channels,
  event kinds, and the cost model.
- [Onboarding](docs/ONBOARDING.md): the setup contract behind the start
  prompt and its acceptance matrix.
- [Troubleshooting](docs/TROUBLESHOOTING.md): setup failures, runtime safety,
  upgrade and rollback, and blocked cleanup.
- [Examples](examples/README.md): one lane from packet to retirement.
- [Roadmap](ROADMAP.md), [Changelog](CHANGELOG.md),
  [Contributing](CONTRIBUTING.md), [Code of Conduct](CODE_OF_CONDUCT.md), and
  the [website source](site/README.md).

## Support and security

Ask setup and usage questions in
[GitHub Discussions](https://github.com/nicholasgerard/transmogrify/discussions),
file reproducible defects in
[GitHub Issues](https://github.com/nicholasgerard/transmogrify/issues), and
email [support@thebkapp.co](mailto:support@thebkapp.co) for private matters.
Report vulnerabilities through the private route in [SECURITY.md](SECURITY.md);
never post credentials, transcripts, session identifiers, or exploit details
publicly.

The loopback runtime and Unix-socket endpoints have no authentication: treat
them as a local control plane and trust the machine's other programs before
connecting sensitive work. The Claude adapter pins the build it measured, and
its optional archive step reads one named macOS Keychain item only during an
explicitly authorized retirement and never prints it.

## License

MIT, see [LICENSE](LICENSE).
