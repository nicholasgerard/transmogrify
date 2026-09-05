'use strict';

const EFFORT_DESCRIPTIONS = Object.freeze({
  low: 'Fast responses with lighter reasoning.',
  medium: 'Balanced reasoning for everyday work.',
  high: 'Deeper reasoning for difficult work.',
  xhigh: 'Extra-high reasoning for complex work.',
  max: 'Maximum reasoning for the hardest work.',
  ultra: 'Highest-cost reasoning for exceptional work.',
});

const PRIORITY_TIER = Object.freeze({
  id: 'priority',
  name: 'Fast',
  description: '2x speed, increased usage',
});

function modelRow({
  model, displayName, efforts, defaultEffort, isDefault = false,
  fast = true, upgrade = null,
}) {
  return {
    id: model,
    model,
    upgrade,
    upgradeInfo: null,
    availabilityNux: null,
    displayName,
    description: `${displayName} execution model.`,
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: EFFORT_DESCRIPTIONS[reasoningEffort],
    })),
    defaultReasoningEffort: defaultEffort,
    inputModalities: ['text', 'image'],
    supportsPersonality: true,
    multiAgentVersion: null,
    additionalSpeedTiers: fast ? [{ id: 'fast', serviceTier: PRIORITY_TIER }] : [],
    serviceTiers: fast ? [PRIORITY_TIER] : [],
    defaultServiceTier: null,
    isDefault,
  };
}

function stableModels({ astra }) {
  return [
    ...(astra ? [modelRow({
      model: 'gpt-6-astra',
      displayName: 'GPT-6-Astra',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultEffort: 'medium',
      isDefault: true,
    })] : []),
    modelRow({
      model: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultEffort: 'medium',
      isDefault: !astra,
    }),
    modelRow({
      model: 'gpt-5.6-terra',
      displayName: 'GPT-5.6 Terra',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultEffort: 'medium',
    }),
    modelRow({
      model: 'gpt-5.6-luna',
      displayName: 'GPT-5.6 Luna',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium',
    }),
    modelRow({
      model: 'gpt-5.5',
      displayName: 'GPT-5.5',
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'medium',
    }),
    modelRow({
      model: 'gpt-5.4-mini',
      displayName: 'GPT-5.4 Mini',
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'medium',
      fast: false,
      upgrade: 'gpt-5.6-luna',
    }),
    modelRow({
      model: 'gpt-5.3-codex-spark',
      displayName: 'GPT-5.3 Codex Spark',
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'medium',
      fast: false,
    }),
  ];
}

function measuredCodexModelList01510() {
  return { data: stableModels({ astra: false }), nextCursor: null };
}

function measuredCodexModelList01534() {
  return { data: stableModels({ astra: true }), nextCursor: null };
}

module.exports = {
  measuredCodexModelList01510,
  measuredCodexModelList01534,
};
