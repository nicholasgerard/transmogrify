# Onboarding: one paste, everywhere it lands

The start prompt has to work wherever it is pasted: a desktop app, a terminal
session, an IDE agent, or a plain shell. This document is the contract behind
that, as implemented in 0.6.0 and hardened in 0.6.1. The fresh-machine live
acceptance pass is still outstanding; see the recorded exceptions and the
retained release gate in
[ROADMAP.md](../ROADMAP.md#release-gate-and-recorded-exceptions).

## Goals

- It should always just work. Detect what the machine has and what it can
  do; use the CLIs already installed when they are compatible; when
  something must be installed, signed in, started, or restarted, walk the
  user through it and get the permission it needs, one step at a time.
- One install makes every host on the machine ready. Installing from
  Codex must leave Claude Desktop ready the next time it opens, and the
  other way round.
- Wherever the prompt is pasted, it works or says clearly why not: a
  Claude Code or Codex terminal session sets everything up and tells the
  user this is built for the desktop apps; Cursor and other IDE agents
  install everything and send the user to Claude Desktop or the ChatGPT
  app, saying that Cursor support is not available yet.
- No internal narration. Discover quietly, then describe what was found
  and what happens next in plain words, and explain why a step is needed
  when the user asks.

Not goals: GUI automation as a control channel; touching a runtime or lane
this installation does not own; downgrading the CLI a session runs on;
Cursor as a supported host.

## The experience, by where the prompt lands

| Landing context | Detected by | What happens |
| --- | --- | --- |
| Claude Code inside Claude Desktop | `CLAUDECODE` in the environment and a `Claude.app` native executable or helper ancestor whose bundle identifier is `com.anthropic.claudefordesktop` | Full setup for both hosts; Codex Desktop attach offered with the reason; Claude lanes and Codex lanes both available. |
| Claude Code in a terminal (TUI) | `CLAUDECODE`, terminal ancestor (`Terminal.app`, iTerm, tmux, ssh) | Same setup; one sentence up front: this is built for the desktop apps, live streaming shows there, everything else works here. |
| Codex Desktop (ChatGPT.app) | Codex session markers and verified Desktop bundle ancestry; attachment is measured separately | Full setup for both hosts; never relaunch the app from inside it; Claude lanes available; managed Codex children when the app is already attached, otherwise native collaboration or attachment from outside. |
| Codex TUI in a terminal | `CODEX_THREAD_ID` without the Desktop ancestry | Same as the Claude TUI row. |
| Cursor, VS Code, other IDE agents | `TERM_PROGRAM=cursor` / `vscode`, `CURSOR_*`, a `Cursor.app` or `Code.app` ancestor | Install both hosts, verify the CLIs, then say: open Claude Desktop or the ChatGPT app and run the skill there; Cursor support is not available yet. No lane work from this context. |
| A plain shell (the user ran a command) | none of the above | Install, doctor, and the same summary; point to the desktop apps. |
| Unsupported machine (not Apple Silicon macOS, for Claude lanes) | `process.platform`/`arch` | Say so once, in plain words, and what still works (Codex lanes protocol-only). |

The user hears the same four things in every context, in this order and in
this language: what was found, what is ready, what is needed and why, and
what will happen next. Ids, ports, script names, and error codes stay out
of the conversation unless the user asks.

## The contract

### 1. Compatibility by range and measurement, not by pin

Claude Code CLI:

- A supported range replaces the single build: a minimum version
  (`2.1.258`, the oldest build whose `-p --cloud` acknowledgement,
  `--settings` hooks, and `agents --json --all` shape are known) and no
  maximum. A build above the minimum is **measured** once, not refused.
  Version, auth-status JSON, and agent-list JSON are vendor observations.
  Help checks prove only that `--settings` and the follow-up options are
  accepted. The acknowledgment parser runs against Transmogrify's own fixture,
  which is not vendor evidence; live steering still requires an exact vendor
  acknowledgment and transcript receipt. The result is recorded under the
  state root keyed by the binary's path and SHA-256
  (`measured-builds/<sha>.json`).
  Passing measurement admits public lifecycle operations, which still require
  exact account, config, and execution identity receipts. A failed newer build
  is `cli-unmeasured-failed` with the failing probe named. The private archive
  path separately requires the exact pinned CLI hash and Desktop tuple.
  `VERIFIED_CLI_BUILDS` is the pre-measured fast path.
- The CLI a session runs on is never downgraded. If it is below the
  minimum, the owner action is to upgrade (through the CLI's own
  installer), never to install an older build.
- The doctor reports below-minimum versions as `cli-unsupported`.

Codex app-server:

- The minimum is `0.151.0`. After initialization the doctor reads `thread/list`
  with `sourceKinds` and validates its shape. It probes `turn/steer`,
  `thread/name/set`, and `thread/archive` against the nil thread ID only,
  requiring exact measured not-found responses. `thread/turns/list` remains
  unmeasured until a successful exact-owned read. No probe steers or archives a
  real session. Compatibility receipts are cached by probe set and runtime
  version; failed results expire after 24 hours.
- The doctor inventories Codex executables on `PATH`, the bundled CLI at
  `/Applications/ChatGPT.app/Contents/Resources/codex`, and `TRANSMOGRIFY_BIN`
  by reading `--version`. Other bundle locations require an explicit binary
  selection until the doctor consumes the broader app inventory. When the
  runtime is unavailable, it reads `login status` on the selected supported
  binary. The plan names the newest supported measured binary for runtime
  startup.
- Runtime startup prefers the managed daemon and a loopback relay for Desktop,
  with an explicit standalone fallback. A reusable runtime is not replaced.
  Desktop persistence uses an owner-only transaction receipt, preserves foreign
  settings, and rolls back partial writes. Across-login and mobile-restart
  behavior still requires the live acceptance pass.

The doctor may initialize the local registry and write local compatibility
receipts. Its provider reads, nil-ID probes, process inspection, and Desktop
attachment checks are not an initialize-only handshake.

### 2. Host context detection

`scripts/lib/host-context.js`: `detectHostContext(env, dependencies)`
returns `{ app, surface, platform, tools, cliBinaries }` where `app` is one
of `claude-desktop`, `claude-code-terminal`, `codex-desktop`, `codex-tui`,
`cursor`, `vscode`, `shell`, and `surface` is `desktop`, `terminal`, or
`ide`. Detection reads environment variables, process ancestry, and verified app
bundle identifiers, never window titles or GUI state. Relocated and per-user
app bundles are recognized for host context. The module exports their bundled
CLI paths, but the doctor's default CLI candidates do not yet consume that
inventory. `test/host-context.test.js` covers these cases with fake ancestry,
environment, and bundle metadata.

### 3. The doctor explains

`doctor.js --explain` (and `setup.plan` in the JSON) adds, beside the
existing machine-readable result, an ordered plan of steps with, for each:
`action` (a fixed setup operation), `what` (one plain sentence), `why` (one
sentence that states the benefit and what remains if declined), `consent`
(`none`, `install`, `sign-in`, `start-runtime`, `relaunch-desktop`, or
`persist-attach`), and the exact command Transmogrify will run. Runtime-start
steps name the supported Codex binary the doctor measured. The plan is
computed for both hosts at once, from the host context, so "install from
Codex and be ready in Claude Desktop" is one plan. `docs/OUTPUT.md` documents
the shape; the schema test covers it.

### 4. Guided setup

`scripts/setup.js` (also `transmogrify.js setup`) runs the doctor's plan step
by step through fixed injected runners, prints each reason before consent, and
reruns the doctor after every completed step so the summary is always
measured, never assumed. A non-interactive invocation runs exactly the first
step and returns the newly measured plan. Each step that needs consent is
executed only with its explicit flag (`--install-claude-cli`,
`--install-codex-cli`, `--sign-in`, `--start-runtime`, `--relaunch-desktop`,
`--persist-attach`) or an interactive yes when a TTY is present; the agent
asks the user one step at a time with the `why` text. Installation uses the
vendors' documented standalone installers, verified from their official docs
on 2026-09-04; sign-in uses `claude auth login` and `codex login` and waits
for the user. The runtime uses `ensurePreferredRuntime` with the binary named
by the plan; a compatible runtime that wins the launch race is reused after
the doctor verifies it. Opening a stopped Desktop uses `desktop-attach.js
ensure --launch-only`; relaunch uses `ensure --relaunch-desktop`; persistence
uses `persist --authorize`. Setup never modifies the CLI hosting the current
session. Dry runs and the refusal paths are covered without invoking a live
installer, sign-in, runtime, or Desktop action.

### 5. One install for the whole machine

`install.sh` and the start handoff install both hosts by default. The state
root, the runtime, the parent contexts, and the child hooks are shared. After
setup, the summary says what is ready in each app and that a new session in
the other app picks it up. The structured result reports `ready`,
`ready-with-limitations`, `needs-action`, or `unsupported` across requested
providers that this platform supports, with one status for each provider. A
skill installed under `~/.claude/skills` and `~/.agents/skills` is loaded by
the next session of each host without more work.

### 6. The start handoff

`site/scripts/build-start.mjs` generates `/start` around the flow above:
fetch and verify the release, install both hosts, run `doctor --explain`, then
follow the narration rules. It carries the context-specific sentences
(terminal notice, IDE agent notice, unsupported machine notice) verbatim so
every agent says the same thing.

### 7. Narration rules

These rules appear in both `SKILL.md` section 1 and the generated start
handoff:

- Run the checks before saying anything. Then one short block: found,
  ready, needed, next.
- One question at a time, with its reason. Never ask the user to authorize
  a step the plan already knows will fail.
- Plain words: "the Codex app is not connected to the shared runtime, so
  new lanes would not show up in it; connecting means restarting the app,
  which ends what it is doing now", not `DESKTOP_RELAUNCH_REQUIRED`.
- Explain on request. Ids, paths, ports, and codes are available when the
  user asks, and in the JSON.

## Acceptance matrix

Expected behavior is covered by `test/setup-plan.test.js`, `test/setup.test.js`,
`test/doctor.test.js`, `test/host-context.test.js`, and
`site/test/build-start.test.ts` with process and provider fakes. The dated
[run records](../ROADMAP.md#historical-run-records-2026-09-03-through-2026-09-04)
identify the few rows exercised live. This table is not a fresh-machine receipt.

| Machine state | Expected |
| --- | --- |
| Fresh Apple Silicon Mac, no CLIs | plan: install Claude Code, sign in, install Codex CLI, sign in, start runtime; summary names both apps |
| Claude CLI newer than the minimum | measured, no action, no mention of versions |
| Claude CLI older than the minimum, hosting the session | manual upgrade guidance; guided setup protects the hosting executable and never downgrades it |
| Codex CLI on PATH below the minimum, Desktop bundles a supported one | runtime starts from the bundled CLI; summary says which |
| Runtime absent | one consent question with the reason; started detached |
| Codex Desktop running, unattached, from a Claude host | one consent question that explains streaming and the restart; on no, protocol-only with that said |
| Codex Desktop host | no relaunch offered; alternatives named |
| Terminal session (either provider) | the terminal notice, then full setup |
| Cursor or VS Code | install both, verify, the IDE notice, no lane work |
| Not Apple Silicon macOS | the unsupported notice; Codex protocol-only offered |

## History

On 2026-09-03 a first-time user pasted the start prompt into Claude Code and,
before anything ran, was asked in maintainer vocabulary to downgrade the CLI
the session was running on to an exact pinned build, to authorize a runtime
start the assistant expected to fail, and to relaunch the Codex app with no
explanation of what attachment was for. The causes were exact pins instead of
compatibility ranges, a doctor that spoke only in scripts and ports, a start
handoff that assumed a Desktop host and installed one host, nothing that
installed what was missing, and an attach question asked without teaching.
The contract above replaced each of those: minimums plus measurement, host
context detection, the explaining doctor, guided setup with one consent at a
time, one install for both hosts, and narration rules shared by the skill and
the handoff.

Continuing risks: vendor installers and version strings change (mitigated by
measuring instead of pinning); a newer CLI could change the follow-up
acknowledgement or hook behavior (measurement checks option acceptance, while
actual steering fails closed on the vendor acknowledgment and transcript); and
the Desktop's bundled CLI may not support `app-server --listen` on every
version, so it is probed before use.
