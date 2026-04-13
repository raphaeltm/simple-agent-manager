import { describe, expect,it } from 'vitest';

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
    expect(mistral!.description).toBe("Mistral AI's coding agent");
    expect(mistral!.provider).toBe('mistral');
    expect(mistral!.envVarName).toBe('MISTRAL_API_KEY');
    expect(mistral!.acpCommand).toBe('vibe-acp');
    expect(mistral!.acpArgs).toEqual([]);
    expect(mistral!.supportsAcp).toBe(true);
    expect(mistral!.credentialHelpUrl).toBe(
      'https://console.mistral.ai/api-keys'
    );
    expect(mistral!.installCommand).toBe(
      'curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh && UV_TOOL_DIR=/opt/uv-tools UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_TOOL_BIN_DIR=/usr/local/bin uv tool install mistral-vibe==2.7.0 --python 3.12 --quiet'
    );
  });

  it('includes opencode as a supported agent', () => {
    const opencode = AGENT_CATALOG.find((a) => a.id === 'opencode');
    expect(opencode).toBeDefined();
    expect(opencode!.name).toBe('OpenCode');
    expect(opencode!.description).toBe(
      'Open-source AI coding agent by SST. Uses Scaleway Generative APIs for inference.'
    );
    expect(opencode!.provider).toBe('opencode');
    expect(opencode!.envVarName).toBe('SCW_SECRET_KEY');
    expect(opencode!.acpCommand).toBe('opencode');
    expect(opencode!.acpArgs).toEqual(['acp']);
    expect(opencode!.supportsAcp).toBe(true);
    expect(opencode!.credentialHelpUrl).toBe(
      'https://console.scaleway.com/iam/api-keys'
    );
    expect(opencode!.installCommand).toBe('npm install -g opencode-ai@1.4.3');
  });

  it('opencode has no OAuth support', () => {
    const opencode = AGENT_CATALOG.find((a) => a.id === 'opencode');
    expect(opencode!.oauthSupport).toBeUndefined();
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
  });

  it('rejects unknown agents', () => {
    expect(isValidAgentType('unknown-agent')).toBe(false);
    expect(isValidAgentType('')).toBe(false);
  });
});
