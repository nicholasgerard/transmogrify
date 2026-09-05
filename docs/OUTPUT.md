# Output contract

Every Transmogrify command prints one JSON document. A success goes to stdout
and carries `version`, `ok: true`, and `operation`; a failure goes to stderr
with `ok: false`, a stable `code`, a fixed `message`, and, for lane
operations, a `delivery` projection (`confirmed`, `notDelivered`, `unknown`,
`notAttempted`) with an `effect` breakdown. Exit codes are shared by every
command: 0 confirmed, 2 usage error or safe refusal, 3 failure or uncertain
outcome, 1 unexpected internal error.

Success output is an allowlist. The keys below are the only keys a result may
carry; a value the schema does not name is dropped before printing, so a
provider handle, a path, or a transcript fragment can never reach output by
being added to an internal result. Surviving strings are redacted of bearer
tokens, provider session ids, and credential-shaped pairs. The same contract
is available as data from `lane.js schema`, and a test keeps this page and
that command in agreement.

Subtrees that carry provider-advertised metadata keep every key:
`catalog`, `guidance`, `intents`, `selectionGuide`, `executionProfile`,
`requestedProfile`, `resolvedProfile`, `observedProfile`.

## Phases

`status` reports one `phase` vocabulary for every provider and keeps the
provider's own word in `providerPhase`.

| `phase` | Codex `providerPhase` | Claude `providerPhase` | Meaning |
| --- | --- | --- | --- |
| `executing` | `executing` | `working` | a turn is in progress |
| `waiting` | | `waiting` | blocked on user input or approval |
| `idle` | `idle`, `interrupted`, `notLoaded` | `idle` | no turn is active |
| `stopped` | | `stopped`, `retiring` | the whole session was stopped |
| `failed` | `failed` | | the newest turn or the thread failed |
| `retired` | | `retired` | archived and its seat released |
| `unknown` | `unknown` | `unknown` | no recognizable status |

Parent events and durable observations keep the 0.2 vocabulary
(`working`, `waiting`, `idle`, `stopped`, `failed`).

## Lane envelope

Every lane-bound operation (`spawn`, `status`, `steer`, `interrupt`, `stop`,
`recover`, `retire`) shares: `version`, `ok`, `operation`, `operationId`,
`laneId`, `adapter`, `state`, `phase`, `providerPhase`, `capabilities`,
`visibility`, `receipt`, `delivery`.

- `capabilities`: `midTurnSteer`, `interrupt`, `retirement`, `recovery`,
  `approvalRelay` (Codex); `steering`, `stop`, `cancelTurnOnly`,
  `recovery`, `retirement`, `nativePresentation`, `approvalRelay` (Claude).
- `visibility` (Codex): `surface`, `state`, `attachment`, and a `receipt`
  with `runtimeUrl`, `evidence`, `connection`, `observedAt`, `bundleId`,
  `desktopVersion`, `desktopBuild`, `buildTested`, `clientPid`.

The read-only `desktop-attach.js check` receipt includes `runtimeUrl`,
`runtimeSource`, and the explicit boolean `persisted`. `persisted:true` means
the selected endpoint is a live relay, `launchctl getenv
CODEX_APP_SERVER_WS_URL` equals that relay URL, and
`~/Library/LaunchAgents/sh.transmogrify.attach.plist` exists; any missing or
unreadable evidence is `false`. An attached relay receipt also includes
`attachment.relay.url` and `attachment.relay.socketPath`. The doctor's
`nativeVisibility` copies `persisted` as the same boolean for guided setup.

Relay helper records include `origin`, either `launched` or `adopted`; a legacy
record may omit it and is interpreted as adopted. A successful `persist` result
adds `persistence.phase: applied`. `apply-persisted` adds
`environmentChanged`, which is true only when it set a previously unset login
value. Persistence refusals may report `currentValue`, `plannedValue`, and
`appliedValue` so the owner can see what would be replaced.

## Operations

### `setup`

The guided setup runner reports `dryRun`, `ready`, the doctor's current
`plan`, `completed` step receipts, and an `apps` summary for Claude Desktop
and the ChatGPT app. Each completed receipt contains only `what`, `consent`,
and `outcome`. When setup stops safely, `code`, `message`, and `refusal`
identify the pending step and one plain reason such as `consent-required`,
`hosting-cli-protected`, `foreign-runtime`, or `manual-action-required`.

The `plan` remains measured rather than inferred: setup reruns the doctor after
every action. `apps.nextSession` explains that a new session in the other app
picks up the machine-wide installation. `--dry-run` returns this shape without
running an installer, sign-in, runtime ensure, attachment, or persistence step.

### `spawn`

Lane envelope plus `watcher` (`running`, `started`, `pid`) and `nextAction`,
the sentence telling the parent how it will learn about this child.
`exchange` carries the absolute worktree-local `packet` and `handback` paths.
`receipt`: `acknowledgedBy`, `inputReceiptSource`, `completedStatus`,
`presentation`, `requestedModelSelector`, `bridgeIdSha256`,
`executionProfile`.

### `status`

Lane envelope plus `turn` (`status`), `rawState` (`type`, `activeFlags`),
`waiting`. `receipt`: `exactSession`, `executionEpoch`, `durableLifecycle`,
`providerInspectionDeferred`.

### `steer`

Lane envelope. `receipt`: `mode`, `observation`, `observedAtOffset`,
`deliveryTokenSha256` (Claude); `expectedTurnId`, `turnId` (Codex, the turn
the steer was addressed to and the turn the runtime confirmed).

### `interrupt`

Lane envelope. `receipt`: `reconciled`.

### `stop`

Lane envelope. `receipt`: `mode`, `alreadyStopped`.

### `recover`

Lane envelope. `receipt`: `acknowledgedBy`, `inputReceiptSource` (Codex
boundary resume); `sameSessionId`, `sameJobId`, `sameBridgeId`,
`executionEpoch`, `presentation` (Claude).

### `harvest`

`operationId`, `laneId`, `adapter`, `handback` (`present` or `missing`),
`changedFiles` (seat-relative paths excluding recorded provisions and the
exchange directory), `head`, `handbackSha256`, and `retireCommand`. A missing
handback has a null digest and retire command. A present handback is copied to
the private harvest store before the journal completes.

### `retire`

Lane envelope. `receipt`: `archived`, `alreadyRetired`, `worktreeRemoved`,
`reconciled`, `retired`, `harvestedOutputSha256`, `remoteArchived`,
`localJobRemoved`, `localRemovalDeferred`, `provider` (`unbound`, `stop`,
`archive`, `localRemoval`), `worktree` (`attempted`, `removed`, `deferred`,
`blocked`).

### `reconcile`

One shape for both adapters: `adapter`, `results`, `receipt`
(`providerConnection`: `notRequired` or `verified`). Each entry: `laneId`,
`state`, `phase`, `providerPhase`, `outcome`, `delivery` (`confirmed`,
`notDelivered`, or `unknown`), `repaired`, `pendingOperation` (the open
journal's type, or `null`), `code`, `causeCode`, `ownerAction`, `error`
(`code`).

### `abandon`

`laneId`, `providerOutcome`, `lane` (`laneId`, `state`, `backend`),
`abandoned` (`operationId`, `type`, `fromState`, `reason`, `at`),
`delivery` (`providerMutation`).

### `capabilities`

`target`, `intents`, `selectionGuide`, `availability` (`kind`, `observed`,
`note`), `guidance`, `catalog`.

### `parent-init`

`parentRef`, `contextFile`, `hostProvider`, `hostApp`, `displayName`,
`wake` (`channel`: `claude-bridge`, `codex-thread`, or `none`; `source`, the
verification receipt kind; `reason` when none). The channel id itself is
never printed.

### `parent-list`

`parents`: `parentRef`, `contextFile`, `hostProvider`, `hostApp`,
`displayName`, `createdAt`, `wake`, `watcher` (`running` or `stopped`),
`children`, `unacknowledgedEvents`.

### `children`

`parentRef`, `wake`, `watcher`, `unacknowledgedEvents`, `children`: `dispatchId`, `laneId`,
`target`, `displayName`, `state`, `phase` (with `--observe`),
`laneObservation`, `createdAt`, `unacknowledgedEvents`, `latestEventType`,
`latestEventKind`, `requestedProfile`, `resolvedProfile`, `observedProfile`.

### `wait`

`until` (the threshold that was waited for), `events`: `schemaVersion`,
`sequence`, `parentRef`, `dispatchId`, `type`, `kind` (`progress`,
`complete`, `attention`, `terminal`), `terminal`, `observationFingerprint`,
`occurredAt`, `eventId`, `child` (`provider`, `laneId`, `projectKey`),
`data` (`state`, `status`). `observed`: `dispatchId`, `laneId`, `phase`,
`eventType` for every child this call observed. `observerErrors`:
`dispatchId`, `code`.

### `ack`

`eventId`, `acknowledgedAt`, `acknowledged`, `count` (with `--event`); `through`,
`acknowledged` (the ids acknowledged), `count` (with `--through`).

### `schema`

`operations`, `phases`, `providerPhases`, `schemas`: this contract as data.

### `watch`

`outcome` (`started`, `alreadyRunning`, `running`, `stopped`, `notRunning`,
`idleExit`, `parentContextGone`, `signalled`, `roundsExhausted`), `pid`,
`rounds`, `wakes`.

### `maintain`

The bounded maintenance runner. `dryRun`, `providers` (`codex`, `claude`,
each `available`, `reconciled`, `results`, `notOk`, `skipped`, and `code`
when a reconcile threw), `counts`
(`ownedActive`, `ownedStopped`, `pendingOperations`, `pendingRetirements`,
`cleanupBlocked`, `unattendedChildren`), `setup` (the doctor's own setup
block: `ready`, `ownerActions`, and optional `plan`). No provider id, lane id,
name, or path ever appears in this output.

## Doctor explanation

`doctor.js --explain` adds `setup.plan`. The plan has `context`, a sentence
for the current terminal, IDE, or unsupported host when one applies, and
ordered `steps`. Every step has `what`, `why`, `consent`, and `command`.
`consent` is one of `none`, `install`, `sign-in`, `start-runtime`,
`relaunch-desktop`, or `persist-attach`. The existing `setup.ownerActions`
remain unchanged beside the plan. On a terminal, the doctor also prints a
short `Found`, `Ready`, `Needed`, `Next` summary before the JSON document.
The doctor adds `persist-attach` only after Codex Desktop attachment is
verified and its receipt explicitly reports `persisted: false`. Older or
partial receipts with no `persisted` field do not imply that action.

With `--retention`, the result carries `retention` instead of
`providers`/`counts`/`setup`: `dryRun`, `keepDays`, `keepBackups`,
`operations`, `events`, `backups` (each `candidates`, `moved`), and
`trashDir`. Retention only moves matter into a recoverable trash directory;
it never unlinks anything. Backup counts include only entries with a valid
owner-only installer receipt.

### `doctor`

The doctor is a separate read-only JSON report rather than a lane output-schema
operation. Its top level carries `version`, `ok`, `mode`,
`providerMutationsAttempted`, `registry`, `providers`, `setup`, and
`nextSafeMaintenanceCommands`.

Each provider reports `requested`, `available`, `reusable`, `reuse`, `probe`,
the supported or pre-measured compatibility receipt in `pinned`, and a bounded
`observed` block. Claude's observed block adds `buildMeasurement` (`result`,
`source`, `measuredAt`) and `agentListReadable`. Codex's observed block adds
`compatibility`, `compatibleMethods`, and `failingMethod` when present. Codex
also reports `cliBinaries`; each entry contains an executable `path`, discovery
`sources` (`PATH`, `codex-desktop`, or `TRANSMOGRIFY_BIN`), and the parsed
`version` or `null`. Those binaries are invoked only with `--version`.

An unavailable provider has an `error.code` and `setup`. Setup carries
`reason`, `blocking`, and `ownerAction`; `cli-unmeasured-failed` additionally
names `failingProbe`, and `runtime-unsupported` names `failingMethod`.
`setup.ownerActions` aggregates the user actions without provider-private
details. Claude versions below `2.1.258` use `cli-unsupported`; a failed newer
build measurement uses `cli-unmeasured-failed`. Codex versions or methods that
do not meet the runtime contract use `runtime-unsupported`.

## Failure envelope

`version`, `ok: false`, `code`, `message`, and optional `details` limited to:
`alreadyStopped`, `archive`, `attempted`, `causeCode`, `causeMessage`,
`cleanup`, `code`, `copiesStopped`, `correlatedCopies`, `delivery`,
`dispatchId`, `exactSession`, `executionEpoch`, `failures`, `httpStatus`,
`laneId`, `localRemoval`, `operationId`, `outcome`, `ownerAction`,
`pendingState`, `pendingType`, `phase`, `presentation`, `providerMutation`,
`providerRetired`, `queued`, `removed`, `state`, `stop`. Lane operations add
`delivery` and `effect`. Usage errors keep their own text; every other code
prints the fixed message from `scripts/lib/public-error.js`.
