import { describe, expect, it } from 'vitest';

import { OPENCODE_PROVIDER_OPTIONS, OPENCODE_PROVIDERS } from '../../src/types/agent-settings';

describe('OpenCode provider settings', () => {
  it('includes OpenCode managed provider metadata in dropdown order', () => {
    expect(OPENCODE_PROVIDER_OPTIONS).toEqual([
      'platform',
      'scaleway',
      'opencode-managed',
      'google-vertex',
      'openai-compatible',
      'anthropic',
      'custom',
    ]);

    expect(OPENCODE_PROVIDERS['opencode-managed']).toMatchObject({
      label: 'OpenCode Managed',
      requiresBaseUrl: false,
      requiresApiKey: true,
      keyLabel: 'OpenCode API Key',
    });
  });
});
