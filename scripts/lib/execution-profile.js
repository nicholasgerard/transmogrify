'use strict';

const PROFILE_VERSION = 1;

const INTENTS = Object.freeze([
  'provider-default',
  'fast-loop',
  'balanced',
  'deep',
  'max-quality',
]);

const SPEEDS = Object.freeze(['standard', 'fast']);
const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const CLAUDE_EXECUTION_SETTINGS = Object.freeze(['ultracode']);
const CLAUDE_MODEL_SELECTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CLAUDE_CLI_COMPATIBILITY_VERSION = '2.1.258';
const CLAUDE_CLI_COMPATIBILITY_VERIFIED_AT = '2026-09-02';

class ExecutionProfileError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ExecutionProfileError';
    this.code = code;
    this.details = toJsonSafe(details, 'error details');
  }
}

function fail(code, message, details) {
  throw new ExecutionProfileError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function setOwn(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function toJsonSafe(value, label = 'value', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('NOT_JSON_SAFE', `${label} contains a non-finite number`, { label });
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      fail('NOT_JSON_SAFE', `${label} contains a cycle`, { label });
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      fail('NOT_JSON_SAFE', `${label} contains symbol keys`, { label });
    }
    const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index));
    const ownNames = Object.getOwnPropertyNames(value);
    const allowedNames = new Set([...expectedKeys, 'length']);
    if (ownNames.length !== allowedNames.size || ownNames.some((key) => !allowedNames.has(key))) {
      fail('NOT_JSON_SAFE', `${label} must not contain custom array properties`, { label });
    }
    const enumerableKeys = Object.keys(value);
    if (
      enumerableKeys.length !== expectedKeys.length
      || enumerableKeys.some((key, index) => key !== expectedKeys[index])
    ) {
      fail('NOT_JSON_SAFE', `${label} must be a dense array without custom properties`, { label });
    }
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        fail('NOT_JSON_SAFE', `${label}[${key}] is an accessor`, { label: `${label}[${key}]` });
      }
    }
    ancestors.add(value);
    const result = value.map((item, index) => toJsonSafe(item, `${label}[${index}]`, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (!isPlainObject(value)) {
    fail('NOT_JSON_SAFE', `${label} must contain only JSON values`, { label });
  }
  if (ancestors.has(value)) {
    fail('NOT_JSON_SAFE', `${label} contains a cycle`, { label });
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail('NOT_JSON_SAFE', `${label} contains symbol keys`, { label });
  }
  const ownNames = Object.getOwnPropertyNames(value);
  const enumerableNames = Object.keys(value);
  if (ownNames.length !== enumerableNames.length) {
    fail('NOT_JSON_SAFE', `${label} contains non-enumerable fields`, { label });
  }
  for (const key of ownNames) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      fail('NOT_JSON_SAFE', `${label}.${key} is an accessor`, { label: `${label}.${key}` });
    }
  }
  ancestors.add(value);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) {
      fail('NOT_JSON_SAFE', `${label}.${key} is undefined`, { label: `${label}.${key}` });
    }
    setOwn(result, key, toJsonSafe(value[key], `${label}.${key}`, ancestors));
  }
  ancestors.delete(value);
  return result;
}

function stableStringify(value) {
  return JSON.stringify(toJsonSafe(value));
}

function requiredObject(value, label, code = 'INVALID_CATALOG') {
  if (!isPlainObject(value)) {
    fail(code, `${label} must be an object`, { label });
  }
  return value;
}

function optionalExactString(value, label, code = 'INVALID_REQUEST') {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail(code, `${label} must be a non-empty string without surrounding whitespace`, { label });
  }
  return value;
}

function requiredExactString(value, label, code = 'INVALID_CATALOG') {
  const result = optionalExactString(value, label, code);
  if (result === null) {
    fail(code, `${label} is required`, { label });
  }
  return result;
}

function requiredString(value, label, code = 'INVALID_CATALOG') {
  if (typeof value !== 'string') {
    fail(code, `${label} must be a string`, { label });
  }
  return value;
}

function assertKnownKeys(value, allowed, label, code) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length > 0) {
    fail(code, `${label} contains unsupported fields`, { label, unknown });
  }
}

function normalizeExecutionRequest(request = {}) {
  requiredObject(request, 'request', 'INVALID_REQUEST');
  assertKnownKeys(
    request,
    ['effort', 'intent', 'model', 'setting', 'speed'],
    'request',
    'INVALID_REQUEST',
  );

  const intent = request.intent === undefined ? 'provider-default' : request.intent;
  if (!INTENTS.includes(intent)) {
    fail('INVALID_INTENT', 'request.intent is not supported', { intent, supported: INTENTS });
  }

  const speedExplicit = request.speed !== undefined;
  const speed = speedExplicit ? request.speed : 'standard';
  if (!SPEEDS.includes(speed)) {
    fail('INVALID_SPEED', 'request.speed is not supported', { speed, supported: SPEEDS });
  }
  const setting = optionalExactString(request.setting, 'request.setting');

  return {
    intent,
    model: optionalExactString(request.model, 'request.model'),
    effort: optionalExactString(request.effort, 'request.effort'),
    ...(setting !== null ? { setting } : {}),
    speed,
    speedExplicit,
  };
}

function normalizeSource(source, fallbackKind) {
  const raw = source === undefined ? { kind: fallbackKind } : requiredObject(source, 'source');
  const normalized = toJsonSafe(raw, 'source');
  if (typeof normalized.kind !== 'string' || normalized.kind.length === 0) {
    fail('INVALID_CATALOG', 'source.kind must be a non-empty string', {});
  }
  return normalized;
}

function normalizeEffortList(efforts, label) {
  if (!Array.isArray(efforts)) {
    fail('INVALID_CATALOG', `${label} must be an array`, { label });
  }
  const seen = new Set();
  const result = [];
  for (const raw of efforts) {
    let level;
    let description = '';
    if (typeof raw === 'string') {
      level = requiredExactString(raw, label, 'INVALID_CATALOG');
    } else {
      requiredObject(raw, label);
      level = requiredExactString(
        raw.reasoningEffort === undefined ? raw.level : raw.reasoningEffort,
        `${label}.level`,
        'INVALID_CATALOG',
      );
      if (raw.description !== undefined) {
        description = requiredString(raw.description, `${label}.description`, 'INVALID_CATALOG');
      }
    }
    if (seen.has(level)) {
      fail('INVALID_CATALOG', `${label} contains duplicate effort levels`, { level });
    }
    seen.add(level);
    result.push({ level, description });
  }
  return result.sort((left, right) => compareCodeUnits(left.level, right.level));
}

function normalizeNativeTiers(tiers, label) {
  if (!Array.isArray(tiers)) {
    fail('INVALID_CATALOG', `${label} must be an array`, { label });
  }
  const seen = new Set();
  const result = [];
  for (const raw of tiers) {
    requiredObject(raw, label);
    const id = requiredExactString(raw.id, `${label}.id`, 'INVALID_CATALOG');
    if (seen.has(id)) {
      fail('INVALID_CATALOG', `${label} contains duplicate native tier ids`, { id });
    }
    seen.add(id);
    result.push({
      id,
      name: requiredString(raw.name, `${label}.name`, 'INVALID_CATALOG'),
      description: requiredString(raw.description, `${label}.description`, 'INVALID_CATALOG'),
    });
  }
  return result.sort((left, right) => compareCodeUnits(left.id, right.id));
}

function catalogFromCodexModelList(modelList, options = {}) {
  requiredObject(modelList, 'modelList');
  requiredObject(options, 'options');
  assertKnownKeys(options, ['source'], 'options', 'INVALID_CATALOG');
  if (!Array.isArray(modelList.data)) {
    fail('INVALID_CATALOG', 'modelList.data must be an array', {});
  }
  if (modelList.nextCursor !== undefined && modelList.nextCursor !== null) {
    fail('INCOMPLETE_CATALOG', 'model/list must be fully paginated before profile resolution', {
      nextCursor: modelList.nextCursor,
    });
  }

  const ids = new Set();
  const selectors = new Set();
  const models = modelList.data.map((raw, index) => {
    requiredObject(raw, `modelList.data[${index}]`);
    if (typeof raw.hidden !== 'boolean' || typeof raw.isDefault !== 'boolean') {
      fail('INVALID_CATALOG', 'model availability fields must be booleans', {
        index,
        hiddenType: typeof raw.hidden,
        isDefaultType: typeof raw.isDefault,
      });
    }
    const id = requiredExactString(raw.id, `modelList.data[${index}].id`, 'INVALID_CATALOG');
    const selector = requiredExactString(
      raw.model,
      `modelList.data[${index}].model`,
      'INVALID_CATALOG',
    );
    if (ids.has(id)) fail('INVALID_CATALOG', 'modelList contains duplicate model ids', { id });
    if (selectors.has(selector)) {
      fail('INVALID_CATALOG', 'modelList contains duplicate model selectors', { selector });
    }
    ids.add(id);
    selectors.add(selector);

    const effortLabel = `modelList.data[${index}].supportedReasoningEfforts`;
    if (!Array.isArray(raw.supportedReasoningEfforts)) {
      fail('INVALID_CATALOG', `${effortLabel} must be an array`, { label: effortLabel });
    }
    raw.supportedReasoningEfforts.forEach((option, effortIndex) => {
      const optionLabel = `${effortLabel}[${effortIndex}]`;
      requiredObject(option, optionLabel, 'INVALID_CATALOG');
      requiredExactString(option.reasoningEffort, `${optionLabel}.reasoningEffort`, 'INVALID_CATALOG');
      requiredString(option.description, `${optionLabel}.description`, 'INVALID_CATALOG');
    });
    const efforts = normalizeEffortList(raw.supportedReasoningEfforts, effortLabel);
    const defaultEffort = requiredExactString(
      raw.defaultReasoningEffort,
      `modelList.data[${index}].defaultReasoningEffort`,
      'INVALID_CATALOG',
    );
    if (!efforts.some((option) => option.level === defaultEffort)) {
      fail('INVALID_CATALOG', 'default reasoning effort is not advertised by the model', {
        id,
        defaultEffort,
      });
    }

    const nativeSpeedTiers = normalizeNativeTiers(
      raw.serviceTiers === undefined ? [] : raw.serviceTiers,
      `modelList.data[${index}].serviceTiers`,
    );
    const defaultNativeSpeedTier = optionalExactString(
      raw.defaultServiceTier,
      `modelList.data[${index}].defaultServiceTier`,
      'INVALID_CATALOG',
    );
    if (
      defaultNativeSpeedTier !== null
      && !nativeSpeedTiers.some((tier) => tier.id === defaultNativeSpeedTier)
    ) {
      fail('INVALID_CATALOG', 'default service tier is not advertised by the model', {
        id,
        defaultNativeSpeedTier,
      });
    }

    const upgrade = optionalExactString(
      raw.upgrade,
      `modelList.data[${index}].upgrade`,
      'INVALID_CATALOG',
    );
    let upgradeModel = null;
    let retirementAt = null;
    if (raw.upgradeInfo !== undefined && raw.upgradeInfo !== null) {
      requiredObject(raw.upgradeInfo, `modelList.data[${index}].upgradeInfo`, 'INVALID_CATALOG');
      upgradeModel = requiredExactString(
        raw.upgradeInfo.model,
        `modelList.data[${index}].upgradeInfo.model`,
        'INVALID_CATALOG',
      );
      if (raw.upgradeInfo.retirementAt !== undefined && raw.upgradeInfo.retirementAt !== null) {
        if (!Number.isSafeInteger(raw.upgradeInfo.retirementAt) || raw.upgradeInfo.retirementAt < 0) {
          fail('INVALID_CATALOG', 'model retirementAt must be a non-negative Unix timestamp', { id });
        }
        retirementAt = raw.upgradeInfo.retirementAt;
      }
    }
    if (upgrade !== null && upgradeModel !== null && upgrade !== upgradeModel) {
      fail('INVALID_CATALOG', 'model upgrade fields disagree about the replacement model', { id });
    }
    const replacement = upgradeModel ?? upgrade;
    const lifecycle = replacement === null
      ? { status: 'current', replacement: null, retirementAt: null }
      : {
        status: retirementAt !== null && retirementAt <= Math.floor(Date.now() / 1000)
          ? 'retired'
          : 'upgrade-only',
        replacement,
        retirementAt,
      };

    return {
      id,
      selector,
      aliases: [],
      displayName: requiredString(
        raw.displayName,
        `modelList.data[${index}].displayName`,
        'INVALID_CATALOG',
      ),
      description: requiredString(
        raw.description,
        `modelList.data[${index}].description`,
        'INVALID_CATALOG',
      ),
      hidden: raw.hidden,
      isDefault: raw.isDefault,
      efforts,
      defaultEffort,
      executionSettings: [],
      nativeSpeedTiers,
      defaultNativeSpeedTier,
      speedCompatibility: null,
      lifecycle,
    };
  });

  return toJsonSafe({
    profileVersion: PROFILE_VERSION,
    provider: 'codex',
    source: normalizeSource(options.source, 'app-server:model/list'),
    selectorPolicy: { kind: 'catalog-only', allowHostDefault: false },
    models: models.sort((left, right) => compareCodeUnits(left.id, right.id)),
    globalEfforts: [],
    executionSettings: [],
    speedCompatibility: null,
    standardNativeTier: 'default',
  });
}

function createClaudeCliCatalog(options = {}) {
  requiredObject(options, 'options');
  assertKnownKeys(options, ['source'], 'options', 'INVALID_CATALOG');
  const source = normalizeSource(options.source, 'claude-cli:help');
  if (source.cliVersion !== CLAUDE_CLI_COMPATIBILITY_VERSION) {
    fail('UNVERIFIED_CLAUDE_CLI_VERSION', 'Claude CLI compatibility has not been verified for this version', {
      expected: CLAUDE_CLI_COMPATIBILITY_VERSION,
      observed: source.cliVersion === undefined ? null : source.cliVersion,
    });
  }
  const effortOptions = normalizeEffortList(CLAUDE_EFFORTS, 'claudeCli.efforts');
  const legacyEffortOptions = normalizeEffortList(
    ['low', 'medium', 'high', 'max'], 'claudeCli.legacyEfforts',
  );
  const model = (
    id, aliases, displayName, description, efforts, supportsFast,
    defaultEffort = efforts.length > 0 ? 'high' : null,
  ) => ({
    id,
    selector: id,
    aliases: [...aliases].sort(compareCodeUnits),
    displayName,
    description,
    hidden: false,
    isDefault: false,
    efforts,
    defaultEffort,
    executionSettings: efforts.some((option) => option.level === 'xhigh')
      ? [...CLAUDE_EXECUTION_SETTINGS]
      : [],
    nativeSpeedTiers: [],
    defaultNativeSpeedTier: null,
    speedCompatibility: {
      standard: { nativeControl: { kind: 'fast-mode', value: false } },
      fast: supportsFast ? { nativeControl: { kind: 'fast-mode', value: true } } : null,
    },
    lifecycle: { status: 'current', replacement: null, retirementAt: null },
  });
  return toJsonSafe({
    profileVersion: PROFILE_VERSION,
    provider: 'claude',
    source: {
      ...source,
      compatibilityVerifiedAt: CLAUDE_CLI_COMPATIBILITY_VERIFIED_AT,
    },
    selectorPolicy: {
      kind: 'catalog-only',
      allowHostDefault: true,
      pattern: CLAUDE_MODEL_SELECTOR_PATTERN.source,
    },
    models: [
      model('claude-fable-5-1', ['fable'], 'Claude Fable 5.1',
        'Demanding reasoning and long-horizon agentic work.', effortOptions, false),
      model('claude-fable-5', [], 'Claude Fable 5',
        'Previous Fable generation retained for explicit compatibility.', effortOptions, false),
      model('claude-opus-5', ['opus'], 'Claude Opus 5',
        'Complex agentic coding and enterprise work.', effortOptions, true),
      model('claude-opus-4-8', [], 'Claude Opus 4.8',
        'Previous Opus generation with current effort and Fast support.', effortOptions, true),
      model('claude-opus-4-7', [], 'Claude Opus 4.7',
        'Previous Opus generation retained for explicit compatibility.', effortOptions, false, 'xhigh'),
      model('claude-opus-4-6', [], 'Claude Opus 4.6',
        'Legacy Opus generation with a reduced effort set.', legacyEffortOptions, false),
      model('claude-sonnet-5', ['sonnet'], 'Claude Sonnet 5',
        'Best current combination of speed and intelligence.', effortOptions, false),
      model('claude-sonnet-4-6', [], 'Claude Sonnet 4.6',
        'Previous Sonnet generation with a reduced effort set.', legacyEffortOptions, false),
      model('claude-haiku-4-5-20251001', ['haiku'], 'Claude Haiku 4.5',
        'Fastest current Claude model for clear, high-volume work.', [], false),
    ].sort((left, right) => compareCodeUnits(left.id, right.id)),
    globalEfforts: [],
    executionSettings: [{
      id: 'ultracode',
      description: 'Use xhigh reasoning and let Claude plan dynamic workflows for substantive tasks.',
      requiredEffort: 'xhigh',
      nativeControl: { kind: 'claude-effort-flag', value: 'ultracode' },
    }],
    speedCompatibility: {
      standard: { nativeControl: { kind: 'fast-mode', value: false } },
      fast: null,
    },
    standardNativeTier: null,
  });
}

function normalizeGuidance(guidance = {}, provider) {
  requiredObject(guidance, 'guidance', 'INVALID_GUIDANCE');
  assertKnownKeys(
    guidance,
    ['intents', 'provider', 'source', 'speeds', 'modelSpeeds'],
    'guidance',
    'INVALID_GUIDANCE',
  );
  if (guidance.provider !== undefined && guidance.provider !== provider) {
    fail('INVALID_GUIDANCE', 'guidance provider does not match the catalog', {
      catalogProvider: provider,
      guidanceProvider: guidance.provider,
    });
  }

  const intents = guidance.intents === undefined ? {} : requiredObject(
    guidance.intents,
    'guidance.intents',
    'INVALID_GUIDANCE',
  );
  const normalizedIntents = {};
  for (const intent of Object.keys(intents).sort()) {
    if (!INTENTS.includes(intent) || intent === 'provider-default') {
      fail('INVALID_GUIDANCE', 'guidance contains an unsupported intent mapping', { intent });
    }
    const mapping = requiredObject(intents[intent], `guidance.intents.${intent}`, 'INVALID_GUIDANCE');
    assertKnownKeys(mapping, ['effort', 'model', 'speed'], `guidance.intents.${intent}`, 'INVALID_GUIDANCE');
    if (mapping.speed === 'fast') {
      fail('IMPLICIT_FAST_FORBIDDEN', 'guidance cannot enable premium fast speed implicitly', { intent });
    }
    if (mapping.speed !== undefined) {
      fail('INVALID_GUIDANCE', 'intent guidance cannot set speed; use an explicit request', { intent });
    }
    setOwn(normalizedIntents, intent, {
      model: optionalExactString(mapping.model, `guidance.intents.${intent}.model`, 'INVALID_GUIDANCE'),
      effort: optionalExactString(mapping.effort, `guidance.intents.${intent}.effort`, 'INVALID_GUIDANCE'),
    });
    if (normalizedIntents[intent].model === null) {
      fail('INVALID_GUIDANCE', 'intent guidance must select a model', { intent });
    }
  }

  const normalizeSpeeds = (raw, label) => {
    if (raw === undefined) return null;
    requiredObject(raw, label, 'INVALID_GUIDANCE');
    assertKnownKeys(raw, SPEEDS, label, 'INVALID_GUIDANCE');
    const result = {};
    for (const speed of SPEEDS) {
      if (!Object.prototype.hasOwnProperty.call(raw, speed)) continue;
      result[speed] = optionalExactString(raw[speed], `${label}.${speed}`, 'INVALID_GUIDANCE');
    }
    return result;
  };

  const modelSpeeds = guidance.modelSpeeds === undefined ? {} : requiredObject(
    guidance.modelSpeeds,
    'guidance.modelSpeeds',
    'INVALID_GUIDANCE',
  );
  const normalizedModelSpeeds = {};
  for (const selector of Object.keys(modelSpeeds).sort()) {
    optionalExactString(selector, 'guidance.modelSpeeds key', 'INVALID_GUIDANCE');
    setOwn(normalizedModelSpeeds, selector, normalizeSpeeds(
      modelSpeeds[selector],
      `guidance.modelSpeeds.${selector}`,
    ));
  }

  const source = guidance.source === undefined ? null : normalizeSource(guidance.source, 'guidance');
  const hasPolicy = Object.keys(normalizedIntents).length > 0
    || guidance.speeds !== undefined
    || Object.keys(normalizedModelSpeeds).length > 0;
  if (hasPolicy) {
    if (source === null) {
      fail('INVALID_GUIDANCE', 'non-empty guidance requires a versioned source receipt', {});
    }
    const versionKeys = ['digest', 'revision', 'verifiedAt', 'version'];
    if (!versionKeys.some((key) => Object.prototype.hasOwnProperty.call(source, key))) {
      fail('INVALID_GUIDANCE', 'guidance source must identify its version or verification', {
        acceptedFields: versionKeys,
      });
    }
  }

  return toJsonSafe({
    provider,
    source,
    intents: normalizedIntents,
    speeds: normalizeSpeeds(guidance.speeds, 'guidance.speeds'),
    modelSpeeds: normalizedModelSpeeds,
  });
}

function normalizeNativeControl(control, label, code = 'INVALID_CATALOG') {
  if (control === null) return null;
  requiredObject(control, label, code);
  assertKnownKeys(control, ['kind', 'value'], label, code);
  const kind = requiredExactString(control.kind, `${label}.kind`, code);
  if (!Object.prototype.hasOwnProperty.call(control, 'value')) {
    fail(code, `${label}.value is required`, { label });
  }
  return { kind, value: toJsonSafe(control.value, `${label}.value`) };
}

function normalizeExecutionSettings(settings, label) {
  if (!Array.isArray(settings)) {
    fail('INVALID_CATALOG', `${label} must be an array`, { label });
  }
  const seen = new Set();
  const result = [];
  for (let index = 0; index < settings.length; index += 1) {
    const raw = requiredObject(settings[index], `${label}[${index}]`, 'INVALID_CATALOG');
    assertKnownKeys(
      raw,
      ['description', 'id', 'nativeControl', 'requiredEffort'],
      `${label}[${index}]`,
      'INVALID_CATALOG',
    );
    const id = requiredExactString(raw.id, `${label}[${index}].id`, 'INVALID_CATALOG');
    if (seen.has(id)) {
      fail('INVALID_CATALOG', `${label} contains duplicate execution settings`, { id });
    }
    seen.add(id);
    const nativeControl = normalizeNativeControl(
      raw.nativeControl,
      `${label}[${index}].nativeControl`,
    );
    if (nativeControl === null) {
      fail('INVALID_CATALOG', `${label}[${index}] requires an explicit native control`, { id });
    }
    result.push({
      id,
      description: requiredString(
        raw.description,
        `${label}[${index}].description`,
        'INVALID_CATALOG',
      ),
      requiredEffort: optionalExactString(
        raw.requiredEffort,
        `${label}[${index}].requiredEffort`,
        'INVALID_CATALOG',
      ),
      nativeControl,
    });
  }
  return result.sort((left, right) => compareCodeUnits(left.id, right.id));
}

function normalizeSpeedCompatibility(compatibility, label) {
  if (compatibility === null) return null;
  requiredObject(compatibility, label, 'INVALID_CATALOG');
  assertKnownKeys(compatibility, SPEEDS, label, 'INVALID_CATALOG');
  if (!Object.prototype.hasOwnProperty.call(compatibility, 'standard')) {
    fail('INVALID_CATALOG', `${label} must declare standard behavior`, { label });
  }
  const result = {};
  for (const speed of SPEEDS) {
    if (!Object.prototype.hasOwnProperty.call(compatibility, speed)) continue;
    const option = compatibility[speed];
    if (option === null) {
      setOwn(result, speed, null);
      continue;
    }
    requiredObject(option, `${label}.${speed}`, 'INVALID_CATALOG');
    assertKnownKeys(option, ['nativeControl'], `${label}.${speed}`, 'INVALID_CATALOG');
    if (!Object.prototype.hasOwnProperty.call(option, 'nativeControl')) {
      fail('INVALID_CATALOG', `${label}.${speed}.nativeControl is required`, { speed });
    }
    const nativeControl = normalizeNativeControl(
      option.nativeControl,
      `${label}.${speed}.nativeControl`,
    );
    if (nativeControl === null) {
      fail('INVALID_CATALOG', `${label}.${speed} requires an explicit native control`, { speed });
    }
    setOwn(result, speed, { nativeControl });
  }
  if (result.standard === null) {
    fail('INVALID_CATALOG', `${label}.standard requires an explicit native control`, {});
  }
  if (
    result.fast !== undefined
    && result.fast !== null
    && stableStringify(result.fast.nativeControl) === stableStringify(result.standard.nativeControl)
  ) {
    fail('INVALID_CATALOG', `${label} cannot use the same control for standard and fast`, {});
  }
  return toJsonSafe(result);
}

function validateNormalizedCatalog(catalog, provider) {
  requiredObject(catalog, 'catalog');
  if (catalog.profileVersion !== PROFILE_VERSION || catalog.provider !== provider) {
    fail('INVALID_CATALOG', 'catalog version or provider does not match', {
      expectedProvider: provider,
      profileVersion: catalog.profileVersion,
      catalogProvider: catalog.provider,
    });
  }
  if (!Array.isArray(catalog.models) || !Array.isArray(catalog.globalEfforts)) {
    fail('INVALID_CATALOG', 'catalog models and globalEfforts must be arrays', {});
  }
  requiredObject(catalog.selectorPolicy, 'catalog.selectorPolicy');
  assertKnownKeys(
    catalog.selectorPolicy,
    ['allowHostDefault', 'kind', 'pattern'],
    'catalog.selectorPolicy',
    'INVALID_CATALOG',
  );
  normalizeSource(catalog.source, 'provider-catalog');
  if (!Object.prototype.hasOwnProperty.call(catalog, 'standardNativeTier')) {
    fail('INVALID_CATALOG', 'catalog must declare standardNativeTier', {});
  }
  const standardNativeTier = optionalExactString(
    catalog.standardNativeTier,
    'catalog.standardNativeTier',
    'INVALID_CATALOG',
  );

  if (!['catalog-only', 'validated-passthrough'].includes(catalog.selectorPolicy.kind)) {
    fail('INVALID_CATALOG', 'catalog selector policy is not supported', {
      kind: catalog.selectorPolicy.kind,
    });
  }
  if (typeof catalog.selectorPolicy.allowHostDefault !== 'boolean') {
    fail('INVALID_CATALOG', 'catalog selector policy must declare allowHostDefault', {});
  }
  if (catalog.selectorPolicy.pattern !== undefined) {
    const pattern = requiredExactString(
      catalog.selectorPolicy.pattern,
      'catalog.selectorPolicy.pattern',
      'INVALID_CATALOG',
    );
    if (!pattern.startsWith('^') || !pattern.endsWith('$')) {
      fail('INVALID_CATALOG', 'passthrough selector pattern must be anchored', { pattern });
    }
    try {
      new RegExp(pattern);
    } catch {
      fail('INVALID_CATALOG', 'passthrough selector pattern is not a valid regular expression', {});
    }
  }

  const globalEfforts = normalizeEffortList(catalog.globalEfforts, 'catalog.globalEfforts');
  if (stableStringify(globalEfforts) !== stableStringify(catalog.globalEfforts)) {
    fail('INVALID_CATALOG', 'catalog.globalEfforts is not normalized', {});
  }
  const executionSettings = normalizeExecutionSettings(
    catalog.executionSettings === undefined ? [] : catalog.executionSettings,
    'catalog.executionSettings',
  );
  if (
    catalog.executionSettings !== undefined
    && stableStringify(executionSettings) !== stableStringify(catalog.executionSettings)
  ) {
    fail('INVALID_CATALOG', 'catalog.executionSettings is not normalized', {});
  }
  const executionSettingIds = new Set(executionSettings.map((setting) => setting.id));
  const executionSettingsById = new Map(executionSettings.map((setting) => [setting.id, setting]));

  const ids = new Set();
  const selectors = new Set();
  const allSelectors = new Set();
  for (let index = 0; index < catalog.models.length; index += 1) {
    const entry = requiredObject(catalog.models[index], `catalog.models[${index}]`);
    const id = requiredExactString(entry.id, `catalog.models[${index}].id`, 'INVALID_CATALOG');
    const selector = requiredExactString(
      entry.selector,
      `catalog.models[${index}].selector`,
      'INVALID_CATALOG',
    );
    if (ids.has(id) || selectors.has(selector) || allSelectors.has(id) || allSelectors.has(selector)) {
      fail('INVALID_CATALOG', 'catalog contains duplicate model ids or selectors', { id, selector });
    }
    ids.add(id);
    selectors.add(selector);
    allSelectors.add(id);
    allSelectors.add(selector);
    if (!Array.isArray(entry.aliases)) {
      fail('INVALID_CATALOG', 'catalog model aliases must be an array', { id });
    }
    const aliases = entry.aliases.map((alias, aliasIndex) => requiredExactString(
      alias,
      `catalog.models[${index}].aliases[${aliasIndex}]`,
      'INVALID_CATALOG',
    ));
    if (stableStringify([...aliases].sort(compareCodeUnits)) !== stableStringify(entry.aliases)) {
      fail('INVALID_CATALOG', 'catalog model aliases must be unique and code-unit sorted', { id });
    }
    for (const alias of aliases) {
      if (allSelectors.has(alias)) {
        fail('INVALID_CATALOG', 'catalog contains an ambiguous model alias', { id, alias });
      }
      allSelectors.add(alias);
    }
    if (typeof entry.hidden !== 'boolean' || typeof entry.isDefault !== 'boolean') {
      fail('INVALID_CATALOG', 'catalog model availability flags must be booleans', { id });
    }
    const lifecycle = requiredObject(
      entry.lifecycle,
      `catalog.models[${index}].lifecycle`,
      'INVALID_CATALOG',
    );
    assertKnownKeys(
      lifecycle,
      ['replacement', 'retirementAt', 'status'],
      `catalog.models[${index}].lifecycle`,
      'INVALID_CATALOG',
    );
    if (!['current', 'upgrade-only', 'retired'].includes(lifecycle.status)) {
      fail('INVALID_CATALOG', 'catalog model lifecycle status is invalid', { id });
    }
    const replacement = optionalExactString(
      lifecycle.replacement,
      `catalog.models[${index}].lifecycle.replacement`,
      'INVALID_CATALOG',
    );
    if (lifecycle.retirementAt !== null &&
        (!Number.isSafeInteger(lifecycle.retirementAt) || lifecycle.retirementAt < 0)) {
      fail('INVALID_CATALOG', 'catalog model retirementAt is invalid', { id });
    }
    if ((lifecycle.status === 'current') !== (replacement === null)) {
      fail('INVALID_CATALOG', 'catalog model lifecycle replacement is inconsistent', { id });
    }
    const efforts = normalizeEffortList(entry.efforts, `catalog.models[${index}].efforts`);
    if (stableStringify(efforts) !== stableStringify(entry.efforts)) {
      fail('INVALID_CATALOG', 'catalog model efforts are not normalized', { id });
    }
    const defaultEffort = optionalExactString(
      entry.defaultEffort,
      `catalog.models[${index}].defaultEffort`,
      'INVALID_CATALOG',
    );
    if (defaultEffort === null && efforts.length > 0) {
      fail('INVALID_CATALOG', 'catalog models with effort support require a default effort', { id });
    }
    if (defaultEffort !== null && !efforts.some((option) => option.level === defaultEffort)) {
      fail('INVALID_CATALOG', 'catalog model default effort is not supported', { id, defaultEffort });
    }
    const modelExecutionSettings = entry.executionSettings === undefined
      ? []
      : entry.executionSettings.map((setting, settingIndex) => requiredExactString(
        setting,
        `catalog.models[${index}].executionSettings[${settingIndex}]`,
        'INVALID_CATALOG',
      ));
    if (
      stableStringify([...new Set(modelExecutionSettings)].sort(compareCodeUnits))
      !== stableStringify(modelExecutionSettings)
    ) {
      fail('INVALID_CATALOG', 'catalog model execution settings must be unique and sorted', { id });
    }
    for (const setting of modelExecutionSettings) {
      if (!executionSettingIds.has(setting)) {
        fail('INVALID_CATALOG', 'catalog model references an undefined execution setting', {
          id,
          setting,
        });
      }
      const requiredEffort = executionSettingsById.get(setting).requiredEffort;
      if (requiredEffort !== null && !efforts.some((option) => option.level === requiredEffort)) {
        fail('INVALID_CATALOG', 'catalog model execution setting requires unsupported effort', {
          id,
          setting,
          requiredEffort,
        });
      }
    }
    const nativeTiers = normalizeNativeTiers(
      entry.nativeSpeedTiers,
      `catalog.models[${index}].nativeSpeedTiers`,
    );
    if (stableStringify(nativeTiers) !== stableStringify(entry.nativeSpeedTiers)) {
      fail('INVALID_CATALOG', 'catalog model native speed tiers are not normalized', { id });
    }
    const defaultNativeSpeedTier = optionalExactString(
      entry.defaultNativeSpeedTier,
      `catalog.models[${index}].defaultNativeSpeedTier`,
      'INVALID_CATALOG',
    );
    if (
      defaultNativeSpeedTier !== null
      && !nativeTiers.some((tier) => tier.id === defaultNativeSpeedTier)
    ) {
      fail('INVALID_CATALOG', 'catalog model default native speed tier is not advertised', {
        id,
        defaultNativeSpeedTier,
      });
    }
    if (!Object.prototype.hasOwnProperty.call(entry, 'speedCompatibility')) {
      fail('INVALID_CATALOG', 'catalog model must declare speedCompatibility', { id });
    }
    const modelCompatibility = normalizeSpeedCompatibility(
      entry.speedCompatibility,
      `catalog.models[${index}].speedCompatibility`,
    );
    if (stableStringify(modelCompatibility) !== stableStringify(entry.speedCompatibility)) {
      fail('INVALID_CATALOG', 'catalog model speedCompatibility is not normalized', { id });
    }
  }

  const globalCompatibility = normalizeSpeedCompatibility(
    catalog.speedCompatibility,
    'catalog.speedCompatibility',
  );
  if (stableStringify(globalCompatibility) !== stableStringify(catalog.speedCompatibility)) {
    fail('INVALID_CATALOG', 'catalog speedCompatibility is not normalized', {});
  }
  if (catalog.speedCompatibility !== null) {
    // Compatibility catalogs carry exact controls, so tier semantics do not apply.
  } else if (catalog.selectorPolicy.kind === 'validated-passthrough') {
    fail('INVALID_CATALOG', 'passthrough catalogs must declare speed compatibility', {});
  } else if (standardNativeTier === null) {
    fail('INVALID_CATALOG', 'catalog-only providers must identify the standard native tier', {});
  }
}

function findCatalogModel(catalog, selector) {
  const matches = catalog.models.filter((model) => (
    model.id === selector
    || model.selector === selector
    || model.aliases.includes(selector)
  ));
  if (matches.length > 1) {
    fail('AMBIGUOUS_MODEL', 'model selector matches multiple catalog entries', { selector });
  }
  if (matches.length === 1) return matches[0];
  return null;
}

function resolveModel(catalog, request, intentGuidance) {
  let selector = request.model;
  let selection = 'explicit';
  if (selector === null && request.intent !== 'provider-default') {
    selector = intentGuidance.model;
    selection = 'intent';
  }

  if (selector === null) {
    const defaults = catalog.models.filter((model) => (
      model.isDefault && !model.hidden && model.lifecycle.status === 'current'
    ));
    if (defaults.length > 1) {
      fail('AMBIGUOUS_DEFAULT_MODEL', 'catalog advertises multiple selectable default models', {
        ids: defaults.map((model) => model.id).sort(),
      });
    }
    if (defaults.length === 1) {
      return {
        model: defaults[0],
        selector: defaults[0].selector,
        catalogId: defaults[0].id,
        selection: 'provider-default',
      };
    }
    if (catalog.selectorPolicy.allowHostDefault) {
      return { model: null, selector: null, catalogId: null, selection: 'provider-default' };
    }
    fail('NO_DEFAULT_MODEL', 'catalog does not advertise exactly one selectable default model', {});
  }

  const catalogModel = findCatalogModel(catalog, selector);
  if (catalogModel !== null) {
    if (catalogModel.hidden) {
      fail('MODEL_UNAVAILABLE', 'selected model is hidden in the live catalog', {
        model: selector,
        catalogId: catalogModel.id,
      });
    }
    if (catalogModel.lifecycle.status !== 'current') {
      fail(
        catalogModel.lifecycle.status === 'retired' ? 'MODEL_RETIRED' : 'MODEL_UPGRADE_REQUIRED',
        'selected model is not a current selectable catalog entry',
        {
          model: selector,
          catalogId: catalogModel.id,
          lifecycle: catalogModel.lifecycle,
        },
      );
    }
    return {
      model: catalogModel,
      selector: catalogModel.selector,
      catalogId: catalogModel.id,
      selection,
    };
  }

  if (catalog.selectorPolicy.pattern !== undefined &&
      !new RegExp(catalog.selectorPolicy.pattern).test(selector)) {
    fail('INVALID_MODEL_SELECTOR', 'model selector is not accepted by the provider surface', { model: selector });
  }

  if (catalog.selectorPolicy.kind !== 'validated-passthrough') {
    fail('UNSUPPORTED_MODEL', 'selected model is not present in the live catalog', { model: selector });
  }
  const pattern = new RegExp(catalog.selectorPolicy.pattern);
  if (!pattern.test(selector)) {
    fail('INVALID_MODEL_SELECTOR', 'model selector is not accepted by the provider CLI', { model: selector });
  }
  return { model: null, selector, catalogId: null, selection };
}

function resolveExecutionSetting(catalog, request, modelResolution) {
  if (request.setting === undefined || request.setting === null) return null;
  const definitions = catalog.executionSettings === undefined ? [] : catalog.executionSettings;
  const setting = definitions.find((candidate) => candidate.id === request.setting);
  if (setting === undefined) {
    fail('UNSUPPORTED_EXECUTION_SETTING', 'execution setting is not supported by the provider surface', {
      provider: catalog.provider,
      setting: request.setting,
      supported: definitions.map((candidate) => candidate.id).sort(),
    });
  }
  if (modelResolution.model === null) {
    fail('UNRESOLVED_EXECUTION_SETTING', 'execution setting requires a catalog-resolved model', {
      provider: catalog.provider,
      setting: request.setting,
    });
  }
  const supported = modelResolution.model.executionSettings === undefined
    ? []
    : modelResolution.model.executionSettings;
  if (!supported.includes(setting.id)) {
    fail('UNSUPPORTED_EXECUTION_SETTING', 'execution setting is not supported for the selected model', {
      model: modelResolution.selector,
      setting: setting.id,
      supported,
    });
  }
  return {
    id: setting.id,
    requiredEffort: setting.requiredEffort,
    nativeControl: setting.nativeControl,
    selection: 'explicit',
  };
}

function resolveEffort(catalog, request, intentGuidance, modelResolution, settingResolution) {
  let level;
  let selection;
  if (
    request.effort !== null
    && settingResolution !== null
    && settingResolution.requiredEffort !== null
  ) {
    fail('CONFLICTING_EXECUTION_SETTING', 'execution setting owns the resolved effort level', {
      model: modelResolution.selector,
      setting: settingResolution.id,
      effort: request.effort,
      requiredEffort: settingResolution.requiredEffort,
    });
  }
  if (request.effort !== null) {
    level = request.effort;
    selection = 'explicit';
  } else if (settingResolution !== null && settingResolution.requiredEffort !== null) {
    level = settingResolution.requiredEffort;
    selection = 'execution-setting';
  } else if (request.model === null && request.intent !== 'provider-default' && intentGuidance.effort !== null) {
    level = intentGuidance.effort;
    selection = 'intent';
  } else if (modelResolution.model !== null) {
    level = modelResolution.model.defaultEffort;
    selection = 'documented-model-default';
  } else {
    level = null;
    selection = 'provider-default';
  }

  if (level === null) return { level: null, selection };
  const supported = modelResolution.model === null
    ? catalog.globalEfforts
    : modelResolution.model.efforts;
  if (!supported.some((option) => option.level === level)) {
    fail('UNSUPPORTED_EFFORT', 'effort is not supported for the selected model', {
      model: modelResolution.selector,
      effort: level,
      supported: supported.map((option) => option.level).sort(),
    });
  }
  return { level, selection };
}

function guidanceSpeedsForModel(guidance, modelResolution) {
  const keys = [];
  if (modelResolution.model !== null) keys.push(modelResolution.model.id);
  if (modelResolution.selector !== null) keys.push(modelResolution.selector);
  const mappings = keys
    .filter((key) => Object.prototype.hasOwnProperty.call(guidance.modelSpeeds, key))
    .map((key) => guidance.modelSpeeds[key]);
  if (mappings.length > 1 && stableStringify(mappings[0]) !== stableStringify(mappings[1])) {
    fail('INVALID_GUIDANCE', 'model id and selector have conflicting speed mappings', { keys });
  }
  return mappings.length > 0 ? mappings[0] : guidance.speeds;
}

function resolveSpeed(catalog, request, guidance, modelResolution) {
  if (request.speed === 'fast' && !request.speedExplicit) {
    fail('IMPLICIT_FAST_FORBIDDEN', 'premium fast speed must be requested explicitly', {});
  }

  const exactCompatibility = modelResolution.model !== null
    && modelResolution.model.speedCompatibility !== null
    ? modelResolution.model.speedCompatibility
    : catalog.speedCompatibility;
  if (exactCompatibility !== null) {
    const compatibility = exactCompatibility[request.speed];
    if (compatibility === null || compatibility === undefined) {
      fail('UNSUPPORTED_SPEED', 'speed is not supported by the provider surface', {
        provider: catalog.provider,
        speed: request.speed,
      });
    }
    return {
      mode: request.speed,
      nativeControl: compatibility.nativeControl,
      selection: request.speedExplicit ? 'explicit' : 'implicit-standard',
    };
  }

  if (modelResolution.model === null) {
    fail('INVALID_CATALOG', 'catalog-only speed resolution requires a catalog model', {});
  }
  const nativeTiers = modelResolution.model.nativeSpeedTiers;
  const speedMapping = guidanceSpeedsForModel(guidance, modelResolution);
  if (speedMapping === null || !Object.prototype.hasOwnProperty.call(speedMapping, request.speed)) {
    fail('UNRESOLVED_SPEED', 'guidance does not map the requested speed to a native tier', {
      model: modelResolution.selector,
      speed: request.speed,
    });
  }

  const nativeTier = speedMapping[request.speed];
  if (nativeTier === null) {
    fail('UNSAFE_SPEED_MAPPING', 'an omitted native tier cannot prove the requested speed', {
      model: modelResolution.selector,
      speed: request.speed,
    });
  }
  if (request.speed === 'standard' && nativeTier !== catalog.standardNativeTier) {
    fail('UNSAFE_SPEED_MAPPING', 'standard speed must use the catalog-attested standard tier', {
      model: modelResolution.selector,
      nativeTier,
      expected: catalog.standardNativeTier,
    });
  }
  if (!(request.speed === 'standard' && nativeTier === catalog.standardNativeTier) &&
      !nativeTiers.some((tier) => tier.id === nativeTier)) {
    fail('STALE_SPEED_GUIDANCE', 'mapped speed tier is not advertised by the live catalog', {
      model: modelResolution.selector,
      speed: request.speed,
      nativeTier,
      advertised: nativeTiers.map((tier) => tier.id).sort(),
    });
  }

  if (
    request.speed === 'fast'
    && (
      speedMapping.standard === nativeTier
      || nativeTier === catalog.standardNativeTier
    )
  ) {
    fail('INVALID_GUIDANCE', 'standard and fast cannot map to the same native tier', {
      model: modelResolution.selector,
      nativeTier,
    });
  }

  return {
    mode: request.speed,
    nativeControl: { kind: 'service-tier', value: nativeTier },
    selection: request.speedExplicit ? 'explicit' : 'implicit-standard',
  };
}

function resolveExecutionProfile({ provider, request = {}, catalog, guidance = {} } = {}) {
  const normalizedProvider = requiredExactString(provider, 'provider', 'INVALID_REQUEST');
  validateNormalizedCatalog(catalog, normalizedProvider);
  const normalizedRequest = normalizeExecutionRequest(request);
  const normalizedGuidance = normalizeGuidance(guidance, normalizedProvider);

  let intentGuidance = { model: null, effort: null };
  if (normalizedRequest.intent !== 'provider-default') {
    intentGuidance = normalizedGuidance.intents[normalizedRequest.intent];
    if (intentGuidance === undefined) {
      fail('UNRESOLVED_INTENT', 'guidance does not define the requested intent', {
        intent: normalizedRequest.intent,
        provider: normalizedProvider,
      });
    }
  }

  const modelResolution = resolveModel(catalog, normalizedRequest, intentGuidance);
  const settingResolution = resolveExecutionSetting(catalog, normalizedRequest, modelResolution);
  const effortResolution = resolveEffort(
    catalog,
    normalizedRequest,
    intentGuidance,
    modelResolution,
    settingResolution,
  );
  const speedResolution = resolveSpeed(
    catalog,
    normalizedRequest,
    normalizedGuidance,
    modelResolution,
  );

  return toJsonSafe({
    profileVersion: PROFILE_VERSION,
    provider: normalizedProvider,
    requested: normalizedRequest,
    resolved: {
      model: {
        selector: modelResolution.selector,
        catalogId: modelResolution.catalogId,
        selection: modelResolution.selection,
      },
      effort: effortResolution,
      ...(settingResolution === null ? {} : { setting: {
        id: settingResolution.id,
        nativeControl: settingResolution.nativeControl,
        selection: settingResolution.selection,
      } }),
      speed: speedResolution,
      catalogSource: catalog.source,
      guidanceSource: normalizedGuidance.source,
    },
    observed: null,
  });
}

function resolveCodexExecutionProfile({ request = {}, modelList, guidance = {}, source } = {}) {
  const catalog = catalogFromCodexModelList(modelList, { source });
  return resolveExecutionProfile({ provider: 'codex', request, catalog, guidance });
}

function resolveClaudeExecutionProfile({ request = {}, guidance = {}, source } = {}) {
  const catalog = createClaudeCliCatalog({ source });
  let expandedRequest = request;
  if (isPlainObject(request) && request.effort === 'ultracode') {
    if (request.setting !== undefined && request.setting !== 'ultracode') {
      fail('INVALID_REQUEST', 'Claude ultracode shorthand conflicts with request.setting', {
        setting: request.setting,
      });
    }
    const { effort: _shorthand, ...rest } = request;
    expandedRequest = { ...rest, setting: 'ultracode' };
  }
  return resolveExecutionProfile({ provider: 'claude', request: expandedRequest, catalog, guidance });
}

function validateUnobservedProfile(profile) {
  const safe = toJsonSafe(profile, 'profile');
  requiredObject(safe, 'profile', 'INVALID_PROFILE');
  assertKnownKeys(
    safe,
    ['observed', 'profileVersion', 'provider', 'requested', 'resolved'],
    'profile',
    'INVALID_PROFILE',
  );
  if (safe.profileVersion !== PROFILE_VERSION || safe.observed !== null) {
    fail('INVALID_PROFILE', 'profile must be an unobserved execution profile', {});
  }
  requiredExactString(safe.provider, 'profile.provider', 'INVALID_PROFILE');

  const requested = requiredObject(safe.requested, 'profile.requested', 'INVALID_PROFILE');
  assertKnownKeys(
    requested,
    ['effort', 'intent', 'model', 'setting', 'speed', 'speedExplicit'],
    'profile.requested',
    'INVALID_PROFILE',
  );
  if (!INTENTS.includes(requested.intent)) {
    fail('INVALID_PROFILE', 'profile requested intent is invalid', { intent: requested.intent });
  }
  optionalExactString(requested.model, 'profile.requested.model', 'INVALID_PROFILE');
  optionalExactString(requested.effort, 'profile.requested.effort', 'INVALID_PROFILE');
  const requestedSetting = optionalExactString(
    requested.setting,
    'profile.requested.setting',
    'INVALID_PROFILE',
  );
  if (!SPEEDS.includes(requested.speed) || typeof requested.speedExplicit !== 'boolean') {
    fail('INVALID_PROFILE', 'profile requested speed fields are invalid', {});
  }
  if (requested.speed === 'fast' && !requested.speedExplicit) {
    fail('INVALID_PROFILE', 'profile cannot contain implicitly requested fast speed', {});
  }

  const resolved = requiredObject(safe.resolved, 'profile.resolved', 'INVALID_PROFILE');
  assertKnownKeys(
    resolved,
    ['catalogSource', 'effort', 'guidanceSource', 'model', 'setting', 'speed'],
    'profile.resolved',
    'INVALID_PROFILE',
  );
  normalizeSource(resolved.catalogSource, 'provider-catalog');
  if (resolved.guidanceSource !== null) normalizeSource(resolved.guidanceSource, 'guidance');

  const resolvedModel = requiredObject(resolved.model, 'profile.resolved.model', 'INVALID_PROFILE');
  assertKnownKeys(
    resolvedModel,
    ['catalogId', 'selection', 'selector'],
    'profile.resolved.model',
    'INVALID_PROFILE',
  );
  const modelSelector = optionalExactString(
    resolvedModel.selector,
    'profile.resolved.model.selector',
    'INVALID_PROFILE',
  );
  const catalogId = optionalExactString(
    resolvedModel.catalogId,
    'profile.resolved.model.catalogId',
    'INVALID_PROFILE',
  );
  if (!['explicit', 'intent', 'provider-default'].includes(resolvedModel.selection)) {
    fail('INVALID_PROFILE', 'profile resolved model selection is invalid', {});
  }
  if (catalogId !== null && modelSelector === null) {
    fail('INVALID_PROFILE', 'catalog model id requires a resolved selector', {});
  }
  if (requested.model !== null && resolvedModel.selection !== 'explicit') {
    fail('INVALID_PROFILE', 'explicit requested model must remain explicit in resolution', {});
  }

  const resolvedEffort = requiredObject(resolved.effort, 'profile.resolved.effort', 'INVALID_PROFILE');
  assertKnownKeys(
    resolvedEffort,
    ['level', 'selection'],
    'profile.resolved.effort',
    'INVALID_PROFILE',
  );
  optionalExactString(resolvedEffort.level, 'profile.resolved.effort.level', 'INVALID_PROFILE');
  if (![
    'explicit',
    'intent',
    'documented-model-default',
    'execution-setting',
    'provider-default',
  ].includes(resolvedEffort.selection)) {
    fail('INVALID_PROFILE', 'profile resolved effort selection is invalid', {});
  }
  if (requested.effort !== null && resolvedEffort.selection !== 'explicit') {
    fail('INVALID_PROFILE', 'explicit requested effort must remain explicit in resolution', {});
  }

  const resolvedSetting = resolved.setting === undefined ? null : resolved.setting;
  if (requestedSetting === null && resolvedSetting !== null) {
    fail('INVALID_PROFILE', 'profile resolved an execution setting that was not requested', {});
  }
  if (requestedSetting !== null) {
    const setting = requiredObject(
      resolvedSetting,
      'profile.resolved.setting',
      'INVALID_PROFILE',
    );
    assertKnownKeys(
      setting,
      ['id', 'nativeControl', 'selection'],
      'profile.resolved.setting',
      'INVALID_PROFILE',
    );
    if (setting.id !== requestedSetting || setting.selection !== 'explicit') {
      fail('INVALID_PROFILE', 'resolved execution setting does not match the request', {});
    }
    const settingControl = normalizeNativeControl(
      setting.nativeControl,
      'profile.resolved.setting.nativeControl',
      'INVALID_PROFILE',
    );
    if (settingControl === null) {
      fail('INVALID_PROFILE', 'resolved execution setting requires a native control', {});
    }
    if (safe.provider === 'claude' && (
      setting.id !== 'ultracode'
      || resolvedEffort.level !== 'xhigh'
      || resolvedEffort.selection !== 'execution-setting'
      || settingControl.kind !== 'claude-effort-flag'
      || settingControl.value !== 'ultracode'
    )) {
      fail('INVALID_PROFILE', 'Claude ultracode setting does not match its xhigh native control', {});
    }
  }

  const resolvedSpeed = requiredObject(resolved.speed, 'profile.resolved.speed', 'INVALID_PROFILE');
  assertKnownKeys(
    resolvedSpeed,
    ['mode', 'nativeControl', 'selection'],
    'profile.resolved.speed',
    'INVALID_PROFILE',
  );
  if (!SPEEDS.includes(resolvedSpeed.mode) || resolvedSpeed.mode !== requested.speed) {
    fail('INVALID_PROFILE', 'resolved speed does not match the requested speed', {});
  }
  const nativeControl = normalizeNativeControl(
    resolvedSpeed.nativeControl,
    'profile.resolved.speed.nativeControl',
    'INVALID_PROFILE',
  );
  const expectedSpeedSelection = requested.speedExplicit ? 'explicit' : 'implicit-standard';
  if (resolvedSpeed.selection !== expectedSpeedSelection) {
    fail('INVALID_PROFILE', 'resolved speed selection provenance is invalid', {});
  }
  if (nativeControl === null) {
    fail('INVALID_PROFILE', 'resolved speed requires an explicit native control', {});
  }
  if (safe.provider === 'codex' && (nativeControl.kind !== 'service-tier' ||
      nativeControl.value !== (resolvedSpeed.mode === 'standard' ? 'default' : 'priority'))) {
    fail('INVALID_PROFILE', 'Codex speed mode does not match its native service tier', {});
  }
  if (safe.provider === 'claude' && (nativeControl.kind !== 'fast-mode' ||
      nativeControl.value !== (resolvedSpeed.mode === 'fast'))) {
    fail('INVALID_PROFILE', 'Claude speed mode does not match its native fast-mode control', {});
  }
  return safe;
}

function requestFromProfile(profile) {
  const safe = validateUnobservedProfile(profile);
  return {
    intent: safe.requested.intent,
    ...(safe.requested.model !== null ? { model: safe.requested.model } : {}),
    ...(safe.requested.effort !== null ? { effort: safe.requested.effort } : {}),
    ...(safe.requested.setting !== undefined && safe.requested.setting !== null
      ? { setting: safe.requested.setting }
      : {}),
    ...(safe.requested.speedExplicit ? { speed: safe.requested.speed } : {}),
  };
}

function withObservedExecution(profile, observation) {
  const safeProfile = validateUnobservedProfile(profile);
  requiredObject(observation, 'observation', 'INVALID_OBSERVATION');
  assertKnownKeys(
    observation,
    ['effort', 'model', 'nativeControl', 'receipt', 'speed'],
    'observation',
    'INVALID_OBSERVATION',
  );
  const speed = observation.speed === undefined || observation.speed === null
    ? null
    : observation.speed;
  if (speed !== null && !SPEEDS.includes(speed)) {
    fail('INVALID_OBSERVATION', 'observation.speed is not supported', { speed });
  }
  return toJsonSafe({
    ...safeProfile,
    observed: {
      model: optionalExactString(observation.model, 'observation.model', 'INVALID_OBSERVATION'),
      effort: optionalExactString(observation.effort, 'observation.effort', 'INVALID_OBSERVATION'),
      speed,
      nativeControl: observation.nativeControl === undefined
        ? null
        : normalizeNativeControl(
          observation.nativeControl,
          'observation.nativeControl',
          'INVALID_OBSERVATION',
        ),
      receipt: observation.receipt === undefined ? null : toJsonSafe(observation.receipt, 'observation.receipt'),
    },
  });
}

module.exports = {
  CLAUDE_CLI_COMPATIBILITY_VERIFIED_AT,
  CLAUDE_CLI_COMPATIBILITY_VERSION,
  CLAUDE_EFFORTS,
  CLAUDE_EXECUTION_SETTINGS,
  CLAUDE_MODEL_SELECTOR_PATTERN,
  ExecutionProfileError,
  INTENTS,
  PROFILE_VERSION,
  SPEEDS,
  catalogFromCodexModelList,
  createClaudeCliCatalog,
  normalizeExecutionRequest,
  requestFromProfile,
  resolveClaudeExecutionProfile,
  resolveCodexExecutionProfile,
  resolveExecutionProfile,
  stableStringify,
  toJsonSafe,
  validateUnobservedProfile,
  withObservedExecution,
};
