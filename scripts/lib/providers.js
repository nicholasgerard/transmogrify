'use strict';

// The provider registry: one adapter module per provider, each publishing a
// descriptor (target, backend, operations, accepted flags, recovery input).
// Every command line and observer resolves providers through this table, so
// adding a provider is one adapter module plus one entry here.

const codex = require('./codex-adapter');
const claude = require('./claude-adapter');

const PROVIDERS = new Map([codex, claude].map((adapter) => [
  adapter.descriptor.target, { ...adapter.descriptor, adapter },
]));
const TARGETS = [...PROVIDERS.keys()];
// Command-line flags that belong to one provider or another.
const PROVIDER_FLAGS = ['url', 'claude-bin', 'private-archive', 'finish-retirements', 'allow-protocol-only'];

function providerForTarget(target) {
  return PROVIDERS.get(target) || null;
}

function providerForBackend(backend) {
  for (const provider of PROVIDERS.values()) {
    if (provider.backend === backend) return provider;
  }
  return null;
}

// The targets that accept a provider flag, for refusal messages.
function targetsAccepting(flag) {
  return [...PROVIDERS.values()]
    .filter((entry) => entry.options.has(flag))
    .map((entry) => entry.target);
}

module.exports = {
  PROVIDERS,
  PROVIDER_FLAGS,
  TARGETS,
  providerForBackend,
  providerForTarget,
  targetsAccepting,
};
