# Child notifications

A parent that spawns lanes must learn, in real time and without remembering
to poll, when a child needs it: when the child finished what it was asked,
when it is blocked, and when it is gone. This page is the contract for that,
across all four directions (Claude host to Claude or Codex child, Codex host
to Codex or Claude child). The durable event store in
[DISPATCH.md](DISPATCH.md#event-stream) remains the source of truth; what
follows is how events reach the parent fast and how the parent tells "done"
from "still going".

## Three layers

1. **Durable events** (exists). Every child observation that changes state
   records an at-least-once event for the parent; the parent acknowledges
   each one after handling it. Nothing below replaces this: a wake that is
   lost is recovered by the next `wait`.
2. **The watcher** (`transmogrify.js watch`, one process per parent context).
   Started by `spawn` when it is not already running, it observes every
   outstanding child of that parent continuously and records events the
   moment a child changes: Codex children through the app-server's own
   notifications (`thread/status/changed`, `turn/completed`) on one
   WebSocket, with the seat-verified `thread/read` poll as fallback; Claude
   children through the `claude agents` census every two seconds and the
   owned transcript. It exits when the parent has no outstanding children
   and is restarted by the next `spawn` or `wait`.
3. **The wake** (per host). When the watcher records an event worth the
   parent's attention it delivers a short fixed message into the parent's
   own session, so the parent's model is re-invoked without polling:
   - Claude Code parent: a peer follow-up to the parent session's own
     Remote Control bridge, the same public command the adapter uses to
     steer a Claude child. The session sees "Another Claude session sent a
     message: …". Receipt: the parent's bridge id is read at `parent-init`
     from the session's own worker metadata, found by walking the process
     ancestry to the `claude` process (verified on the pinned CLI with
     `remoteControlAtStartup` on; a session without Remote Control has no
     bridge and falls back to layer 4).
   - Codex parent: a `turn/start` on the parent's own thread when it is
     idle, or a `turn/steer` into its active turn, on the shared runtime
     the parent is attached to. Both calls are the mechanisms `recover
     --input` and `steer` already use on children. The parent thread is
     identified at `parent-init` by an exact receipt: the thread on the
     runtime whose cwd is the repository and whose newest turn carries the
     `parent-init` command line, including a one-time nonce, in its items.
     A Codex host whose thread is not on the shared runtime (Desktop
     unattached) has no wake channel and falls back to layer 4.
4. **Foreground or background wait** (exists, improved). `wait` observes
   every child on every call, returns pending and new events together, and
   blocks up to thirty minutes. A Claude Code host runs it as a background
   command so the harness re-invokes the model when it returns; a Codex host
   runs it in the foreground with a long timeout. This is the path when no
   wake channel could be recorded, and the recovery path when a wake was
   lost.

Every layer is observation-based: the watcher and the wake never trust a
child's own claim of completion. A child that says "done" is still observed
through the provider before any event exists.

## Done versus intermediate

Every event carries `kind` and `terminal`:

| `kind` | Events | Meaning for the parent |
| --- | --- | --- |
| `progress` | `child.spawned` | the child exists and is working; nothing to do |
| `complete` | `child.turn-completed` | the input the parent sent has been fully processed and the child is idle; harvest now, steer again, or retire |
| `attention` | `child.needs-attention`, `child.delivery-unknown`, `child.cleanup-blocked` | the child is blocked on approval or input, or a mutation must be reconciled |
| `terminal` | `child.failed`, `child.stopped`, `child.retired` | no further work will come from this child |

`terminal: true` only on the last row. `child.turn-completed` is emitted for
both providers (a Claude lane that goes from working to idle completes a
turn just as a Codex turn does; `child.idle-observed` remains for a lane
first observed idle without a preceding working phase). A child that
completes and is then steered goes back to `progress`; its next completion
is a new event with a new fingerprint.

The wake message names the kind in plain words: "completed its task and is
idle", "needs your attention", "failed", "stopped", "retired". The message
carries the lane id, the dispatch id, and the exact command to run next
(`wait --timeout-ms 0` then `ack`); never child output.

## Check in whenever

`children --observe` refreshes every child's live phase (one bounded
`status` per child) and prints, per child, the normalized `phase`, the
`kind` of its latest event, and whether that event is acknowledged.
`status --lane` remains the exact single-child read.

## Turnkey rules

- `parent-init` records the wake channel it could verify (`claude-bridge`,
  `codex-thread`, or `none`) and prints which one. The verification receipt
  is stored with the parent context; the channel id itself is never printed.
- `spawn` starts the watcher for the parent when it is not running, and
  prints `nextAction` naming the wait command for hosts without a wake
  channel.
- `children`, `doctor`, and `maintain` report the watcher's liveness and
  the count of unattended children: children whose latest `complete`,
  `attention`, or `terminal` event is older than five minutes and still
  unacknowledged.
- The watcher writes only to the parent's own recorded session or thread,
  never to any other, and every message is the fixed template above.

## Receipts and open experiments

Verified: the Claude peer follow-up reaches a Remote-Control session
(adapter steering, live since 0.2); a session's own bridge id is readable
from `~/.claude/sessions/<pid>.json` of the ancestor `claude` process;
`turn/start` on an idle Codex thread starts a turn the model processes and
Desktop renders (the `recover --input` path, live in every 0.3 smoke);
`turn/steer` reaches an in-progress turn (live since 0.2); the app-server
pushes `thread/status/changed` and `turn/completed` to any connected
client; raw `thread/list` rows carry `cwd` and `status`.

Not yet verified live (the Codex model backend was unavailable during the
experiment window): that a `parent-init` command line appears with its
nonce in the parent thread's `thread/items/list` rows, and whether a shell
command run by a Codex turn can see `CODEX_THREAD_ID` (the binary carries the
name; the default `shell_environment_policy` excludes appear to strip it).
Until the first is receipted, a Codex parent records `codex-thread` only
when exactly one active thread on the runtime has the repository as cwd
and the operator confirms, or when it passes `--native-task-ref` itself.
