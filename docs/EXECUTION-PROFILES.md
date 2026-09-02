# Execution profiles

Transmogrify selects model, effort, speed, and provider execution settings
through one provider-neutral request. Each adapter compiles that request
against its own measured or documented capability catalog before it reserves a
lane or calls the provider.
Unsupported combinations fail closed; Transmogrify never silently substitutes
another profile. A provider can still apply its own documented native fallback;
that effective result remains unobserved unless the provider returns a receipt.

Use the live capability command before choosing an explicit override:

```bash
node "$SKILL_ROOT/scripts/lane.js" capabilities --target codex
node "$SKILL_ROOT/scripts/lane.js" capabilities --target claude
```

The result contains the exact catalog, task-oriented selection guide, supported
efforts, speeds, execution settings, evidence source, and whether availability
was actually observed. Codex availability comes from the connected runtime.
Claude's matrix is documented compatibility; the authenticated account,
organization, plan, and configuration make the final availability decision at
launch.

## Request contract

`lane.js spawn` accepts four execution fields:

| Field | Values | Behavior |
| --- | --- | --- |
| `--intent` | `provider-default`, `fast-loop`, `balanced`, `deep`, `max-quality` | Applies the current task-oriented provider mapping. |
| `--model` | Provider selector | Overrides the intent's model. It must resolve through the provider catalog. |
| `--effort` | Model-supported effort; Claude also accepts `ultracode` | Overrides the intent or documented model default. On Claude, `ultracode` is shorthand for the Ultracode execution setting, not a model effort. |
| `--speed` | `standard`, `fast` | Defaults to Standard. Fast must be explicit and supported by the selected model. |

Omitting `--intent` means `provider-default`. Explicit model and effort values
override an intent independently. Speed is never selected by an intent; Fast
always requires `--speed fast`.

Claude's `--effort ultracode` spelling follows the native CLI, but the receipt
decomposes it into `requested.setting: "ultracode"` and resolved effort
`xhigh`. This keeps model reasoning separate from provider orchestration.

Examples:

```bash
# Recommended everyday profile for the target provider.
node "$SKILL_ROOT/scripts/lane.js" spawn \
  --repo-root "$REPO_ROOT" --target codex --name 'implement feature' \
  --parent-context-file "$PARENT_CONTEXT" --intent balanced \
  --allow-protocol-only \
  --input-file /absolute/path/to/prompt.md

# Exact quality-first Claude profile at Standard speed.
node "$SKILL_ROOT/scripts/lane.js" spawn \
  --repo-root "$REPO_ROOT" --target claude --name 'adversarial review' \
  --parent-context-file "$PARENT_CONTEXT" \
  --model claude-opus-5 --effort max --speed standard \
  --input-file /absolute/path/to/prompt.md

# Claude dynamic-workflow orchestration at its required xhigh effort.
node "$SKILL_ROOT/scripts/lane.js" spawn \
  --repo-root "$REPO_ROOT" --target claude --name 'repository-wide audit' \
  --parent-context-file "$PARENT_CONTEXT" \
  --model claude-opus-5 --effort ultracode --speed standard \
  --input-file /absolute/path/to/prompt.md
```

## Provider-neutral intents

Intents are recommendations, not claims that two providers are equivalent.
They are versioned guidance and are stored in each lane's resolved receipt.

| Intent | Use when | Codex mapping | Claude mapping |
| --- | --- | --- | --- |
| `provider-default` | No deliberate model or effort choice is needed; speed remains Standard. | Runtime default model plus its advertised default effort. | Preserve the Claude host's model and effort defaults. |
| `fast-loop` | Work is short, clear, repetitive, and easy to verify. | GPT-5.6 Luna, Low | Claude Haiku 4.5, no effort selector |
| `balanced` | Everyday implementation, review, and debugging. | GPT-5.6 Terra, Medium | Claude Sonnet 5, Medium |
| `deep` | Architecture, ambiguous debugging, migrations, or consequential analysis. | GPT-5.6 Sol, High | Claude Opus 5, High |
| `max-quality` | The hardest bounded single-agent work justifies maximum reasoning. | GPT-5.6 Sol, Max | Claude Opus 5, Max |

All five mappings use Standard speed unless the caller explicitly requests
Fast. Use the lowest effort that passes representative checks. Max is for the
hardest bounded work, not a routine default. No intent enables a provider
execution setting implicitly.

## Effort guidance

Effort names are provider controls, not portable quality guarantees. Select the
lowest level that reliably passes the task's checks, then move up only when the
work's ambiguity or consequence warrants it.

| Effort | Use when |
| --- | --- |
| `low` | The task is quick, well scoped, and easy to verify. |
| `medium` | Ordinary planning and checking are useful, but deep exploration is not. |
| `high` | Difficult or multi-step work benefits from more analysis and verification. |
| `xhigh` | Ambiguity, risk, or tradeoffs are substantial and quality matters more than latency. |
| `max` | The hardest bounded single-agent work justifies the greatest supported reasoning depth. |
| `ultra` | Codex only, when the live catalog advertises it and the work genuinely divides into independent parts; this is multi-agent execution, not just deeper reasoning. |

## Execution-setting guidance

Execution settings change how a provider organizes work around a model. They
are separate from model effort and remain provider-specific even though the
profile catalog and receipt shape are extensible.

| Setting | Provider | Resolved effort | Use when |
| --- | --- | --- | --- |
| `ultracode` | Claude Code | `xhigh` | A substantive task benefits from a repeatable dynamic workflow across many subagents, and the additional time and token use are justified. |

Ultracode asks Claude to plan a workflow for each substantive task. It can run
several workflows in sequence and therefore typically costs more time and
tokens than ordinary `xhigh`. Prefer a normal effort for routine work, a small
single edit, or a task that does not divide meaningfully. Dynamic workflows
must be enabled for the authenticated plan and configuration; otherwise the
native CLI documents that `--effort ultracode` runs at `xhigh` without workflow
orchestration. Transmogrify records the setting it sent but does not claim that
a workflow ran without a provider receipt.

## Receipts: requested, resolved, observed

An execution profile has three deliberately separate layers:

- `requested` is the caller's immutable input, including whether speed was
  explicit. Claude's native `ultracode` shorthand is normalized into a distinct
  execution setting rather than stored as a model effort.
- `resolved` is the exact selector and native control Transmogrify compiled
  against a named catalog and guidance revision.
- `observed` contains only fields the provider explicitly reported for this
  lane. Missing evidence remains `null`.

Resolved is not synonymous with observed. A successful request proves that the
adapter sent a selector; it does not prove the provider honored an unavailable
setting, account-dependent alias, or temporary delivery tier. Profiles are
persisted before provider mutation and are immutable lane identity.

When an explicit alias such as Claude's `opus` is accepted, `requested` keeps
the alias while `resolved.model.selector` stores the catalog's versioned model
ID. Spawn and recovery use that versioned selector so an alias cannot silently
move an existing lane to a newer model.

## Codex

The Codex adapter fully paginates `model/list` and validates each model's
`supportedReasoningEfforts`, `defaultReasoningEffort`, service tiers, hidden
flag, default flag, and upgrade metadata. A hidden, retired, or upgrade-only
row is not selectable even when the runtime still lists it.

The built-in recommendation guide is:

| Selector | Model | Best fit |
| --- | --- | --- |
| `gpt-5.6-sol` | GPT-5.6 Sol | Complex, open-ended, ambiguous, difficult, or high-value work needing the strongest analysis and polish. |
| `gpt-5.6-terra` | GPT-5.6 Terra | Everyday implementation and review needing strong reasoning and tool use. |
| `gpt-5.6-luna` | GPT-5.6 Luna | Clear, repeatable, high-volume work with an explicit definition of done. |
| `gpt-5.5` | GPT-5.5 | Work that explicitly needs previous-generation compatibility. |
| `gpt-5.3-codex-spark` | GPT-5.3 Codex Spark | Near-instant text-only coding iteration when the account has access and lower capability is acceptable. |

The live runtime remains authoritative. The verified app-server `0.151.0`
catalog on 2026-09-02 exposed:

- Sol, Terra, and Luna: `low`, `medium`, `high`, `xhigh`, `max`; Sol and Terra
  also exposed `ultra`.
- GPT-5.5 and Spark: `low`, `medium`, `high`, `xhigh`.
- Fast (`priority`) for Sol, Terra, Luna, and GPT-5.5; no Fast tier for Spark.
- GPT-5.4 rows with upgrade and retirement metadata. Transmogrify refuses them.

`ultra` is provider-specific multi-agent execution rather than simply deeper
single-agent reasoning. Use it only when the live catalog advertises it and the
work genuinely divides into independent parts. The neutral intents never
select it implicitly.

### Codex Standard and Fast

The generated `0.151.0` schema permits persistent `serviceTier` on
`thread/start` and `thread/resume`, plus `serviceTier` and the turn-only
`serviceTierForTurn` on `turn/start`. Its generated description identifies
turn-only `serviceTierForTurn: "default"` as Standard. Transmogrify compiles:

| Speed | Native control |
| --- | --- |
| Standard | `serviceTier: "default"` |
| Fast | `serviceTier: "priority"` |

The adapter sets the persistent tier at thread creation and resume and reapplies
both persistent and turn-only controls at every new turn boundary. Supplying
the persistent `"default"` value is an implementation policy; the generated
schema types that field but does not define its semantics. The explicit policy
prevents an ambient Fast host preference from turning a Standard lane into
premium execution after its first turn. A contradictory tier in a provider
response is refused as `EXECUTION_PROFILE_UNSUPPORTED`; after `thread/start`
it surfaces as a partial-success stop rather than a new turn.

OpenAI describes Fast as the same model at lower latency with increased credit
use. Prefer Standard for autonomous, long-running, or cost-sensitive work; use
Fast only when interactive latency justifies the premium.

Sources: [Codex model guidance](https://learn.chatgpt.com/docs/models),
[Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed), and
[app-server reference](https://learn.chatgpt.com/docs/app-server).

## Claude Code

Claude model compatibility combines official model documentation with the
locally pinned Claude Code CLI `2.1.258` interface. The CLI executable's SHA-256
is verified during preflight and immediately before provider mutation. The CLI
help on 2026-09-02 exposed `--model`,
`--effort low|medium|high|xhigh|max`, and `--settings`; it exposed no separate
`--speed` flag. Although that help text omits `ultracode` from its effort-value
list, the pinned parser accepts `claude --effort ultracode` and Anthropic's
current documentation specifies that route for CLI v2.1.203 and later.

| Selector | Alias | Model | Effort | Fast | Ultracode | Best fit |
| --- | --- | --- | --- | --- | --- | --- |
| `claude-fable-5-1` | `fable` | Claude Fable 5.1 | Low through Max | No | Yes | Demanding reasoning and long-horizon work after Opus at higher effort is inadequate. |
| `claude-fable-5` | — | Claude Fable 5 | Low through Max | No | Yes | Explicit previous-generation compatibility. |
| `claude-opus-5` | `opus` | Claude Opus 5 | Low through Max | Yes | Yes | Complex agentic coding and the general quality-first starting point. |
| `claude-opus-4-8` | — | Claude Opus 4.8 | Low through Max | Yes | Yes | Explicit 4.8 compatibility, including its documented Fast support. |
| `claude-opus-4-7` | — | Claude Opus 4.7 | Low through Max | No | Yes | Explicit 4.7 compatibility. |
| `claude-opus-4-6` | — | Claude Opus 4.6 | Low, Medium, High, Max | No | No | Explicit 4.6 compatibility with its reduced effort set. |
| `claude-sonnet-5` | `sonnet` | Claude Sonnet 5 | Low through Max | No | Yes | Everyday work needing the best speed/intelligence balance. |
| `claude-sonnet-4-6` | — | Claude Sonnet 4.6 | Low, Medium, High, Max | No | No | Explicit 4.6 compatibility with its reduced effort set. |
| `claude-haiku-4-5-20251001` | `haiku` | Claude Haiku 4.5 | No effort selector | No | No | Simple, high-volume, latency-sensitive work with clear checks. |

Unknown selectors, special selectors such as `[1m]`, and provider-dependent
aliases such as `best`, `default`, or `opusplan` are outside this pinned adapter
until their exact native-app behavior is receipted. They fail before mutation.
Account or organization policy may still reject a documented model at launch.
When an explicit model has no effort override, Transmogrify uses the documented
model default: High for every effort-capable model except Opus 4.7, whose
default is Extra High. `provider-default` leaves both model and effort to the
host instead.

Fable may require usage credits. Anthropic documents that an unattended
background or Remote Control session can wait for consent and end its turn when
that consent is not supplied. Choose Fable deliberately and treat a consent
wait as a parent-attention event. The neutral intents intentionally do not
select Fable without an explicit model request because that choice can require
additional credits and consent.

### Claude Ultracode

Anthropic defines Ultracode as a Claude Code execution setting, not a sixth
reasoning-effort level. It combines `xhigh` model effort with automatic dynamic
workflow planning for each substantive task. Transmogrify accepts the native
spelling `--effort ultracode`, requires an explicit catalog-resolved model that
supports `xhigh`, and compiles the setting back to the pinned CLI as:

```text
--model <versioned-xhigh-capable-selector> --effort ultracode
```

The execution profile records resolved effort `xhigh` separately from the
native `claude-effort-flag: ultracode` control. Haiku 4.5, Opus 4.6, Sonnet
4.6, unknown selectors, and unverified CLI versions fail before provider
mutation. The pinned `2.1.258` parser accepted the flag on 2026-09-02; the
version gate also reflects Anthropic's documented minimum of `2.1.203` by
refusing every unpinned version until it is re-verified.

Ultracode does not prove that dynamic workflows are available. Anthropic
documents that workflows depend on plan and configuration, and that Ultracode
falls back to `xhigh`-only execution when workflows are disabled. Check Claude
Code's `/config` and `/workflows` surfaces when a workflow receipt matters.

### Claude Standard and Fast

The adapter compiles speed into an explicit settings override:

| Speed | Native control |
| --- | --- |
| Standard | `--settings '{"fastMode":false}'` |
| Fast | `--settings '{"fastMode":true}'` |

Fast is enabled only for Opus 5 and Opus 4.8 in the verified matrix. Anthropic
describes it as the same model quality at lower latency and higher cost. The
resolved setting is reapplied on exact-session recovery. The adapter does not
claim effective Fast execution unless a provider receipt establishes it.
Anthropic may fall back from Fast to Standard when Fast is unavailable or rate
limited, and may select a model fallback for safety or availability. Those are
provider-native behaviors, not Transmogrify substitutions. Until Claude exposes
an effective execution receipt, the profile records what was requested and sent
rather than claiming what the provider ultimately ran.

Sources: [Claude Code model configuration](https://code.claude.com/docs/en/model-config),
[Claude Code Fast mode](https://code.claude.com/docs/en/fast-mode),
[Claude Code dynamic workflows](https://code.claude.com/docs/en/workflows),
[Claude Code settings reference](https://code.claude.com/docs/en/settings-reference),
[Claude Code CLI](https://code.claude.com/docs/en/cli-usage), and
[Claude models](https://platform.claude.com/docs/en/models/overview).

## Recovery

Recovery never re-resolves an old lane through a rolling alias or current
intent mapping. It reloads the immutable resolved profile and reapplies every
selector accepted at that provider boundary:

- Codex reapplies model and persistent service tier on `thread/resume`, then
  model, effort, persistent tier, and turn-only tier on `turn/start`.
- Claude reapplies the versioned model selector, effort or Ultracode execution
  setting, and explicit Fast setting on `--resume <exact-session> --bg`.

If current capabilities no longer validate a supplied profile for a new lane,
spawn fails. Existing lanes retain their original receipt; migration to another
model is an explicit future operation, never an automatic recovery side effect.

## Future provider adapter contract

The profile core is provider-neutral. A future adapter supplies:

1. A versioned capability catalog with model IDs, accepted selectors and
   aliases, lifecycle state, supported efforts, execution-setting definitions,
   speed compatibility, host-default behavior, and an evidence source.
2. Versioned intent guidance mapping the neutral intents to that catalog.
3. Compilers from provider-neutral dimensions and provider-specific execution
   settings to exact typed native controls.
4. A pre-mutation capability check and immutable requested/resolved receipt.
5. A recovery compiler that preserves the same resolved identity.
6. Conservative observation rules: only provider-emitted facts enter
   `observed`.

A future provider may use RPC fields, CLI flags, SDK options, or a native host
tool. Transport symmetry is unnecessary; lifecycle and receipt semantics are
required.

## Deliberate boundaries

- Transmogrify performs no automatic fallback to another model, effort, speed,
  execution setting, or provider. Provider-native fallback can still occur
  where the provider documents it; it must not be represented as observed
  without a receipt.
- There is no generic price or token-budget policy in the current profile
  schema. The host operator owns budget authorization; Fast remains explicit.
- Context-window selectors and provider-specific planning aliases remain
  rejected until the pinned adapter has exercised them. Claude Ultracode is
  accepted only through its typed setting path on a pinned CLI and an explicit
  xhigh-capable catalog model.
- Model descriptions guide dispatch; live capabilities and exact provider
  receipts decide what is supported.
