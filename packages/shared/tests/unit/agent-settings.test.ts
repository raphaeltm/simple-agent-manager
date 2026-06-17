import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OPENCODE_PROVIDER,
  DEFAULT_OPENCODE_ZEN_MODEL,
  OPENCODE_PROVIDER_OPTIONS,
  OPENCODE_PROVIDERS,
  resolveOpenCodeProvider,
} from '../../src/types/agent-settings';

describe('OpenCode provider settings', () => {
  it('includes OpenCode Zen provider metadata first in dropdown order', () => {
    expect(OPENCODE_PROVIDER_OPTIONS).toEqual([
      'opencode-zen',
      'platform',
      'scaleway',
      'google-vertex',
      'openai-compatible',
      'anthropic',
      'custom',
    ]);

    expect(OPENCODE_PROVIDERS['opencode-zen']).toMatchObject({
      label: 'OpenCode Zen',
      modelPlaceholder: `e.g. ${DEFAULT_OPENCODE_ZEN_MODEL}`,
      requiresBaseUrl: false,
      requiresApiKey: true,
      keyLabel: 'OpenCode Zen API Key',
    });
  });

  it('resolves null and legacy managed provider values to OpenCode Zen', () => {
    expect(DEFAULT_OPENCODE_PROVIDER).toBe('opencode-zen');
    expect(resolveOpenCodeProvider(null)).toBe('opencode-zen');
    expect(resolveOpenCodeProvider(undefined)).toBe('opencode-zen');
    expect(resolveOpenCodeProvider('not-a-provider')).toBe('opencode-zen');
    expect(resolveOpenCodeProvider('opencode-managed')).toBe('opencode-zen');
    expect(resolveOpenCodeProvider('scaleway')).toBe('scaleway');
  });
});
