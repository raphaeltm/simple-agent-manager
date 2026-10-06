import { describe, expect, it } from 'vitest';

import { AGENT_CATALOG } from '../../src/agents';
import {
  AUTH_STYLE_VALUES,
  DIALECT_VALUES,
  HARNESS_CAPABILITIES,
  resolveHarnessDialect,
} from '../../src/harness-capabilities';

const byName = (a: string, b: string) => a.localeCompare(b);

describe('harness capability registry', () => {
  it('has exactly one row per agent catalog id', () => {
    const catalogIds = AGENT_CATALOG.map((agent) => agent.id).sort(byName);
    const capabilityIds = HARNESS_CAPABILITIES.map((capability) => capability.agentType).sort(
      byName
    );

    expect(capabilityIds).toEqual(catalogIds);
  });

  it('does not contain duplicate agentType rows', () => {
    const ids = HARNESS_CAPABILITIES.map((capability) => capability.agentType);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses valid dialect and auth-style enum values', () => {
    for (const capability of HARNESS_CAPABILITIES) {
      expect(capability.dialects.length).toBeGreaterThan(0);
      for (const dialect of capability.dialects) {
        expect(DIALECT_VALUES).toContain(dialect);
      }
      expect(AUTH_STYLE_VALUES).toContain(capability.authStyle);
    }
  });

  it('captures current descriptor rows', () => {
    expect(HARNESS_CAPABILITIES).toMatchInlineSnapshot(`
      [
        {
          "agentType": "claude-code",
          "authEnvVar": "ANTHROPIC_API_KEY",
          "authStyle": "api-key",
          "baseUrlEnvVar": "ANTHROPIC_BASE_URL",
          "dialects": [
            "anthropic",
          ],
          "proxyProviderTag": "anthropic-passthrough",
          "proxyRouteSegment": "anthropic",
        },
        {
          "agentType": "openai-codex",
          "authEnvVar": "OPENAI_API_KEY",
          "authStyle": "api-key",
          "baseUrlEnvVar": "OPENAI_BASE_URL",
          "dialects": [
            "openai-compatible",
          ],
          "proxyProviderTag": "openai-passthrough",
          "proxyRouteSegment": "openai/v1",
        },
        {
          "agentType": "google-gemini",
          "authEnvVar": "GEMINI_API_KEY",
          "authStyle": "api-key",
          "dialects": [
            "gemini",
          ],
          "proxyProviderTag": "",
          "proxyRouteSegment": "",
        },
        {
          "agentType": "mistral-vibe",
          "authEnvVar": "MISTRAL_API_KEY",
          "authStyle": "api-key",
          "dialects": [
            "native",
          ],
          "proxyProviderTag": "",
          "proxyRouteSegment": "",
        },
        {
          "agentType": "opencode",
          "authEnvVar": "OPENCODE_API_KEY",
          "authStyle": "api-key",
          "dialects": [
            "openai-compatible",
          ],
          "proxyProviderTag": "openai-passthrough",
          "proxyRouteSegment": "openai/v1",
          "usesOpencodeConfig": true,
        },
        {
          "agentType": "amp",
          "authEnvVar": "AMP_API_KEY",
          "authStyle": "api-key",
          "dialects": [
            "native",
          ],
          "proxyProviderTag": "",
          "proxyRouteSegment": "",
        },
      ]
    `);
  });

  it('resolves compatible harness dialects and rejects incompatible pairs', () => {
    expect(resolveHarnessDialect('claude-code', 'anthropic')?.agentType).toBe('claude-code');
    expect(resolveHarnessDialect('openai-codex', 'openai-compatible')?.agentType).toBe(
      'openai-codex'
    );
    expect(resolveHarnessDialect('google-gemini', 'gemini')?.agentType).toBe('google-gemini');
    expect(resolveHarnessDialect('opencode', 'openai-compatible')?.agentType).toBe('opencode');

    expect(resolveHarnessDialect('claude-code', 'openai-compatible')).toBeNull();
    expect(resolveHarnessDialect('openai-codex', 'anthropic')).toBeNull();
    expect(resolveHarnessDialect('opencode', 'anthropic')).toBeNull();
    expect(resolveHarnessDialect('amp', 'gemini')).toBeNull();
    expect(resolveHarnessDialect('unknown-agent', 'anthropic')).toBeNull();
  });
});
