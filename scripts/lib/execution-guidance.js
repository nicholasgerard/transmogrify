'use strict';

// Frozen, documentation-derived execution guidance: what each intent, effort,
// speed, setting, and model is for, and which model and effort a neutral intent
// resolves to per provider. It is data only, with no I/O and no behavior; the
// profile resolver still validates everything here against a live or pinned
// catalog. Guidance never maps an intent to premium Fast.

const GUIDANCE_VERSION = '2026-09-05';

// Operator-facing descriptions surfaced by the capabilities command. These are
// advice, not constraints: the catalog decides what is actually selectable.
const INTENT_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: 'provider-default',
    intent: 'provider-default',
    label: 'Provider default',
    useWhen: 'No deliberate model or effort choice is needed; preserve those provider defaults while keeping Standard speed.',
  }),
  Object.freeze({
    id: 'fast-loop',
    intent: 'fast-loop',
    label: 'Fast loop',
    useWhen: 'Short, well-bounded edits, searches, formatting, and rapid interactive iteration.',
  }),
  Object.freeze({
    id: 'balanced',
    intent: 'balanced',
    label: 'Balanced',
    useWhen: 'Everyday implementation, review, and debugging where speed and depth both matter.',
  }),
  Object.freeze({
    id: 'deep',
    intent: 'deep',
    label: 'Deep',
    useWhen: 'Complex debugging, architecture, migrations, or ambiguous work that benefits from more reasoning.',
  }),
  Object.freeze({
    id: 'max-quality',
    intent: 'max-quality',
    label: 'Maximum quality',
    useWhen: 'The hardest bounded work where answer quality matters more than latency or token use.',
  }),
]);

const EFFORT_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: 'low',
    effort: 'low',
    useWhen: 'The task is quick, well scoped, and easy to verify.',
  }),
  Object.freeze({
    id: 'medium',
    effort: 'medium',
    useWhen: 'The task needs ordinary planning and checking without deep exploration.',
  }),
  Object.freeze({
    id: 'high',
    effort: 'high',
    useWhen: 'The task is difficult or multi-step and benefits from more analysis and checking.',
  }),
  Object.freeze({
    id: 'xhigh',
    effort: 'xhigh',
    useWhen: 'The task has substantial ambiguity, risk, or tradeoffs and quality matters more than latency.',
  }),
  Object.freeze({
    id: 'max',
    effort: 'max',
    useWhen: 'The hardest bounded single-agent work justifies the greatest supported reasoning depth.',
  }),
]);

const SPEED_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: 'standard',
    speed: 'standard',
    useWhen: 'Use by default, especially for autonomous, long-running, or cost-sensitive work.',
  }),
  Object.freeze({
    id: 'fast',
    speed: 'fast',
    useWhen: 'Use only when lower latency justifies the provider premium; it never changes model quality by itself.',
  }),
]);

const CLAUDE_EXECUTION_SETTING_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: 'ultracode',
    setting: 'ultracode',
    label: 'Ultracode',
    resolvedEffort: 'xhigh',
    useWhen: 'A substantive task benefits from repeatable multi-agent orchestration and the extra time and token use are justified.',
  }),
]);

const CODEX_MODEL_DESCRIPTORS = Object.freeze([
  Object.freeze({
    selector: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    useWhen: 'Complex, ambiguous, or high-value work needs the strongest reasoning and the runtime offers it.',
  }),
  Object.freeze({
    selector: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    useWhen: 'Complex, open-ended, ambiguous, difficult, or high-value work needs the strongest analysis and polish.',
  }),
  Object.freeze({
    selector: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    useWhen: 'Everyday implementation and review need strong reasoning and tool use without Sol\'s full depth.',
  }),
  Object.freeze({
    selector: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    useWhen: 'Clear, repeatable, high-volume work has an explicit definition of done.',
  }),
  Object.freeze({
    selector: 'gpt-5.5',
    label: 'GPT-5.5',
    useWhen: 'Compatibility with the proven previous generation matters more than using the current GPT-5.6 family.',
  }),
  Object.freeze({
    selector: 'gpt-5.3-codex-spark',
    label: 'GPT-5.3 Codex Spark',
    useWhen: 'Near-instant text-only coding iteration is more important than maximum capability and the account has access.',
  }),
]);

const CLAUDE_MODEL_DESCRIPTORS = Object.freeze([
  Object.freeze({
    selector: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    useWhen: 'Demanding reasoning or long-horizon agentic work still falls short on Opus 5 at higher effort.',
  }),
  Object.freeze({
    selector: 'claude-fable-5',
    label: 'Claude Fable 5',
    useWhen: 'A workload explicitly requires the previous Fable generation; otherwise prefer Fable 5.1.',
  }),
  Object.freeze({
    selector: 'claude-opus-5',
    label: 'Claude Opus 5',
    useWhen: 'Complex agentic coding and enterprise work need the recommended general starting point.',
  }),
  Object.freeze({
    selector: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    useWhen: 'A workload explicitly requires Opus 4.8 compatibility or its documented Fast support.',
  }),
  Object.freeze({
    selector: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    useWhen: 'A workload explicitly requires Opus 4.7 compatibility; otherwise prefer Opus 5.',
  }),
  Object.freeze({
    selector: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    useWhen: 'A workload explicitly requires Opus 4.6 compatibility and can use its reduced effort set.',
  }),
  Object.freeze({
    selector: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    useWhen: 'Everyday work benefits from the best balance of speed and intelligence.',
  }),
  Object.freeze({
    selector: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    useWhen: 'A workload explicitly requires Sonnet 4.6 compatibility; otherwise prefer Sonnet 5.',
  }),
  Object.freeze({
    selector: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    useWhen: 'Simple, high-volume, latency-sensitive work has clear checks and does not need configurable effort.',
  }),
]);

// The Codex intent-to-selection mapping consumed by profile resolution, plus the
// provider values Standard and Fast compile to.
const CODEX_GUIDANCE = Object.freeze({
  provider: 'codex',
  source: Object.freeze({
    kind: 'official-guidance',
    version: GUIDANCE_VERSION,
    documentation: 'https://learn.chatgpt.com/docs/models',
  }),
  intents: Object.freeze({
    'fast-loop': Object.freeze({ models: Object.freeze(['gpt-5.6-luna']), effort: 'low' }),
    balanced: Object.freeze({ models: Object.freeze(['gpt-5.6-terra']), effort: 'medium' }),
    deep: Object.freeze({
      models: Object.freeze(['gpt-6-astra', 'gpt-5.6-sol']),
      effort: 'high',
    }),
    'max-quality': Object.freeze({
      models: Object.freeze(['gpt-6-astra', 'gpt-5.6-sol']),
      effort: 'max',
    }),
  }),
  speeds: Object.freeze({ standard: 'default', fast: 'priority' }),
});

// The Claude intent-to-selection mapping. It declares no speed mapping, because
// Claude Fast is model-specific and comes from the pinned catalog.
const CLAUDE_GUIDANCE = Object.freeze({
  provider: 'claude',
  source: Object.freeze({
    kind: 'official-guidance',
    version: GUIDANCE_VERSION,
    documentation: 'https://code.claude.com/docs/en/model-config',
  }),
  intents: Object.freeze({
    'fast-loop': Object.freeze({ model: 'claude-haiku-4-5-20251001' }),
    balanced: Object.freeze({ model: 'claude-sonnet-5', effort: 'medium' }),
    deep: Object.freeze({ model: 'claude-opus-5', effort: 'high' }),
    'max-quality': Object.freeze({ model: 'claude-opus-5', effort: 'max' }),
  }),
});

// The published selection guide for Codex: model, effort, and speed descriptions
// with their documentation sources.
const CODEX_SELECTION_GUIDE = Object.freeze({
  version: GUIDANCE_VERSION,
  provider: 'codex',
  models: CODEX_MODEL_DESCRIPTORS,
  efforts: Object.freeze([
    ...EFFORT_DESCRIPTORS,
    Object.freeze({
      id: 'ultra',
      effort: 'ultra',
      useWhen: 'The hardest high-value work justifies the strongest available reasoning even though it costs the most.',
    }),
  ]),
  executionSettings: Object.freeze([]),
  speeds: SPEED_DESCRIPTORS,
  sources: Object.freeze([
    'https://learn.chatgpt.com/docs/models',
    'https://learn.chatgpt.com/docs/agent-configuration/speed',
  ]),
});

// The published selection guide for Claude. Its constraints record the measured
// boundaries, including that account availability is only proven at launch.
const CLAUDE_SELECTION_GUIDE = Object.freeze({
  version: GUIDANCE_VERSION,
  provider: 'claude',
  models: CLAUDE_MODEL_DESCRIPTORS,
  efforts: EFFORT_DESCRIPTORS,
  executionSettings: CLAUDE_EXECUTION_SETTING_DESCRIPTORS,
  speeds: SPEED_DESCRIPTORS,
  constraints: Object.freeze([
    'Fable may require usage credits; unattended execution can pause for consent and end when unanswered.',
    'Neutral intents do not select Fable implicitly; request it explicitly only when its usage-credit and consent behavior is acceptable.',
    'Fast is explicit and model-specific; this verified matrix enables it only for Opus 5 and Opus 4.8.',
    'Ultracode is an explicit execution setting, not an effort level; it resolves to xhigh plus automatic dynamic-workflow planning.',
    'Ultracode is accepted only with an xhigh-capable catalog model; workflow availability still depends on the authenticated plan and configuration.',
    'Anthropic can apply documented model or speed fallback for safety, availability, or rate limits; effective execution remains unobserved without a provider receipt.',
    'Aliases are accepted as requests but resolve to a versioned selector before launch and recovery.',
    'Account and organization availability is verified by the provider at launch, not inferred from documentation.',
  ]),
  sources: Object.freeze([
    'https://code.claude.com/docs/en/model-config',
    'https://code.claude.com/docs/en/fast-mode',
    'https://code.claude.com/docs/en/workflows',
    'https://code.claude.com/docs/en/settings-reference',
    'https://platform.claude.com/docs/en/models/overview',
  ]),
});

// The resolver guidance for a provider; an unknown provider throws.
function guidanceFor(provider) {
  if (provider === 'codex') return CODEX_GUIDANCE;
  if (provider === 'claude') return CLAUDE_GUIDANCE;
  throw new Error(`unsupported execution guidance provider: ${provider}`);
}

// The published selection guide for a provider; an unknown provider throws.
function selectionGuideFor(provider) {
  if (provider === 'codex') return CODEX_SELECTION_GUIDE;
  if (provider === 'claude') return CLAUDE_SELECTION_GUIDE;
  throw new Error(`unsupported execution selection guide provider: ${provider}`);
}

module.exports = {
  CLAUDE_GUIDANCE,
  CLAUDE_EXECUTION_SETTING_DESCRIPTORS,
  CLAUDE_SELECTION_GUIDE,
  CODEX_GUIDANCE,
  CODEX_SELECTION_GUIDE,
  EFFORT_DESCRIPTORS,
  GUIDANCE_VERSION,
  INTENT_DESCRIPTORS,
  SPEED_DESCRIPTORS,
  guidanceFor,
  selectionGuideFor,
};
