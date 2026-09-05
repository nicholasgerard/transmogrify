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
   Started detached by `spawn` when it is not already running, it observes
   every outstanding child of that parent through the same seat-verified
   provider reads `wait` uses, records the same durable events, and exits
   fifteen minutes after the last child settled and was acknowledged. It
   reads a working child every three seconds, an idle child every thirty,
   and a parent with nothing outstanding once a minute; a parent command
   that changes a child (spawn, steer, recover, interrupt, stop, retire)
   nudges it to read that child at once, so an idle child is never polled
   for a change only its parent can cause. A single
   instance per parent is enforced by a pid-and-birth record; a stale
   record is replaced. A watcher started after a stop wakes the parent once
   more for every event still unacknowledged, never for acknowledged ones. Subscribing to the app-server's own
   `thread/status/changed` notifications instead of polling is a later
   optimization, not a semantic change.
3. **The wake** (per host). When a round records events worth the
   parent's attention it delivers one short fixed message naming all of
   them into the parent's own session, so the parent's model is re-invoked
   once per round, never once per event, and without polling:
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
     identified at `parent-init` by an exact receipt: Codex hands the
     thread id to the commands a turn runs as `CODEX_THREAD_ID`; the thread
     must exist on the selected runtime, its cwd must be the repository when
     `--repo-root` is given, and its items must show the `parent-init`
     command line being run (plus `--self-nonce` when supplied). A Codex host
     whose thread is not on the shared runtime (Desktop unattached) has no
     wake channel and falls back to layer 4.
4. **Foreground or background wait** (exists, improved). `wait` with a positive timeout observes
   every child first, returns pending and new events together, and blocks
   up to thirty minutes; `--timeout-ms 0` returns the durable queue without
   observing (the fast path after a wake). A Claude Code host runs it as a background
   command so the harness re-invokes the model when it returns; a Codex host
   runs it in the foreground with a long timeout. This is the path when no
   wake channel could be recorded, and the recovery path when a wake was
   lost.

Every layer is observation-based: the watcher and the wake never trust a
child's own claim of completion. A child that says "done" is still observed
through the provider before any event exists.

Retire, stop, and interrupt publish their command event before completing the
operation journal. Every event remains pending until the parent acknowledges
it. A command may suppress the redundant wake only when it received
`--parent-context-file` and that registered context matches the dispatch's
parent. The event records `wakeSuppressed: { reason: 'own-command', parentRef }`.
The watcher skips its wake, while `wait` continues to return it. The command
result includes the event sequence and the exact acknowledgement command.

A command that crashes before printing has not acknowledged anything. Another
process completing a lane without the parent context leaves the wake enabled.
Observation repairs a completed journal's missing event with the same operation
fingerprint. The two-minute correlation window applies only to idle and
turn-completed observations after interrupt. Correlation never acknowledges an
event.
Two guards keep a continuous observer from racing the parent's own commands.
A spawn journal still in a pre-dispatch state (`planned`, `seatReady`,
`dispatching`, `providerRequestDispatched`, `providerCreated`) is left alone
while its launching process is alive, or for five minutes when no launcher
is recorded; the crash repair exists for a launcher that died. A retirement
passing through its transient states raises attention only after two
minutes without progress, which is what a crashed retirement looks like.
A spawn that fails before it reserves a lane settles its own dispatch as
`failed` and records one terminal `child.failed` event (reason
`spawn-not-registered`); a dispatch left `reserved` with no lane by a
spawn that died is settled the same way five minutes after its creation,
after a single attention event at thirty seconds.

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
- `children` and `parent-list` report the wake channel and whether the
  watcher is running; `maintain` counts unacknowledged events across every
  parent as `unattendedChildren`.
- The watcher writes only to the parent's own recorded session or thread,
  never to any other, and every message is the fixed template above.
- A wake the channel refused is retried on the next rounds up to three
  times; a wake that may have landed is never resent. The durable event
  remains either way.

## Cost model

What consumes model usage: only the parent's turns. Each wake re-invokes the
parent's model once (a Claude Code parent through a peer message, a Codex
parent through a turn on its own thread), and each `wait` that returns does
the same. The watcher, the observation reads, and the wake delivery consume
no model tokens on either side: they are a Node process, provider reads
(`thread/read`, `thread/turns/list`, the Claude census and transcript), and
one message write. A child is never made to do more work by being observed.

What consumes machine time, measured on 2026-09-03 with the pinned CLIs: a
Claude runtime measurement (two digests of the 199 MB CLI plus two CLI
calls) about 0.5 s; one Claude census (`claude agents --json --all`) about
0.3 s; one Codex read (a fresh loopback connection plus two calls) well
under 0.1 s; one registry or journal read about 20 ms. The levers, all in
place: one wake per round instead of one per event; the parent's own
completed commands suppressing redundant wakes when parent association is verified; polling only while a child
is working, with idle children read on the parent's nudge; settled children skipped after their terminal events are recorded and acknowledged; a short idle exit; one runtime measurement and one census per
round instead of per child (`lib/observer-cache.js`, the memo follows the
CLI file and ages out after ten minutes), and one shared loopback
connection per round for Codex reads; a subscription to the app-server's
own notifications (`thread/status/changed`, `turn/started`,
`turn/completed`, `item/completed`, `thread/archived`) that makes the
watcher read an outstanding Codex child the moment the runtime reports a
change, while polling stays as the safety net. A Claude child spawned for a parent
carries session hooks (through the CLI's `--settings`, a private file per
lane under the state root) whose only action is to touch the parent's
watcher nudge file when its turn ends, its session ends, or it raises a
notification, so the watcher reads it at once and never polls it while it
works or waits; verified live on the pinned CLI on 2026-09-03 (`Stop`,
`SessionEnd`, and `UserPromptSubmit` fired through `--settings`).
`TRANSMOGRIFY_CHILD_HOOKS=off` launches children without hooks.

## Receipts and open experiments

Verified: the Claude peer follow-up reaches a Remote-Control session
(adapter steering, live since 0.2); a session's own bridge id is readable
from `~/.claude/sessions/<pid>.json` (under `CLAUDE_CONFIG_DIR` when set) of
the ancestor `claude` process;
`turn/start` on an idle Codex thread starts a turn the model processes and
Desktop renders (the `recover --input` path, live in every 0.3 smoke);
`turn/steer` reaches an in-progress turn (live since 0.2); the app-server
pushes `thread/status/changed` and `turn/completed` to any connected
client; raw `thread/list` rows carry `cwd` and `status`.

Also verified live on 2026-09-03, on a disposable Codex probe on the shared
runtime: a shell command's full command line appears in the thread's
`commandExecution` items, so the `parent-init` invocation is an exact
receipt for the thread running it; `CODEX_THREAD_ID` is visible to commands a
turn runs (`env | grep -c CODEX_THREAD_ID` printed 1), so a Codex parent
learns its own thread id without any listing heuristic; a `turn/steer` sent
with a `clientUserMessageId` lands as a `userMessage` item carrying that id;
and a wake follow-up sent to a Claude Code session's own bridge arrived in
that session as a peer message, even though the sending command's own
acknowledgement timed out (the watcher records such a wake as uncertain and
never resends it; the durable event remains). The only unverified direction
is a Codex host acting as the parent end to end, which needs a Codex-hosted
session to run `parent-init` and `spawn`; its mechanisms (thread id, command
receipt, `turn/start` and `turn/steer` into an owned thread) are each
verified individually.
