'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CLAUDE_EFFORTS,
  CLAUDE_EXECUTION_SETTINGS,
  ExecutionProfileError,
  INTENTS,
  catalogFromCodexModelList,
  createClaudeCliCatalog,
  resolveClaudeExecutionProfile,
  resolveCodexExecutionProfile,
  resolveExecutionProfile,
  stableStringify,
  toJsonSafe,
  validateUnobservedProfile,
  withObservedExecution,
} = require('../scripts/lib/execution-profile');

function model(overrides = {}) {
  return {
    id: 'terra-id',
    model: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    description: 'Everyday model',
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Quick' },
      { reasoningEffort: 'medium', description: 'Balanced' },
      { reasoningEffort: 'high', description: 'Deep' },
    ],
    defaultReasoningEffort: 'medium',
    serviceTiers: [
      { id: 'default', name: 'Standard', description: 'Standard speed' },
      { id: 'priority', name: 'Fast', description: 'Premium fast speed' },
    ],
    defaultServiceTier: 'priority',
    ...overrides,
  };
}

function modelList() {
  return {
    data: [
      model({ isDefault: true }),
      model({
        id: 'sol-id',
        model: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        description: 'Deep model',
        supportedReasoningEfforts: [
          { reasoningEffort: 'medium', description: 'Balanced' },
          { reasoningEffort: 'high', description: 'Deep' },
          { reasoningEffort: 'max', description: 'Maximum' },
        ],
        defaultReasoningEffort: 'high',
        defaultServiceTier: 'default',
      }),
    ],
    nextCursor: null,
  };
}

function codexGuidance() {
  return {
    provider: 'codex',
    source: { kind: 'official-guidance', version: '2026-09-02' },
    intents: {
      'fast-loop': { model: 'gpt-5.6-terra', effort: 'low' },
      balanced: { model: 'gpt-5.6-terra', effort: 'medium' },
      deep: { model: 'gpt-5.6-sol', effort: 'high' },
      'max-quality': { model: 'gpt-5.6-sol', effort: 'max' },
    },
    speeds: { standard: 'default', fast: 'priority' },
  };
}

function claudeSource() {
  return { kind: 'claude-cli:help', cliVersion: '2.1.258' };
}

function assertProfileError(callback, code) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof ExecutionProfileError);
    assert.equal(error.code, code);
    assert.doesNotThrow(() => JSON.stringify(error.details));
    return true;
  });
}

test('exports the fixed provider-neutral intent vocabulary', () => {
  assert.deepEqual(INTENTS, [
    'provider-default',
    'fast-loop',
    'balanced',
    'deep',
    'max-quality',
  ]);
});

test('Codex provider-default is resolved from the supplied live catalog', () => {
  const profile = resolveCodexExecutionProfile({
    request: {},
    modelList: modelList(),
    guidance: codexGuidance(),
    source: { kind: 'app-server:model/list', runtimeVersion: '0.151.0' },
  });

  assert.deepEqual(profile.requested, {
    effort: null,
    intent: 'provider-default',
    model: null,
    speed: 'standard',
    speedExplicit: false,
  });
  assert.deepEqual(profile.resolved.model, {
    catalogId: 'terra-id',
    selection: 'provider-default',
    selector: 'gpt-5.6-terra',
  });
  assert.deepEqual(profile.resolved.effort, {
    level: 'medium', selection: 'documented-model-default',
  });
  assert.deepEqual(profile.resolved.speed, {
    mode: 'standard',
    nativeControl: { kind: 'service-tier', value: 'default' },
    selection: 'implicit-standard',
  });
  assert.equal(profile.observed, null);
});

test('implicit standard overrides a premium catalog default instead of falling into it', () => {
  const profile = resolveCodexExecutionProfile({
    modelList: modelList(),
    guidance: codexGuidance(),
  });
  assert.equal(modelList().data[0].defaultServiceTier, 'priority');
  assert.deepEqual(profile.resolved.speed.nativeControl, {
    kind: 'service-tier',
    value: 'default',
  });
});

test('Codex standard uses the schema-defined default even when only Fast is advertised', () => {
  const liveShape = modelList();
  liveShape.data[0].serviceTiers = [
    { id: 'priority', name: 'Fast', description: 'Premium fast speed' },
  ];
  liveShape.data[0].defaultServiceTier = null;
  const profile = resolveCodexExecutionProfile({
    modelList: liveShape,
    guidance: codexGuidance(),
  });
  assert.deepEqual(profile.resolved.speed.nativeControl, {
    kind: 'service-tier', value: 'default',
  });
});

test('standard speed cannot be mislabeled as a premium tier or inferred by omission', () => {
  const swapped = codexGuidance();
  swapped.speeds.standard = 'priority';
  assertProfileError(
    () => resolveCodexExecutionProfile({ modelList: modelList(), guidance: swapped }),
    'UNSAFE_SPEED_MAPPING',
  );

  const missing = codexGuidance();
  delete missing.speeds.standard;
  const noTiers = modelList();
  noTiers.data[0].serviceTiers = [];
  noTiers.data[0].defaultServiceTier = null;
  assertProfileError(
    () => resolveCodexExecutionProfile({ modelList: noTiers, guidance: missing }),
    'UNRESOLVED_SPEED',
  );
});

test('Codex intents use guidance policy then validate against live capabilities', () => {
  const profile = resolveCodexExecutionProfile({
    request: { intent: 'max-quality' },
    modelList: modelList(),
    guidance: codexGuidance(),
  });
  assert.equal(profile.resolved.model.selector, 'gpt-5.6-sol');
  assert.equal(profile.resolved.model.selection, 'intent');
  assert.deepEqual(profile.resolved.effort, { level: 'max', selection: 'intent' });
});

test('explicit model and effort override intent policy but remain catalog-validated', () => {
  const profile = resolveCodexExecutionProfile({
    request: { intent: 'deep', model: 'terra-id', effort: 'low' },
    modelList: modelList(),
    guidance: codexGuidance(),
  });
  assert.equal(profile.resolved.model.selector, 'gpt-5.6-terra');
  assert.equal(profile.resolved.model.selection, 'explicit');
  assert.deepEqual(profile.resolved.effort, { level: 'low', selection: 'explicit' });
});

test('Codex fast speed requires an explicit request and advertised mapped tier', () => {
  const profile = resolveCodexExecutionProfile({
    request: { speed: 'fast' },
    modelList: modelList(),
    guidance: codexGuidance(),
  });
  assert.deepEqual(profile.resolved.speed, {
    mode: 'fast',
    nativeControl: { kind: 'service-tier', value: 'priority' },
    selection: 'explicit',
  });
});

test('guidance cannot silently turn an intent into premium fast mode', () => {
  const guidance = codexGuidance();
  guidance.intents.deep.speed = 'fast';
  assertProfileError(
    () => resolveCodexExecutionProfile({
      request: { intent: 'deep' },
      modelList: modelList(),
      guidance,
    }),
    'IMPLICIT_FAST_FORBIDDEN',
  );
});

test('Codex rejects stale models, unsupported efforts, and stale speed mappings', () => {
  assertProfileError(
    () => resolveCodexExecutionProfile({
      request: { model: 'gpt-retired' },
      modelList: modelList(),
      guidance: codexGuidance(),
    }),
    'UNSUPPORTED_MODEL',
  );
  assertProfileError(
    () => resolveCodexExecutionProfile({
      request: { effort: 'ultra' },
      modelList: modelList(),
      guidance: codexGuidance(),
    }),
    'UNSUPPORTED_EFFORT',
  );
  const guidance = codexGuidance();
  guidance.speeds.fast = 'turbo';
  assertProfileError(
    () => resolveCodexExecutionProfile({
      request: { speed: 'fast' },
      modelList: modelList(),
      guidance,
    }),
    'STALE_SPEED_GUIDANCE',
  );
});

test('Codex preserves upgrade lifecycle metadata and refuses non-current catalog rows', () => {
  const raw = modelList();
  raw.data.push(model({
    id: 'legacy-id',
    model: 'gpt-5.4',
    displayName: 'GPT-5.4',
    isDefault: false,
    upgrade: 'gpt-5.6-terra',
    upgradeInfo: { model: 'gpt-5.6-terra', retirementAt: 1 },
  }));
  const catalog = catalogFromCodexModelList(raw);
  const legacy = catalog.models.find((entry) => entry.id === 'legacy-id');
  assert.deepEqual(legacy.lifecycle, {
    replacement: 'gpt-5.6-terra', retirementAt: 1, status: 'retired',
  });
  assertProfileError(
    () => resolveCodexExecutionProfile({
      request: { model: 'gpt-5.4' }, modelList: raw, guidance: codexGuidance(),
    }),
    'MODEL_RETIRED',
  );

  const disagreeing = modelList();
  disagreeing.data[0].upgrade = 'gpt-5.6-sol';
  disagreeing.data[0].upgradeInfo = { model: 'gpt-5.6-terra' };
  assertProfileError(() => catalogFromCodexModelList(disagreeing), 'INVALID_CATALOG');
});

test('Codex rejects missing intent policy and conflicting default models', () => {
  const guidance = codexGuidance();
  delete guidance.intents.deep;
  assertProfileError(
    () => resolveCodexExecutionProfile({
      request: { intent: 'deep' },
      modelList: modelList(),
      guidance,
    }),
    'UNRESOLVED_INTENT',
  );
  const raw = modelList();
  raw.data[1].isDefault = true;
  assertProfileError(
    () => resolveCodexExecutionProfile({ modelList: raw, guidance: codexGuidance() }),
    'AMBIGUOUS_DEFAULT_MODEL',
  );
});

test('Codex catalog normalization is deterministic and rejects malformed defaults', () => {
  const catalog = catalogFromCodexModelList(modelList(), {
    source: { runtimeVersion: '0.151.0', kind: 'app-server:model/list' },
  });
  assert.deepEqual(catalog.models.map((entry) => entry.id), ['sol-id', 'terra-id']);
  assert.deepEqual(Object.keys(catalog.source), ['kind', 'runtimeVersion']);

  const malformed = modelList();
  malformed.data[0].defaultReasoningEffort = 'max';
  assertProfileError(() => catalogFromCodexModelList(malformed), 'INVALID_CATALOG');

  const incomplete = modelList();
  incomplete.nextCursor = 'next-page';
  assertProfileError(() => catalogFromCodexModelList(incomplete), 'INCOMPLETE_CATALOG');

  const missingId = modelList();
  delete missingId.data[0].id;
  assertProfileError(() => catalogFromCodexModelList(missingId), 'INVALID_CATALOG');

  const malformedAvailability = modelList();
  malformedAvailability.data[0].hidden = 1;
  assertProfileError(() => catalogFromCodexModelList(malformedAvailability), 'INVALID_CATALOG');

  for (const invalidEfforts of [
    ['low'],
    [{ level: 'low', description: 'Quick' }],
    [{ reasoningEffort: 'low' }],
  ]) {
    const malformedEffortShape = modelList();
    malformedEffortShape.data[0].supportedReasoningEfforts = invalidEfforts;
    assertProfileError(() => catalogFromCodexModelList(malformedEffortShape), 'INVALID_CATALOG');
  }
});

test('resolver entry points fail with structured errors when required input is missing', () => {
  assertProfileError(() => resolveExecutionProfile(), 'INVALID_REQUEST');
  assertProfileError(() => resolveCodexExecutionProfile(), 'INVALID_CATALOG');
});

test('Claude current CLI accepts validated model selectors and its documented efforts', () => {
  assert.deepEqual(CLAUDE_EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max']);
  const profile = resolveClaudeExecutionProfile({
    request: { model: 'fable', effort: 'xhigh', speed: 'standard' },
    source: claudeSource(),
  });
  assert.deepEqual(profile.resolved.model, {
    catalogId: 'claude-fable-5-1',
    selection: 'explicit',
    selector: 'claude-fable-5-1',
  });
  assert.deepEqual(profile.resolved.effort, { level: 'xhigh', selection: 'explicit' });
  assert.deepEqual(profile.resolved.speed, {
    mode: 'standard',
    nativeControl: { kind: 'fast-mode', value: false },
    selection: 'explicit',
  });
});

test('Claude ultracode is a typed execution setting that resolves to xhigh', () => {
  assert.deepEqual(CLAUDE_EXECUTION_SETTINGS, ['ultracode']);
  const profile = resolveClaudeExecutionProfile({
    request: { model: 'opus', effort: 'ultracode' },
    source: claudeSource(),
  });
  assert.deepEqual(profile.requested, {
    effort: null,
    intent: 'provider-default',
    model: 'opus',
    setting: 'ultracode',
    speed: 'standard',
    speedExplicit: false,
  });
  assert.deepEqual(profile.resolved.effort, {
    level: 'xhigh',
    selection: 'execution-setting',
  });
  assert.deepEqual(profile.resolved.setting, {
    id: 'ultracode',
    nativeControl: { kind: 'claude-effort-flag', value: 'ultracode' },
    selection: 'explicit',
  });
  assert.doesNotThrow(() => validateUnobservedProfile(profile));
});

test('Claude ultracode fails closed for unresolved, non-xhigh, and conflicting profiles', () => {
  assertProfileError(
    () => resolveClaudeExecutionProfile({
      request: { effort: 'ultracode' },
      source: claudeSource(),
    }),
    'UNRESOLVED_EXECUTION_SETTING',
  );
  for (const modelSelector of ['claude-opus-4-6', 'haiku']) {
    assertProfileError(
      () => resolveClaudeExecutionProfile({
        request: { model: modelSelector, effort: 'ultracode' },
        source: claudeSource(),
      }),
      'UNSUPPORTED_EXECUTION_SETTING',
    );
  }
  assertProfileError(
    () => resolveClaudeExecutionProfile({
      request: { model: 'opus', effort: 'xhigh', setting: 'ultracode' },
      source: claudeSource(),
    }),
    'CONFLICTING_EXECUTION_SETTING',
  );
  assertProfileError(
    () => resolveClaudeExecutionProfile({
      request: { model: 'opus', effort: 'ultracode' },
      source: { kind: 'claude-cli:help', cliVersion: '2.1.202' },
    }),
    'UNVERIFIED_CLAUDE_CLI_VERSION',
  );
});

test('Claude provider-default leaves model and effort to the CLI without inventing values', () => {
  const profile = resolveClaudeExecutionProfile({ source: claudeSource() });
  assert.equal(profile.resolved.model.selector, null);
  assert.equal(profile.resolved.effort.level, null);
  assert.equal(profile.resolved.speed.mode, 'standard');
});

test('Claude guidance can define intents without hard-coding model policy in the core', () => {
  const profile = resolveClaudeExecutionProfile({
    request: { intent: 'balanced' },
    guidance: {
      provider: 'claude',
      source: { kind: 'official-guidance', version: '2026-09-02' },
      intents: { balanced: { model: 'claude-sonnet-5', effort: 'medium' } },
    },
    source: claudeSource(),
  });
  assert.equal(profile.resolved.model.selector, 'claude-sonnet-5');
  assert.equal(profile.resolved.effort.level, 'medium');
});

test('Claude current CLI fails closed for unsupported effort, fast mode, and selectors', () => {
  assertProfileError(
    () => resolveClaudeExecutionProfile({ request: { effort: 'ultra' }, source: claudeSource() }),
    'UNSUPPORTED_EFFORT',
  );
  assertProfileError(
    () => resolveClaudeExecutionProfile({
      request: { model: 'haiku', speed: 'fast' },
      source: claudeSource(),
    }),
    'UNSUPPORTED_SPEED',
  );
  assertProfileError(
    () => resolveClaudeExecutionProfile({ request: { model: '../opus' }, source: claudeSource() }),
    'INVALID_MODEL_SELECTOR',
  );
  assertProfileError(
    () => resolveClaudeExecutionProfile({ source: { kind: 'claude-cli:help', cliVersion: '2.2.0' } }),
    'UNVERIFIED_CLAUDE_CLI_VERSION',
  );
});

test('Claude model-specific matrix rejects Haiku effort and enables explicit Opus 5 Fast', () => {
  assertProfileError(
    () => resolveClaudeExecutionProfile({
      request: { model: 'haiku', effort: 'low' },
      source: claudeSource(),
    }),
    'UNSUPPORTED_EFFORT',
  );
  const opus = resolveClaudeExecutionProfile({
    request: { model: 'opus', effort: 'max', speed: 'fast' },
    source: claudeSource(),
  });
  assert.equal(opus.resolved.model.selector, 'claude-opus-5');
  assert.equal(opus.resolved.model.catalogId, 'claude-opus-5');
  assert.deepEqual(opus.resolved.speed.nativeControl, { kind: 'fast-mode', value: true });

  assertProfileError(
    () => resolveClaudeExecutionProfile({ request: { model: 'claude-future-6' }, source: claudeSource() }),
    'UNSUPPORTED_MODEL',
  );

  const opus48 = resolveClaudeExecutionProfile({
    request: { model: 'claude-opus-4-8', effort: 'xhigh', speed: 'fast' },
    source: claudeSource(),
  });
  assert.equal(opus48.resolved.model.selector, 'claude-opus-4-8');
  assert.deepEqual(opus48.resolved.speed.nativeControl, { kind: 'fast-mode', value: true });
});

test('Claude explicit models use documented defaults, including Opus 4.7 xhigh', () => {
  const profile = resolveClaudeExecutionProfile({
    request: { model: 'claude-opus-4-7' },
    source: claudeSource(),
  });
  assert.deepEqual(profile.resolved.effort, {
    level: 'xhigh',
    selection: 'documented-model-default',
  });
});

test('generic catalogs can compile a future provider speed into a typed native control', () => {
  const catalog = {
    profileVersion: 1,
    provider: 'future-provider',
    source: { kind: 'future-provider:capabilities' },
    selectorPolicy: {
      kind: 'validated-passthrough', pattern: '^[a-z0-9-]+$', allowHostDefault: false,
    },
    models: [],
    globalEfforts: [],
    speedCompatibility: {
      standard: { nativeControl: { kind: 'rpc-field', value: { priority: false } } },
      fast: { nativeControl: { kind: 'rpc-field', value: { priority: true } } },
    },
    standardNativeTier: null,
  };
  const profile = resolveExecutionProfile({
    provider: 'future-provider',
    request: { model: 'future-model', speed: 'fast' },
    catalog,
  });
  assert.deepEqual(profile.resolved.speed.nativeControl, {
    kind: 'rpc-field',
    value: { priority: true },
  });
});

test('generic catalogs can compile a future provider execution setting', () => {
  const catalog = createClaudeCliCatalog({ source: claudeSource() });
  catalog.provider = 'future-provider';
  catalog.source = { kind: 'future-provider:capabilities' };
  catalog.executionSettings = [{
    id: 'parallel-review',
    description: 'Run a provider-native parallel review.',
    requiredEffort: 'xhigh',
    nativeControl: { kind: 'rpc-field', value: { orchestration: 'parallel-review' } },
  }];
  for (const entry of catalog.models) {
    entry.executionSettings = entry.efforts.some((effort) => effort.level === 'xhigh')
      ? ['parallel-review']
      : [];
  }
  const profile = resolveExecutionProfile({
    provider: 'future-provider',
    request: { model: 'claude-opus-5', setting: 'parallel-review' },
    catalog,
  });
  assert.deepEqual(profile.resolved.effort, {
    level: 'xhigh', selection: 'execution-setting',
  });
  assert.deepEqual(profile.resolved.setting, {
    id: 'parallel-review',
    nativeControl: { kind: 'rpc-field', value: { orchestration: 'parallel-review' } },
    selection: 'explicit',
  });
});

test('resolution and observation remain separate immutable receipts', () => {
  const profile = resolveCodexExecutionProfile({
    request: { intent: 'deep' },
    modelList: modelList(),
    guidance: codexGuidance(),
  });
  const observed = withObservedExecution(profile, {
    model: 'gpt-5.6-sol',
    effort: 'high',
    speed: 'standard',
    nativeControl: { kind: 'service-tier', value: 'default' },
    receipt: { method: 'thread/start', sequence: 7 },
  });
  assert.equal(profile.observed, null);
  assert.equal(observed.requested.intent, 'deep');
  assert.equal(observed.resolved.model.selector, 'gpt-5.6-sol');
  assert.deepEqual(observed.observed, {
    effort: 'high',
    model: 'gpt-5.6-sol',
    nativeControl: { kind: 'service-tier', value: 'default' },
    receipt: { method: 'thread/start', sequence: 7 },
    speed: 'standard',
  });
  assertProfileError(
    () => withObservedExecution(observed, { model: 'another' }),
    'INVALID_PROFILE',
  );
  assertProfileError(
    () => withObservedExecution({ profileVersion: 1, observed: null }, { model: 'forged' }),
    'INVALID_PROFILE',
  );
});

test('profile validation rejects a speed label whose native control requests another mode', () => {
  const claude = resolveClaudeExecutionProfile({ source: claudeSource() });
  const forgedClaude = structuredClone(claude);
  forgedClaude.resolved.speed.nativeControl.value = true;
  assertProfileError(() => validateUnobservedProfile(forgedClaude), 'INVALID_PROFILE');

  const codex = resolveCodexExecutionProfile({
    modelList: modelList(), guidance: codexGuidance(),
  });
  const forgedCodex = structuredClone(codex);
  forgedCodex.resolved.speed.nativeControl.value = 'priority';
  assertProfileError(() => validateUnobservedProfile(forgedCodex), 'INVALID_PROFILE');
});

test('JSON-safe normalization and serialization are deterministic and reject lossy values', () => {
  assert.equal(stableStringify({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
  assert.deepEqual(toJsonSafe({ z: 1, a: 2 }), { a: 2, z: 1 });
  assertProfileError(() => toJsonSafe({ bad: undefined }), 'NOT_JSON_SAFE');
  assertProfileError(() => toJsonSafe({ bad: Number.NaN }), 'NOT_JSON_SAFE');
  const cyclic = {};
  cyclic.self = cyclic;
  assertProfileError(() => toJsonSafe(cyclic), 'NOT_JSON_SAFE');

  const hostile = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
  assert.equal(stableStringify(hostile), '{"__proto__":{"polluted":true},"safe":1}');
  assert.equal({}.polluted, undefined);

  const symbolKeyed = { safe: true };
  symbolKeyed[Symbol('hidden')] = true;
  assertProfileError(() => toJsonSafe(symbolKeyed), 'NOT_JSON_SAFE');

  const accessorArray = [];
  Object.defineProperty(accessorArray, '0', { enumerable: true, get: () => 'ran' });
  accessorArray.length = 1;
  assertProfileError(() => toJsonSafe(accessorArray), 'NOT_JSON_SAFE');

  const hiddenArrayProperty = [1];
  Object.defineProperty(hiddenArrayProperty, 'secret', { value: true });
  assertProfileError(() => toJsonSafe(hiddenArrayProperty), 'NOT_JSON_SAFE');
});
