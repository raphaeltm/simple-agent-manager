import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OPENCODE_GO_MODEL,
  DEFAULT_OPENCODE_PROVIDER,
  DEFAULT_OPENCODE_ZEN_MODEL,
  OPENCODE_PROVIDER_OPTIONS,
  OPENCODE_PROVIDERS,
  resolveOpenCodeProvider,
} from '../../src/types/agent-settings';

describe('OpenCode provider settings', () => {
  it('exposes only zen/go/custom provider options with zen first', () => {
    expect(OPENCODE_PROVIDER_OPTIONS).toEqual([
      'opencode-zen',
      'opencode-go',
      'custom',
    ]);

    expect(OPENCODE_PROVIDERS['opencode-zen']).toMatchObject({
      label: 'OpenCode Zen',
      modelPlaceholder: `e.g. ${DEFAULT_OPENCODE_ZEN_MODEL}`,
      requiresBaseUrl: false,
      requiresApiKey: true,
      keyLabel: 'OpenCode API Key',
    });

    expect(OPENCODE_PROVIDERS['opencode-go']).toMatchObject({
      label: 'OpenCode Go',
      modelPlaceholder: `e.g. ${DEFAULT_OPENCODE_GO_MODEL}`,
      requiresBaseUrl: false,
      requiresApiKey: true,
      keyLabel: 'OpenCode API Key',
    });

    expect(OPENCODE_PROVIDERS['custom']).toMatchObject({
      requiresBaseUrl: true,
      requiresApiKey: true,
    });
  });

  it('resolves null and legacy/removed provider values to OpenCode Zen', () => {
    expect(DEFAULT_OPENCODE_PROVIDER).toBe('opencode-zen');
    expect(resolveOpenCodeProvider(null)).toBe('opencode-zen');
    expect(resolveOpenCodeProvider(undefined)).toBe('opencode-zen');
    expect(resolveOpenCodeProvider('not-a-provider')).toBe('opencode-zen');
    expect(resolveOpenCodeProvider('opencode-managed')).toBe('opencode-zen');
    expect(resolveOpenCodeProvider('platform')).toBe('opencode-zen');
    expect(resolveOpenCodeProvider('scaleway')).toBe('opencode-zen');
    expect(resolveOpenCodeProvider('google-vertex')).toBe('opencode-zen');
    expect(resolveOpenCodeProvider('anthropic')).toBe('opencode-zen');
    expect(resolveOpenCodeProvider('openai-compatible')).toBe('opencode-zen');
    expect(resolveOpenCodeProvider('opencode-go')).toBe('opencode-go');
    expect(resolveOpenCodeProvider('custom')).toBe('custom');
  });
});
