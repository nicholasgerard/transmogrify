# Onboarding: one paste, everywhere it lands

A brief, specification, and implementation plan for the next wave. It is
written to be executed by a coding agent with the repository open; every
section names the files it touches and the tests that prove it.

## The problem, from a first-time user

On 2026-09-03 a first-time user pasted the start prompt into Claude Code
and, before anything ran, was asked four things in maintainer vocabulary:

1. "The doctor wants the pinned Claude CLI 2.1.258, but you have 2.1.259
   installed. Downgrading affects the CLI this session runs on." The
   offered fix was `claude install 2.1.258`: a downgrade of the very CLI
   the session was running on, for a newer patch release that almost
   certainly works.
2. "No Codex app-server is listening on 8843. Should I start one? Your
   codex-cli is 0.148.0 vs the pinned 0.151.x, so this may not clear the
   pin." The user was asked to authorize a step the assistant itself
   expected to fail.
3. "Codex Desktop is running but not attached to the runtime. Attaching
   requires quitting and relaunching it, ending whatever it's currently
   doing." Correct, but with no explanation of what attachment is for or
   what happens if they decline.
4. The words `runtime-up.sh`, `pin`, `app-server`, `8843`, and a process
   id, none of which mean anything to someone who pasted one line.

Root causes, all in this tree:

- **Exact pins instead of compatibility ranges.** The Claude adapter
  accepts one CLI build, by version and SHA-256
  (`VERIFIED_CLI_BUILDS` in `scripts/lib/claude-surface.js`); anything
  else is `cli-unpinned` and the doctor's owner action says to install
  that one build. The Codex client accepts one minor line by user-agent
  regex (`/0\.151\./` in `scripts/lib/app-server.js`, echoed by
  `scripts/runtime-probe.js`); an older CLI on `PATH` is refused and a
  newer one would be too.
- **The doctor speaks to maintainers.** `setup.ownerActions[]` names
  scripts, flags, and ports. It has no user-facing summary, no ordering,
  and no reasons.
- **The start handoff assumes a Desktop host and installs one host.**
  `site/scripts/build-start.mjs` selects `codex` or `claude`, installs
  that target only, and never asks where the prompt landed (a terminal, an
  IDE agent, a Desktop app).
- **Nothing installs what is missing.** A machine without one of the CLIs,
  or without a sign-in, gets an owner action and stops.
- **The attach question is asked without teaching.** Attachment is the
  feature that makes Codex lanes stream live in the app; declining is
  fine and has a named fallback, but the prompt says neither.

## Goals

In the owner's words, distilled:

- It should always just work. Detect what the machine has and what it can
  do; use the CLIs already installed when they are compatible; when
  something must be installed, signed in, started, or restarted, walk the
  user through it and get the permission it needs, one step at a time.
- One install makes every host on the machine ready. Installing from
  Codex must leave Claude Desktop ready the next time it opens, and the
  other way round.
- Wherever the prompt is pasted, it works or says clearly why not: a
  Claude Code or Codex terminal session sets everything up and tells the
  user this is built for the desktop apps; Cursor (and other IDE agents)
  install everything and send the user to Claude Desktop or the ChatGPT
  app, saying that Cursor support is not available yet.
- No internal narration. Discover quietly, then describe what was found
  and what happens next in plain words, and explain why a step is needed
  when the user asks.

Not goals: GUI automation as a control channel; touching a runtime or lane
this installation does not own; downgrading the CLI a session runs on;
Cursor as a supported host in this wave.

## The experience, by where the prompt lands

| Landing context | Detected by | What happens |
| --- | --- | --- |
| Claude Code inside Claude Desktop | `CLAUDECODE` in the environment and a `Claude.app` ancestor of the CLI process | Full setup for both hosts; Codex Desktop attach offered with the reason; Claude lanes and Codex lanes both available. |
| Claude Code in a terminal (TUI) | `CLAUDECODE`, terminal ancestor (`Terminal.app`, iTerm, tmux, ssh) | Same setup; one sentence up front: this is built for the desktop apps, live streaming shows there, everything else works here. |
| Codex Desktop (ChatGPT.app) | `CODEX_THREAD_ID` plus the app's private runtime (`hostedByDesktop` in `lib/desktop-attach.js`) | Full setup for both hosts; never relaunch the app from inside it; Claude lanes available; Codex children through the app's own collaboration or a runtime the owner attaches from outside. |
| Codex TUI in a terminal | `CODEX_THREAD_ID` without the Desktop ancestry | Same as the Claude TUI row. |
| Cursor, VS Code, other IDE agents | `TERM_PROGRAM=cursor` / `vscode`, `CURSOR_*`, a `Cursor.app` or `Code.app` ancestor | Install both hosts, verify the CLIs, then say: open Claude Desktop or the ChatGPT app and run the skill there; Cursor support is not available yet. No lane work from this context. |
| A plain shell (the user ran a command) | none of the above | Install, doctor, and the same summary; point to the desktop apps. |
| Unsupported machine (not Apple Silicon macOS, for Claude lanes) | `process.platform`/`arch` | Say so once, in plain words, and what still works (Codex lanes protocol-only). |

The user hears the same four things in every context, in this order and in
this language: what was found, what is ready, what is needed and why, and
what will happen next. Ids, ports, script names, and error codes stay out
of the conversation unless the user asks.

## Specification

### 1. Compatibility by range and measurement, not by pin

Claude Code CLI:

- A supported range replaces the single build: a minimum version
  (`2.1.258`, the oldest build whose `-p --cloud` acknowledgement,
  `--settings` hooks, and `agents --json --all` shape are known) and no
  maximum. A build above the minimum is **measured** once, not refused:
  `--version`, `auth status --json`, `agents --json --all`, the follow-up
  acknowledgement shape (dry, against no session), and `--settings`
  acceptance are probed, and the result is recorded under the state root
  keyed by the binary's path and SHA-256 (`measured-builds/<sha>.json`).
  A measured build behaves exactly like today's verified build; a build
  that fails a probe is `cli-unsupported` with the failing probe named.
  `VERIFIED_CLI_BUILDS` stays as the pre-measured fast path.
- The CLI a session runs on is never downgraded. If it is below the
  minimum, the owner action is to upgrade (through the CLI's own
  installer), never to install an older build.
- `cli-unpinned` disappears from the doctor's vocabulary.

Codex app-server:

- A minimum line replaces the exact line: user agents at `0.151` or newer
  are accepted after the initialize handshake, and the methods this tree
  relies on (`thread/list` with `sourceKinds`, `thread/turns/list` with
  `sortDirection`, `turn/steer` with `clientUserMessageId`,
  `thread/name/set`, `thread/archive`) are probed once per runtime
  version and cached the same way. A runtime below the minimum, or one
  that fails a probe, is `runtime-unsupported` with the reason.
- The doctor knows every Codex binary on the machine: `PATH`, Codex
  Desktop's bundled CLI (the app ships its own `codex`, at `0.153` today
  when `PATH` had `0.148`), and `TRANSMOGRIFY_BIN`. `runtime-up.sh`
  launches the newest supported one and says which it used.

### 2. Host context detection

New `scripts/lib/host-context.js`: `detectHostContext(env, dependencies)`
returns `{ app, surface, platform, tools, cliBinaries }` where `app` is one
of `claude-desktop`, `claude-code-terminal`, `codex-desktop`, `codex-tui`,
`cursor`, `vscode`, `shell`, and `surface` is `desktop`, `terminal`, or
`ide`. Detection reads only environment variables and the process
ancestry (the same `ps` walk `lib/wake.js` uses), never window titles or
GUI state. Every branch has a test with a fake ancestry and environment.

### 3. The doctor explains

`doctor.js --explain` (and `setup.plan` in the JSON) adds, beside the
existing machine-readable result, an ordered plan of steps with, for each:
`what` (one plain sentence), `why` (one sentence), `consent` (`none`,
`install`, `sign-in`, `start-runtime`, `relaunch-desktop`), and the exact
command Transmogrify will run. The plan is computed for both hosts at
once, from the host context, so "install from Codex and be ready in Claude
Desktop" is one plan. `docs/OUTPUT.md` documents the shape; the schema
test covers it.

### 4. Guided setup

**Implemented for 0.6.** `scripts/setup.js` and `transmogrify.js setup` now
execute the measured plan through fixed injected runners, print each reason
before consent, and rerun the doctor after every completed step. Dry runs and
the refusal paths are covered without invoking a live installer, sign-in,
runtime, or Desktop action.

New `scripts/setup.js` (also `transmogrify.js setup`): runs the doctor's
plan step by step. Each step that needs consent is executed only with its
explicit flag (`--install-claude-cli`, `--install-codex-cli`,
`--sign-in`, `--start-runtime`, `--relaunch-desktop`, `--persist-attach`) or
an interactive yes when a TTY is present; the agent asks the user one step at
a time with the `why` text. Installation uses the vendors' documented
standalone installers, verified from their official docs on 2026-09-04;
sign-in uses `claude auth login` and `codex login` and waits for the user. The
runtime uses `ensurePreferredRuntime`, and Desktop attachment uses
`desktop-attach.js ensure --relaunch-desktop` and `persist`. Setup never
modifies the CLI hosting the current session, never adopts a foreign runtime,
and reruns the doctor after each step so the summary is always measured, never
assumed.

### 5. One install for the whole machine

**Implemented for 0.6.** The default installer still targets both skill roots
and now ends with the readiness and next-session handoff in plain words.

`install.sh` installs both hosts by default already; the start handoff
must stop selecting one. The state root, the runtime, the parent contexts,
and the child hooks are shared. After setup, the summary says what is
ready in each app and that a new session in the other app picks it up
without more work (a skill installed under `~/.claude/skills` and
`~/.agents/skills` is loaded by the next session of each host).

### 6. The start handoff

`site/scripts/build-start.mjs` is rewritten around the flow above:
fetch and verify the release (unchanged), install both hosts, run
`doctor --explain`, then follow the narration rules. It carries the
context-specific sentences (terminal notice, IDE agent notice, unsupported
machine notice) verbatim so every agent says the same thing.

### 7. Narration rules

Written once in `SKILL.md` section 1 and repeated in the handoff:

- Run the checks before saying anything. Then one short block: found,
  ready, needed, next.
- One question at a time, with its reason. Never ask the user to authorize
  a step the plan already knows will fail.
- Plain words: "the Codex app is not connected to the shared runtime, so
  new lanes would not show up in it; connecting means restarting the app,
  which ends what it is doing now", not `DESKTOP_RELAUNCH_REQUIRED`.
- Explain on request. Ids, paths, ports, and codes are available when the
  user asks, and in the JSON.

## Implementation plan

| Step | Files | Tests |
| --- | --- | --- |
| 1. Compatibility policy | `scripts/lib/claude-surface.js` (range + `measureCliBuild`), `scripts/lib/app-server.js` (minimum line + method probe), `scripts/runtime-probe.js`, `scripts/doctor.js` (`cli-unsupported`, `runtime-unsupported`, measured-build cache) | surface and app-server tests for the range logic and the cache; doctor tests for the new reasons; a test that the CLI hosting the session is never proposed for downgrade |
| 2. Host context | `scripts/lib/host-context.js` | one test per row of the context table with fake env and ancestry |
| 3. Doctor plan | `scripts/doctor.js` (`--explain`, `setup.plan`), `scripts/lib/output-schema.js`, `docs/OUTPUT.md` | golden plans for the states in the acceptance matrix |
| 4. Guided setup | `scripts/setup.js`, `scripts/transmogrify.js`, `scripts/runtime-up.sh` (binary selection), `scripts/lib/desktop-attach.js` (reasons in plain words) | setup tests with injected installers and a fake TTY; refusal tests (foreign runtime, session's own CLI) |
| 5. Start handoff and docs | `site/scripts/build-start.mjs`, `site/src/lib/start-prompt.ts`, `SKILL.md` section 1, `README.md` install and quick start, `docs/TROUBLESHOOTING.md` | `site/test/build-start.test.ts` for each context sentence; the SKILL token budget check |
| 6. Acceptance | `ROADMAP.md` run record | the matrix below, run with fakes in CI and once for real with the owner on a machine that has never seen Transmogrify |

Order matters: 1 removes the false blockers, 2 and 3 make the doctor able
to say what to do, 4 makes it able to do it, 5 makes every landing context
say the same thing.

Acceptance matrix (each row is a golden test of the plan and the words):

| Machine state | Expected |
| --- | --- |
| Fresh Apple Silicon Mac, no CLIs | plan: install Claude Code, sign in, install Codex CLI, sign in, start runtime; summary names both apps |
| Claude CLI newer than the minimum | measured, no action, no mention of versions |
| Claude CLI older than the minimum, hosting the session | one action: upgrade through the CLI installer; never a downgrade |
| Codex CLI on PATH below the minimum, Desktop bundles a supported one | runtime starts from the bundled CLI; summary says which |
| Runtime absent | one consent question with the reason; started detached |
| Codex Desktop running, unattached, from a Claude host | one consent question that explains streaming and the restart; on no, protocol-only with that said |
| Codex Desktop host | no relaunch offered; alternatives named |
| Terminal session (either provider) | the terminal notice, then full setup |
| Cursor or VS Code | install both, verify, the IDE notice, no lane work |
| Not Apple Silicon macOS | the unsupported notice; Codex protocol-only offered |

## Effort and risks

About a week of agent time across the six steps, most of it in steps 1 and
4. Risks: vendor installers and version strings change (mitigated by
measuring instead of pinning, and by reading the official install
commands at implementation time); a newer CLI could change the follow-up
acknowledgement or hook behavior (mitigated by the measured-build probes,
which are the same checks that caught the 2.1.258 acknowledgement change);
Desktop's bundled CLI may not support `app-server --listen` on every
version (probe before use).

## Open questions for the owner

- Which install path to recommend for each CLI when it is missing (the
  vendor's shell installer, Homebrew, npm), and whether Transmogrify may
  run it with consent or should only print it.
- The minimum supported versions to start from: `2.1.258` for Claude Code
  and `0.151` for the Codex app-server are proposed.
- Whether an IDE agent context should also offer to open the desktop app
  for the user, or only tell them where to go.
