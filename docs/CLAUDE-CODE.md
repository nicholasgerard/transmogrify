# Claude Code integration

This document separates Claude Code's public contract from the local and
private surfaces the adapter uses, and records the pinned builds those
surfaces were verified against. Read it if you operate Claude lanes or need to
know exactly where the integration leaves documented ground.

The target is the Code experience in Claude Desktop and the Claude mobile app,
not consumer Chat.

## Operating rules

- The adapter uses Remote Control directly. It never creates a plain terminal
  session and then runs `/desktop`, because that transfer exits the CLI and
  leaves no stable external lifecycle control plane.
- Lifecycle mutation requires the pinned CLI. An unknown build fails closed.
- Private archival is off unless the caller passes `--private-archive`, and
  its preflight pins the CLI hash, Desktop bundle ID, version, and `app.asar`
  hash, plus platform, organization, and account/config identity.
- An unknown Desktop build disables archival without disabling the public
  lifecycle.
- A provider session is never owned on CLI output alone. Ownership is the full
  correlation below.
- Unrelated concurrent sessions are ignored, and a correlated same-name or
  same-seat copy is rejected rather than adopted.
- `claude rm` deletes the background session and its worktree. It is
  destructive cleanup, not a record-only operation, and runs only after the
  managed seat path is already absent.
- The adapter never enrolls a trusted device or refreshes authentication.

## Public product surface

Anthropic documents the following:

- [`--bg`](https://code.claude.com/docs/en/cli-usage) starts a background
  Claude Code session and returns immediately. The same reference documents
  `agents --json --all`, exact session naming, `stop`, `rm`, and `--resume`,
  and defines `claude stop <id>` as whole-background-session stop and
  `claude rm <id>` as background-session removal.
- [Send follow-ups from the CLI](https://code.claude.com/docs/en/claude-code-on-the-web#send-follow-ups-from-the-cli)
  documents `claude -p <message> --cloud <session-id>` for queueing one message
  to an existing Remote Control session. With `--output-format json`, the
  command returns an acknowledgment containing the session ID and URL.
- [Remote Control](https://code.claude.com/docs/en/remote-control) keeps
  execution on the local machine, connects outward through Anthropic over TLS,
  and exposes the session through Claude web and mobile Code surfaces. Names
  passed at launch appear in the remote session list. The same reference
  documents `claude remote-control` server mode, including named sessions,
  capacity, same-directory/worktree/session spawn modes, and session
  resumption.
- [Claude Desktop](https://code.claude.com/docs/en/desktop) provides the Code
  tab and its own session management. `/desktop` transfers an interactive CLI
  session into Desktop and exits the CLI; Desktop and standalone CLI otherwise
  maintain separate histories.

Native Claude installations check for updates in the background. Transmogrify
sets `DISABLE_UPDATES=1` only for its managed Claude subprocesses; it does not
edit Claude settings or disable the user's global updater. Existing lanes
select their recorded versioned executable by default. See
[Advanced setup](https://code.claude.com/docs/en/setup#disable-auto-updates)
and the [environment-variable reference](https://code.claude.com/docs/en/env-vars).

## Spawn and native visibility

The adapter launches the public CLI with exact argument positions equivalent
to:

```text
claude --bg --name <name> --remote-control <name> [--model <selector>] [--effort <level|ultracode>] [--settings '{"fastMode":<bool>}'] <prompt-with-unique-marker>
```

Both name arguments receive the same canonical `::: <summary>` value. The
marker makes owned rows visually consistent with Codex but never substitutes
for the recorded session, job, bridge, runtime, and seat identity.

The pinned CLI exposes the initial prompt as the documented positional
argument, so it can be visible briefly to same-user process inspection.
Follow-up steering does not share this limitation, because that content goes
to the public `--cloud` command through stdin.

Model, effort, and speed follow Anthropic's documented `--model`, `--effort`,
and `--settings` surfaces. Every request is resolved before provider access,
with requested and resolved values journaled separately. Aliases are retained
in the requested receipt but compile to a versioned model selector. Standard
and Fast compile to explicit `fastMode:false` and `fastMode:true`; Fast is
accepted only for models in the pinned compatibility catalog. Recovery
reapplies that exact versioned selector, effort, and setting, so an old lane
cannot silently move with a rolling alias or inherit a changed host speed
preference. See [Execution profiles](EXECUTION-PROFILES.md) and
[Model configuration](https://code.claude.com/docs/en/model-config).

Transmogrify substitutes no model or speed after resolution. Anthropic can
still apply its documented native fallback for safety, availability, or Fast
rate limits. Claude returns no effective model, effort, and speed receipt
through this surface, so those fields stay unobserved rather than inferred
from a successful launch.

Before returning success, spawn correlates:

1. a pre-spawn `agents --json --all` census;
2. the returned eight-character job ID;
3. exactly one new full session UUID with the requested name and canonical
   cwd;
4. a unique prompt marker in that session's transcript;
5. the worker process identity and birth receipt;
6. the worker metadata's Remote Control bridge ID;
7. the exact local Unix-domain socket identity; and
8. the first execution epoch recorded atomically with all provider IDs.

Raw bounded CLI stdout and stderr are held in owner-only capture files only
while spawn delivery remains unresolved. Confirmed and proven-not-delivered
terminal paths remove those exact files once durable SHA-256 and identity
receipts exist. A process-start failure may have only a fixed error receipt,
because no provider identity existed; crash reconciliation finishes the same
cleanup without replaying spawn.

The adapter then dispatches `claude://code/<bridge-id>` as a presentation
hint. Deep-link failure does not cause another spawn: it is recorded as
presentation-unknown and can be retried independently.

## Steering

Directed input uses the documented public command, with message content passed
through stdin rather than process arguments:

```text
claude -p --cloud <exact-cse-session-id> --output-format json
```

Before dispatch the adapter validates the exact owned Remote Control bridge
and journals the operation as possibly delivered. It accepts only an exact
JSON acknowledgment for that bridge, and that acknowledgment is not the final
delivery receipt: success requires the owned transcript to contain the unique
queued or consumed marker. The reported semantic is `queuedSafePointPublicCli`,
so delivery may wait for a running tool call to reach a safe point. An
interrupted or ambiguous dispatch is observed and reconciled, never replayed.

The worker's Unix-domain socket, process birth, device, inode, owner, mode,
and hash remain measured execution-identity receipts. The socket is not the
normal directed-input transport and is not treated as a public Anthropic
contract.

## Status, stop, and recovery

Status starts with public `claude agents --json --all` and resolves the exact
full session UUID, short job ID, name, and canonical cwd. Short job IDs are
not globally sufficient: stop and removal recheck that the short ID maps to
only one listed full UUID immediately before mutation.

Stop uses `claude stop <short-job-id>` and verifies the exact row is stopped.
Its semantic is whole-session stop; turn-only cancel is unsupported.

Recovery uses the documented resume and background flags with the full
recorded UUID, plus the lane's immutable resolved execution controls:

```text
claude --resume <full-session-uuid> --bg --model <versioned-selector> [--effort <level>] --settings <explicit-fast-mode>
```

It binds a new worker and socket epoch before restoring control. An ambiguous
resume is reconciled against the same full UUID and Remote Control bridge
rather than resumed a second time.

An already-running worker can be encountered after a verified provider
upgrade. Reconciliation treats that as an explicit append-only runtime
transition, not an implicit version substitution. It requires an unchanged
account, config-directory identity, platform, protocol generation, full
session UUID, short job ID, bridge ID, name, and cwd, then verifies the new
worker binary, process birth, and private socket before recording the new
runtime and execution epochs together. An unknown build, stopped worker, or
any identity drift is a hard stop.

## Retirement and archive boundary

Public `claude rm` removes a background session and may delete its worktree.
It is not the same operation as clicking Archive in Claude's native session
list, and review of the public
[CLI reference](https://code.claude.com/docs/en/cli-usage),
[Remote Control documentation](https://code.claude.com/docs/en/remote-control),
and [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) found no
documented archive method for that native Remote Control row.

The adapter therefore uses one narrowly pinned private request:

```text
POST /v1/code/sessions/<cse-id>/archive
```

Archive status is verified with the corresponding GET before and after POST.
The bridge ID is the one recorded from the exact worker's metadata at spawn;
the adapter relies on `--remote-control <name>` creating a new bridge rather
than attaching to an existing one, which matched every measured launch, and
the status endpoint exposes no local-session field that could cross-check it.
The bridge ID is canonicalized to the exact `cse_…` resource. Every status GET
must contain one recognized status and agree on the requested resource ID. The
POST response body is not trusted as proof; even an accepted already-archived
response is followed by an exact postcondition GET.

Only after the pinned preflight passes does the adapter read the macOS
Keychain item named `Claude Code-credentials` for the current OS account. The
token stays in memory, is never logged or written to repository state, and is
sent only to `https://api.anthropic.com` with redirects disabled and bounded
responses. A 401, stale login, untrusted-device 403, changed bundle, changed
endpoint shape, or ambiguous resource ID stops retirement.

Retirement order is:

1. durable output harvest and seat receipt;
2. exact whole-session stop and verification;
3. exact remote archive and verification;
4. for an external or explicitly deferred seat, preserve the seat, never
   invoke `claude rm`, and persist local removal as deferred;
5. for an eligible managed seat, verify it was clean at harvest and remains
   clean with unchanged HEAD, then remove it through the operator guard;
6. only after the recorded managed-seat path is absent, invoke `claude rm` for
   the exact uniquely mapped local record, relist and revalidate full-session
   plus short-job uniqueness immediately before dispatch, and verify that
   record is absent; and
7. complete the durable operation record.

Failure handling:

| Condition | Result |
| --- | --- |
| Transient local Git or filesystem failure after verified archive | `CLEANUP_RETRYABLE`. The pending retirement is preserved for exact-owned retry without another archive request. |
| Dirt, changed HEAD, or identity drift | `CLEANUP_BLOCKED`, the permanent automation refusal. Preserving the seat leaves it intact. |
| Owner manually removed the exact managed seat after review | Rerun the exact retirement with `--accept-manual-seat-removal`. Target-wide reconciliation cannot infer owner acknowledgement from an absent path. |
| Authentication or trust failure before the archive POST | Archive was provably not dispatched. Any already verified stop receipt is retained. |
| Any failed or ambiguous postcondition after POST dispatch, including a later 401 or 403 | `REMOTE_ARCHIVE_UNCERTAIN`. It is never projected as a safe precondition and is not replayed blindly. |

## Why the architecture is asymmetric

Claude exposes a documented multi-session `claude remote-control` server mode,
but review of the public CLI, Remote Control, Desktop, and Agent SDK surfaces
linked above found no documented external local RPC through which another
process can perform the complete lifecycle that `codex app-server` offers for
this compatibility tuple. Remote Control uses outbound Anthropic transport.
The observed local daemon/control socket is transient private supervisor
state, not a stable external API. Claude Desktop embeds the same underlying
Claude Code engine but keeps its own session history and offers `/desktop` as
a one-way CLI transfer.

The resulting design is deliberately asymmetric:

- public CLI for lifecycle discovery, spawn, directed follow-up, stop, resume,
  and managed-seat local removal after the guarded seat path is absent;
- exact transcript receipts for directed-input delivery;
- Remote Control bridge and deep link for native visibility; and
- one explicit, pinned private API for native archive parity.

The smallest upstream capability that would remove the private dependency is a
documented authenticated archive/status API for an exact Remote Control
session ID. A documented external RPC for Remote Control server mode would
additionally allow shared-process discovery and ownership without separate CLI
invocations, but it is not required for the current lifecycle contract.

## Pinned compatibility receipts

| Component | Pinned receipt |
| --- | --- |
| Platform | Darwin arm64 |
| Claude Code CLI | `2.1.258` |
| CLI SHA-256 | `b63136194160791c27cfa7b0403060d85eb0752991625fde8c09f9acacb17c78` |
| Prior CLI SHA-256, runtime-transition receipt only, not accepted for mutation | `64590d7d9d9c189d33fb3dfa58c5408eaf2a10fe556bd84155d95efaab46b60e` |
| Claude Desktop | `1.40609.1` |
| Desktop bundle ID | `com.anthropic.claudefordesktop` |
| Desktop `app.asar` SHA-256 | `0fcf5499f5eee77bb769362a3603a4278b5ba9a8ae2620395146afc60c13861f` |
| Claude for iOS | `1.260828.1` (`33349478298`) |

The public lifecycle adapter pins the platform, CLI build, first-party
account, and the device/inode identities of the default config and projects
directories. Both directories must be current-user-owned and not group or
world writable; symlink traversal fails closed. Private native archival
additionally pins the Desktop version, bundle ID, and `app.asar` hash.

This is a measured compatibility boundary, not a claim that other versions or
platforms cannot support the design.

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

Live verification covers the named client and pinned host tuple above, not
unmeasured or future client builds.
