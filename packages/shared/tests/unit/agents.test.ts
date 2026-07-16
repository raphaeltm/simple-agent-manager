import { describe, expect, it } from 'vitest';

import { AGENT_CATALOG, getAgentDefinition, isValidAgentType } from '../../src/agents';

describe('AGENT_CATALOG', () => {
  it('includes mistral-vibe as a supported agent', () => {
    const mistral = AGENT_CATALOG.find((a) => a.id === 'mistral-vibe');
    expect(mistral).toBeDefined();
    expect(mistral!.name).toBe('Mistral Vibe');
    expect(mistral!.description).toBe("Mistral AI's coding agent");
    expect(mistral!.provider).toBe('mistral');
    expect(mistral!.envVarName).toBe('MISTRAL_API_KEY');
    expect(mistral!.acpCommand).toBe('vibe-acp');
    expect(mistral!.acpArgs).toEqual([]);
    expect(mistral!.supportsAcp).toBe(true);
    expect(mistral!.credentialHelpUrl).toBe('https://console.mistral.ai/api-keys');
  });

  it('includes opencode as a supported agent', () => {
    const opencode = AGENT_CATALOG.find((a) => a.id === 'opencode');
    expect(opencode).toBeDefined();
    expect(opencode!.name).toBe('OpenCode');
    expect(opencode!.description).toBe(
      'Open-source AI coding agent by SST. Uses OpenCode managed inference.'
    );
    expect(opencode!.provider).toBe('opencode');
    expect(opencode!.envVarName).toBe('OPENCODE_API_KEY');
    expect(opencode!.acpCommand).toBe('opencode');
    expect(opencode!.acpArgs).toEqual(['acp']);
    expect(opencode!.supportsAcp).toBe(true);
    expect(opencode!.credentialHelpUrl).toBe('https://opencode.ai/auth');
    expect(opencode!.fallbackCloudProvider).toBeUndefined();
  });

  it('includes Gemini CLI as a supported ACP agent', () => {
    const gemini = AGENT_CATALOG.find((a) => a.id === 'google-gemini');
    expect(gemini).toBeDefined();
    expect(gemini!.name).toBe('Gemini CLI');
    expect(gemini!.provider).toBe('google');
    expect(gemini!.envVarName).toBe('GEMINI_API_KEY');
    expect(gemini!.acpCommand).toBe('gemini');
    expect(gemini!.acpArgs).toEqual(['--acp']);
    expect(gemini!.supportsAcp).toBe(true);
    expect(gemini!.oauthSupport).toBeUndefined();
  });

  it('uses the maintained Codex ACP wrapper for OpenAI Codex', () => {
    const codex = AGENT_CATALOG.find((a) => a.id === 'openai-codex');
    expect(codex).toMatchObject({
      acpCommand: 'codex-acp',
      supportsAcp: true,
    });
    expect(codex?.oauthSupport?.envVarName).toBe('CODEX_AUTH_JSON');
  });

  it('opencode has no OAuth support', () => {
    const opencode = AGENT_CATALOG.find((a) => a.id === 'opencode');
    expect(opencode!.oauthSupport).toBeUndefined();
  });

  it('includes amp as a supported API-key ACP agent', () => {
    const amp = AGENT_CATALOG.find((a) => a.id === 'amp');
    expect(amp).toBeDefined();
    expect(amp!.name).toBe('Amp');
    expect(amp!.description).toBe("Sourcegraph's managed AI coding agent");
    expect(amp!.provider).toBe('amp');
    expect(amp!.envVarName).toBe('AMP_API_KEY');
    expect(amp!.acpCommand).toBe('acp-amp');
    expect(amp!.acpArgs).toEqual(['run']);
    expect(amp!.supportsAcp).toBe(true);
    expect(amp!.credentialHelpUrl).toBe('https://ampcode.com/settings');
    expect(amp!.fallbackCloudProvider).toBeUndefined();
    expect(amp!.oauthSupport).toBeUndefined();
  });

  it('mistral-vibe has no OAuth support', () => {
    const mistral = AGENT_CATALOG.find((a) => a.id === 'mistral-vibe');
    expect(mistral!.oauthSupport).toBeUndefined();
  });

  it('all catalog entries have unique IDs', () => {
    const ids = AGENT_CATALOG.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('getAgentDefinition', () => {
  it('returns mistral-vibe definition', () => {
    const def = getAgentDefinition('mistral-vibe');
    expect(def).toBeDefined();
    expect(def!.id).toBe('mistral-vibe');
  });

  it('returns opencode definition', () => {
    const def = getAgentDefinition('opencode');
    expect(def).toBeDefined();
    expect(def!.id).toBe('opencode');
    expect(def!.provider).toBe('opencode');
  });

  it('returns amp definition', () => {
    const def = getAgentDefinition('amp');
    expect(def).toBeDefined();
    expect(def!.id).toBe('amp');
    expect(def!.provider).toBe('amp');
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
    expect(isValidAgentType('opencode')).toBe(true);
    expect(isValidAgentType('amp')).toBe(true);
  });

  it('rejects unknown agents', () => {
    expect(isValidAgentType('unknown-agent')).toBe(false);
    expect(isValidAgentType('')).toBe(false);
  });
});
