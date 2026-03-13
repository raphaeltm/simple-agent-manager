import { describe, expect, it } from 'vitest';
import { AGENT_CATALOG, getAgentDefinition, isValidAgentType } from '../../src/agents';

describe('Agent Catalog', () => {
  it('should include mistral-vibe in the catalog', () => {
    const vibe = AGENT_CATALOG.find((a) => a.id === 'mistral-vibe');
    expect(vibe).toBeDefined();
    expect(vibe!.name).toBe('Mistral Vibe');
    expect(vibe!.provider).toBe('mistral');
    expect(vibe!.envVarName).toBe('MISTRAL_API_KEY');
    expect(vibe!.acpCommand).toBe('vibe-acp');
    expect(vibe!.supportsAcp).toBe(true);
    expect(vibe!.acpArgs).toEqual([]);
  });

  it('should not have oauthSupport for mistral-vibe', () => {
    const vibe = AGENT_CATALOG.find((a) => a.id === 'mistral-vibe');
    expect(vibe!.oauthSupport).toBeUndefined();
  });

  it('should use curl-based install command for mistral-vibe', () => {
    const vibe = AGENT_CATALOG.find((a) => a.id === 'mistral-vibe');
    expect(vibe!.installCommand).toContain('curl');
    expect(vibe!.installCommand).toContain('vibe-acp');
    expect(vibe!.installCommand).not.toContain('npm');
  });

  it('should contain all expected agents by ID', () => {
    const ids = AGENT_CATALOG.map((a) => a.id);
    expect(ids).toContain('claude-code');
    expect(ids).toContain('openai-codex');
    expect(ids).toContain('google-gemini');
    expect(ids).toContain('mistral-vibe');
  });

  it('should return mistral-vibe from getAgentDefinition', () => {
    const def = getAgentDefinition('mistral-vibe');
    expect(def).toBeDefined();
    expect(def!.id).toBe('mistral-vibe');
  });

  it('should return undefined for unknown agent type', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const def = getAgentDefinition('not-an-agent' as any);
    expect(def).toBeUndefined();
  });

  it('should validate mistral-vibe as a valid agent type', () => {
    expect(isValidAgentType('mistral-vibe')).toBe(true);
  });

  it('should reject invalid agent types', () => {
    expect(isValidAgentType('not-an-agent')).toBe(false);
  });

  it('should have all required fields for every agent', () => {
    for (const agent of AGENT_CATALOG) {
      expect(agent.id).toBeTruthy();
      expect(agent.name).toBeTruthy();
      expect(agent.description).toBeTruthy();
      expect(agent.provider).toBeTruthy();
      expect(agent.envVarName).toBeTruthy();
      expect(agent.acpCommand).toBeTruthy();
      expect(agent.installCommand).toBeTruthy();
      expect(agent.credentialHelpUrl).toBeTruthy();
      expect(typeof agent.supportsAcp).toBe('boolean');
      expect(Array.isArray(agent.acpArgs)).toBe(true);
    }
  });
});
