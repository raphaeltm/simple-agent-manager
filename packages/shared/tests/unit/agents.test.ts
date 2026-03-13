import { describe, it, expect } from 'vitest';
import {
  AGENT_CATALOG,
  getAgentDefinition,
  isValidAgentType,
} from '../../src/agents';

describe('AGENT_CATALOG', () => {
  it('includes mistral-vibe as a supported agent', () => {
    const mistral = AGENT_CATALOG.find((a) => a.id === 'mistral-vibe');
    expect(mistral).toBeDefined();
    expect(mistral!.name).toBe('Mistral Vibe');
    expect(mistral!.provider).toBe('mistral');
    expect(mistral!.envVarName).toBe('MISTRAL_API_KEY');
    expect(mistral!.acpCommand).toBe('vibe-acp');
    expect(mistral!.acpArgs).toEqual([]);
    expect(mistral!.supportsAcp).toBe(true);
    expect(mistral!.credentialHelpUrl).toBe(
      'https://console.mistral.ai/api-keys'
    );
    expect(mistral!.installCommand).toContain('vibe-acp');
  });

  it('mistral-vibe has no OAuth support', () => {
    const mistral = AGENT_CATALOG.find((a) => a.id === 'mistral-vibe');
    expect(mistral!.oauthSupport).toBeUndefined();
  });

  it('all catalog entries have unique IDs', () => {
    const ids = AGENT_CATALOG.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all catalog entries have unique providers', () => {
    const providers = AGENT_CATALOG.map((a) => a.provider);
    expect(new Set(providers).size).toBe(providers.length);
  });
});

describe('getAgentDefinition', () => {
  it('returns mistral-vibe definition', () => {
    const def = getAgentDefinition('mistral-vibe');
    expect(def).toBeDefined();
    expect(def!.id).toBe('mistral-vibe');
  });

  it('returns undefined for unknown agent', () => {
    const def = getAgentDefinition('unknown' as never);
    expect(def).toBeUndefined();
  });
});

describe('isValidAgentType', () => {
  it('accepts mistral-vibe', () => {
    expect(isValidAgentType('mistral-vibe')).toBe(true);
  });

  it('accepts all known agents', () => {
    expect(isValidAgentType('claude-code')).toBe(true);
    expect(isValidAgentType('openai-codex')).toBe(true);
    expect(isValidAgentType('google-gemini')).toBe(true);
    expect(isValidAgentType('mistral-vibe')).toBe(true);
  });

  it('rejects unknown agents', () => {
    expect(isValidAgentType('unknown-agent')).toBe(false);
    expect(isValidAgentType('')).toBe(false);
  });
});
