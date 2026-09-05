# Contributing

## Development setup

Fork the repository, create a focused branch, and install the locked dependency
set without lifecycle scripts:

```bash
npm ci --ignore-scripts
```

Open an issue before changing a private provider surface, persistent identity,
compatibility pin, or public lifecycle contract. Keep pull requests narrow and
state their compatibility impact. Contributions are submitted under the
project's [MIT License](LICENSE).

## Community expectations

Participation is governed by the project
[Code of Conduct](CODE_OF_CONDUCT.md). Report sensitive conduct matters to
[support@thebkapp.co](mailto:support@thebkapp.co); use the project's private
vulnerability form only for security defects. Never put credentials, private
transcripts, session identifiers, or another person's private provider data in
a public report.

Every protocol or provider behavior claim must carry one of these receipts:

- a named generated schema definition;
- a dated live verification against an exact runtime/build tuple; or
- an explicit `unverified` label.

## Protocol changes

For Codex app-server changes:

1. Generate fresh schemas with `codex app-server generate-json-schema --out …`.
2. Cite the exact generated definition in `docs/PROTOCOL.md`.
3. Use only a named disposable probe created for the check.
4. Archive the probe immediately and verify the archive result.

For Claude Code changes:

1. Prefer Anthropic's public CLI, Desktop, Remote Control, or Agent SDK contract.
2. Record the exact CLI/Desktop/platform tuple for any measured local surface.
3. Test public CLI compatibility at the measured minimum and on newer builds.
   Keep the private archive tuple separate from public lifecycle support.
4. Fail closed on a changed lane executable, worker, socket, transcript,
   account, or private-response identity.
5. Never log credentials or add an automatic trust-enrollment flow.

## Code

- Keep tools independently runnable and zero-framework.
- `ws` is the only allowed operator runtime dependency. Website build
  dependencies stay isolated under `site/` and never enter the installed skill.
- Reserve ownership and seat intent before provider mutation.
- Distinguish confirmed, not-delivered, and unknown outcomes.
- Never replay an unknown mutation; add an observational reconciliation path.
- Never select a mutation target by name, cwd, age, or short ID alone.
- Require a durable harvest receipt before retirement.
- Remove only clean, unchanged operator-managed seats after harvest; preserve
  external or ambiguous seats.
- Keep routine CLI errors free of credentials, private paths, raw provider rows,
  and unrelated IDs.

## Verification

Run:

```bash
npm test
find scripts -name '*.js' -print0 | xargs -0 -n1 node --check
bash -n scripts/*.sh install.sh
git diff --check
npm pack --dry-run

cd site
npm ci
npm run check
npm test
TRANSMOGRIFY_RELEASE_COMMIT=1111111111111111111111111111111111111111 npm run build
npm run verify
```

The package is private and Git checkout is the supported distribution path.
Treat `npm pack --dry-run` as an unintended-file audit, not as verification of a
self-installing npm artifact.

The synthetic release commit exercises the generated handoff without installing
it or claiming a published release. Run these checks on the host: socket and
process-inspection tests cannot complete in a restricted lane. Report each
unavailable check; a partial sandbox pass does not replace host acceptance.

Provider integration probes require authorization from the owner of the machine
and runtime being tested. Never start, stop,
restart, or reconfigure a shared runtime. Read-only checks and mutations of one
explicitly named disposable session created by the probe are allowed; no probe
may steer, stop, archive, remove, or otherwise touch a session it did not
create.

## Skill and docs

`SKILL.md` is executable policy for operators. Keep it imperative, generic, and
parameterized. Put wire-level claims in `docs/PROTOCOL.md`, Claude-specific
surface facts in `docs/CLAUDE-CODE.md`, and forward work in `ROADMAP.md`.
Repository-specific merge, deployment, review, and budget policy belongs in the
host repository's skill. `test/public-docs.test.js` budgets skill bytes and words
so operational context stays bounded. The example handback uses the real harvest
parser. Output documentation tests check keys inside their operation sections,
and site workflow tests follow the start generator's root source inputs.
Tests of consumers must call the real producer with fakes at the process or
provider boundary; do not hand-write the producer's result.

## Pull requests and releases

Describe the receipt type for every behavior claim, the checks run, whether a
live probe was authorized, and any compatibility impact. Do not include
provider IDs, private paths, credentials, transcripts, or unrelated runtime
state in an issue or pull request.

Transmogrify follows semantic versioning. Breaking changes to the installed skill,
host-parameter table, durable state, provider identity, or CLI contract require
a versioned migration. The 0.6.1 release requires the acceptance gate in
[ROADMAP.md](ROADMAP.md), including the fresh-machine pass. That page records
the dated 0.6.0 exception and the cases still awaiting live verification.

Before publishing a release, a maintainer also confirms that the public GitHub
repository retains its description, homepage, topics, Discussions, private
vulnerability reporting, secret scanning, and push-protection configuration,
and that the deployed `/start` document pins the exact published commit.
