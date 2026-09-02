# Claude Code integration

This document separates Claude Code's public contract from the local and
private surfaces used by the current adapter. The target is the Code experience
in Claude Desktop and the Claude mobile app, not consumer Chat.

## Public product surface

Anthropic documents the following:

- [`--bg`](https://code.claude.com/docs/en/cli-usage) starts a background
  Claude Code session and returns immediately. The same reference documents
  `agents --json --all`, exact session naming, `stop`, `rm`, and `--resume`.
- [Send follow-ups from the CLI](https://code.claude.com/docs/en/claude-code-on-the-web#send-follow-ups-from-the-cli)
  documents `claude -p <message> --cloud <session-id>` for queueing one message
  to an existing Remote Control session. With `--output-format json`, the
  command returns an acknowledgment containing the session ID and URL.
- [Remote Control](https://code.claude.com/docs/en/remote-control) keeps execution
  on the local machine, connects outward through Anthropic over TLS, and exposes
  the session through Claude web and mobile Code surfaces. Names passed at
  launch appear in the remote session list. The same reference documents
  `claude remote-control` server mode, including named sessions, capacity,
  same-directory/worktree/session spawn modes, and session resumption.
- [Claude Desktop](https://code.claude.com/docs/en/desktop) provides the Code tab
  and its own session management. `/desktop` transfers an interactive CLI
  session into Desktop and exits the CLI; Desktop and standalone CLI otherwise
  maintain separate histories.
- The [CLI reference](https://code.claude.com/docs/en/cli-usage) documents
  `claude stop <id>` as whole-background-session stop and `claude rm <id>` as
  background-session removal. CLI `2.1.258` help states that `rm` deletes the
  background session and its worktree, so it is a destructive cleanup command,
  not a record-only operation.

The standalone adapter uses Remote Control directly. It does not create a plain
terminal session and then run `/desktop`, because that transfer exits the CLI
and does not provide a stable external lifecycle control plane.

## Measured compatibility tuple

Live verification on 2026-09-01 and 2026-09-02 used:

| Component | Pinned receipt |
| --- | --- |
| Platform | Darwin arm64 |
| Current Claude Code CLI | `2.1.258` |
| Current CLI SHA-256 | `b63136194160791c27cfa7b0403060d85eb0752991625fde8c09f9acacb17c78` |
| Prior CLI SHA-256 | `64590d7d9d9c189d33fb3dfa58c5408eaf2a10fe556bd84155d95efaab46b60e` |
| Claude Desktop | `1.40609.1` |
| Desktop bundle ID | `com.anthropic.claudefordesktop` |
| Desktop `app.asar` SHA-256 | `0fcf5499f5eee77bb769362a3603a4278b5ba9a8ae2620395146afc60c13861f` |
| Claude for iOS | `1.260828.1` (`33349478298`) |

The public lifecycle adapter pins the platform, CLI build, first-party account,
and the device/inode identities of the default config and projects directories.
Both directories must be current-user-owned and not group/world writable;
symlink traversal fails closed. Private native archival additionally
pins the Desktop version, bundle ID, and `app.asar` hash. An unknown Desktop
build therefore disables archival without disabling the public lifecycle. This
is a measured compatibility boundary, not a claim that other versions or
platforms cannot support the design.

Native Claude installations check for updates in the background. Anthropic
documents both that behavior and the update controls in
[Advanced setup](https://code.claude.com/docs/en/setup#disable-auto-updates) and
the [environment-variable reference](https://code.claude.com/docs/en/env-vars).
Transmogrify sets `DISABLE_UPDATES=1` only for its managed Claude subprocesses;
it does not edit Claude settings or disable the user's global updater. Existing
lanes select their recorded versioned executable by default.

An already-running worker can still be encountered after a verified provider
upgrade. Reconciliation treats that as an explicit append-only runtime
transition, not as an implicit version substitution. It requires an unchanged
account, config-directory identity, platform, protocol generation, full session
UUID, short job ID, bridge ID, name, and cwd, then verifies the new worker
binary, process birth, and private socket before recording the new runtime and
execution epochs together. An unknown build, stopped worker, or any identity
drift remains a hard stop.

## Spawn and native visibility

The adapter launches the public CLI with exact argument positions equivalent to:

```text
claude --bg --name <name> --remote-control <name> [--model <selector>] <prompt-with-unique-marker>
```

Both name arguments receive the same canonical `::: <summary>` value. The
marker makes owned rows visually consistent with Codex, but never substitutes
for the recorded session, job, bridge, runtime, and seat identity.

CLI `2.1.258` exposes the initial prompt as the documented positional argument,
so it can be visible briefly to same-user process inspection. Follow-up steering
does not share this limitation because the adapter writes that content to the
public `--cloud` command through stdin.

Model, effort, and speed follow Anthropic's documented `--model`, `--effort`,
and `--settings` surfaces. Transmogrify resolves every request before provider
access and journals the requested and resolved values separately. Supported
aliases are retained in the requested receipt but compile to a versioned model
selector. Standard and Fast compile to explicit `fastMode:false` and
`fastMode:true` settings; Fast is accepted only for the models in the pinned
compatibility catalog. Recovery reapplies that exact versioned selector,
effort, and setting, so an old lane cannot silently move with a rolling alias
or inherit a changed host speed preference. See
[Execution profiles](EXECUTION-PROFILES.md) and Anthropic's
[Model configuration](https://code.claude.com/docs/en/model-config).

Transmogrify does not substitute another model or speed after resolution.
Anthropic can still apply its documented provider-native fallback for safety,
availability, or Fast rate limits. Claude does not currently return an
effective model, effort, and speed receipt through this surface, so those
fields remain unobserved rather than being inferred from a successful launch.

It does not accept a provider session as owned from CLI output alone. Before
returning success it correlates:

1. a pre-spawn `agents --json --all` census;
2. the returned eight-character job ID;
3. exactly one new full session UUID with the requested name and canonical cwd;
4. a unique prompt marker in that session's transcript;
5. the worker process identity and birth receipt;
6. the worker metadata's Remote Control bridge ID;
7. the exact local Unix-domain socket identity; and
8. the first execution epoch recorded atomically with all provider IDs.

Raw bounded CLI stdout and stderr are held in owner-only capture files only
while spawn delivery remains unresolved. Confirmed and proven-not-delivered
terminal paths remove those exact files after durable SHA-256 and identity
receipts are available. A process-start failure may have only a fixed error
receipt because no provider identity existed; crash reconciliation finishes the same cleanup without
replaying spawn.

It then dispatches `claude://code/<bridge-id>` as a presentation hint. Deep-link
failure does not cause another spawn; it is recorded as presentation-unknown and
can be retried independently.

**Live-verified 2026-09-01:** a named disposable session created through this
path appeared in Claude Desktop's Code session list with the exact title,
managed worktree, live response, and Remote Control presentation.

**Live-verified 2026-09-02:** disposable Claude lanes created from Codex and
Claude hosts appeared in Claude for iOS `1.260828.1` (`33349478298`). A fresh
mobile-originated input was consumed exactly once by the Claude-host lane and
its reply rendered in both mobile and Desktop. This verifies the named client
and pinned host tuple, not unmeasured or future client builds.

## Steering

The adapter sends directed input with the documented public command, passing
message content through stdin rather than process arguments:

```text
claude -p --cloud <exact-cse-session-id> --output-format json
```

Before dispatch it validates the exact owned Remote Control bridge and journals
the operation as possibly delivered. It accepts only an exact JSON
acknowledgment for that bridge. The acknowledgment is not the final delivery
receipt: success requires the owned transcript to contain the unique queued or
consumed marker. The reported semantic is `queuedSafePointPublicCli`; delivery
may wait for the running tool call to reach a safe point. An interrupted or
ambiguous dispatch is observed and reconciled, never replayed.

**Live-verified 2026-09-01:** on CLI `2.1.258`, an exact disposable Remote
Control follow-up returned an ambiguous command result, while its exact
transcript recorded the marked message. Reconciliation completed the journal
without a second send. This exercises the no-replay ambiguity path rather than
treating a process acknowledgment as delivery proof.

The worker's Unix-domain socket, process birth, device, inode, owner, mode, and
hash remain measured execution-identity receipts. The socket is not the normal
directed-input transport and is not treated as a public Anthropic contract.

## Status, stop, and recovery

Status starts with public `claude agents --json --all` and resolves the exact
full session UUID, short job ID, name, and canonical cwd. Short job IDs are not
globally sufficient: stop and removal recheck that the short ID maps to only one
listed full UUID immediately before mutation.

Stop uses `claude stop <short-job-id>` and verifies the exact row is stopped.
Its semantic is whole-session stop; turn-only cancel is unsupported.

Recovery uses the documented resume and background flags with the full recorded
UUID, plus the lane's immutable resolved execution controls:

```text
claude --resume <full-session-uuid> --bg --model <versioned-selector> [--effort <level>] --settings <explicit-fast-mode>
```

The adapter rejects a correlated same-name/same-seat copy, ignores unrelated
concurrent sessions, and binds a new worker/socket epoch before restoring
control.

**Live-verified 2026-09-01:** on CLI `2.1.258`, exact stop preserved the session.
Resume returned an ambiguous command result, and reconciliation verified the
same full UUID and Remote Control bridge under a new execution epoch without a
second resume.

## Retirement and archive boundary

Public `claude rm` removes a background session and may delete its worktree. It
is not the same operation as clicking Archive in Claude's native session list.
As of 2026-09-01, review of the public
[CLI reference](https://code.claude.com/docs/en/cli-usage),
[Remote Control documentation](https://code.claude.com/docs/en/remote-control),
and [Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview) found no
documented archive method for that native Remote Control row.

The current adapter therefore uses one narrowly pinned private request:

```text
POST /v1/code/sessions/<cse-id>/archive
```

It verifies archive status with the corresponding GET before and after POST.
The bridge ID is canonicalized to the exact `cse_…` resource. Every status GET
must contain one recognized status and agree on the requested resource ID. The
POST response body is not trusted as proof; even an accepted already-archived
response is followed by an exact postcondition GET.

Private archival is disabled unless the caller passes `--private-archive`. Its
preflight verifies the exact CLI hash, Desktop bundle ID/version/hash, platform,
organization, and account/config identity. Only then does it read the macOS
Keychain item named `Claude Code-credentials` for the current OS account. The
token remains in memory, is never logged or written to repository state, and is
sent only to `https://api.anthropic.com` with redirects disabled and bounded
responses.

The adapter never enrolls a trusted device or refreshes authentication. A 401,
stale login, untrusted-device 403, changed bundle, changed endpoint shape, or
ambiguous resource ID stops retirement.

Retirement order is:

1. durable output harvest and seat receipt;
2. exact whole-session stop and verification;
3. exact remote archive and verification;
4. for an external or explicitly deferred seat, preserve the seat, never invoke
   `claude rm`, and persist local removal as deferred;
5. for an eligible managed seat, verify it was clean at harvest and remains
   clean with unchanged HEAD, then remove it through the operator guard;
6. only after the recorded managed-seat path is absent, invoke `claude rm` for
   the exact uniquely mapped local record, relist and revalidate full-session
   plus short-job uniqueness immediately before dispatch, and verify that
   record is absent; and
7. complete the durable operation record.

**Live-verified 2026-09-01:** with CLI `2.1.258` and Desktop `1.40609.1`, the
archive request removed an exact disposable Remote Control row from the native
Claude Desktop Code session list. The same lane completed the ordered cleanup
above: the guarded
seat was absent before local removal, `claude rm` removed the exact
background-agent record, and both absences were read back. The destructive
ordering and crash boundaries are also adversarially tested. User-owned
sessions were not touched.

A transient local Git or filesystem failure after verified archive returns
`CLEANUP_RETRYABLE` and preserves the pending retirement for exact-owned retry
without another archive request. Dirt, changed HEAD, or identity drift returns
the permanent automation refusal `CLEANUP_BLOCKED`.
Preserving the seat leaves that refusal intact. If the owner manually removes
the exact managed seat after review, the exact retirement must be rerun with
`--accept-manual-seat-removal`; target-wide reconciliation cannot infer owner
acknowledgement from an absent path.

Private archive errors are phase-aware. An authentication or trust failure
before the archive POST proves that archive was not dispatched, while retaining
any already verified stop receipt. Once POST dispatch begins, every failed or
ambiguous postcondition—including a later 401 or 403—is
`REMOTE_ARCHIVE_UNCERTAIN`; it is never projected as a safe precondition and is
not replayed blindly.

## Shared-runtime research result

Claude exposes a documented multi-session `claude remote-control` server mode.
As of 2026-09-01, review of the public CLI, Remote Control, Desktop, and Agent SDK
surfaces linked above found no documented external local RPC through which
another process can perform the complete lifecycle offered by `codex
app-server` for this compatibility tuple. Remote Control uses outbound Anthropic transport. The
observed local daemon/control socket is transient private supervisor state, not
adopted as a stable external API. Claude Desktop embeds the same underlying
Claude Code engine but keeps its own session history and offers `/desktop` as a
one-way CLI transfer.

The resulting architecture is intentionally asymmetric:

- public CLI for lifecycle discovery, spawn, directed follow-up, stop, resume,
  and managed-seat local removal after the guarded seat path is absent;
- exact transcript receipts for directed-input delivery;
- Remote Control bridge and deep link for native visibility; and
- one explicit, pinned private API for native archive parity.

This preserves one lifecycle contract without pretending that both providers
offer the same transport.

## Acceptance status

| Requirement | Status |
| --- | --- |
| Codex orchestrator starts a named Claude Code lane | Implemented and live-verified |
| Lane appears in Claude desktop Code session list | Live-verified |
| Lane appears in Claude mobile Code session list | Live-verified |
| Transmogrify observes status | Implemented and live-verified |
| Transmogrify steers exact running lane | Implemented with public `--cloud` follow-up and live-verified |
| Transmogrify stops and resumes exact lane | Implemented and live-verified |
| Transmogrify archives native row | Implemented through pinned private API and live-verified |
| Transmogrify removes only its clean managed worktree | Implemented and adversarially tested |
| Transmogrify clears local Claude record without risking an external/deferred seat | Managed-seat ordering implemented and tested; external/deferred removal is intentionally deferred |
| Mobile-originated input is observed end to end | Live-verified |
| Unknown future CLI build fails closed for lifecycle mutations | Implemented and tested |
| Verified running-worker CLI transition reconciles without changing account/config identity | Implemented, tested, and live-verified |
| Unknown future Desktop build disables private archive | Implemented and tested |

The smallest upstream capability that would remove the private dependency is a
documented authenticated archive/status API for an exact Remote Control session
ID. A documented external RPC for Remote Control server mode would additionally
allow shared-process discovery and ownership without relying on separate CLI
invocations, but it is not required for the current lifecycle contract.
