import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  saveAgentCredential: vi.fn(),
  saveAgentSettings: vi.fn(),
  updateUserAiBudget: vi.fn(),
  validateAgentCredential: vi.fn(),
}));
vi.mock('../../../src/lib/api', () => api);

import {
  authMethodsForAgent,
  firstProfileRequest,
  INITIAL_FORM,
  saveAgentConnection,
} from '../../../src/components/onboarding/choose-path/step-actions';

beforeEach(() => {
  vi.clearAllMocks();
  api.validateAgentCredential.mockResolvedValue({ valid: true });
  api.saveAgentCredential.mockResolvedValue({});
  api.saveAgentSettings.mockResolvedValue({});
  api.updateUserAiBudget.mockResolvedValue({});
});

describe('authMethodsForAgent', () => {
  it('puts the subscription first for agents that have one', () => {
    expect(authMethodsForAgent('claude-code')).toEqual(['oauth-token', 'api-key', 'sam']);
    expect(authMethodsForAgent('openai-codex')).toEqual(['oauth-token', 'api-key', 'sam']);
  });

  it('offers only an API key to agents with no subscription or proxy', () => {
    expect(authMethodsForAgent('google-gemini')).toEqual(['api-key']);
  });

  it('leaves SAM-managed AI out where the installation does not enable it', () => {
    expect(authMethodsForAgent('claude-code', { samAvailable: false })).toEqual([
      'oauth-token',
      'api-key',
    ]);
  });
});

describe('saveAgentConnection', () => {
  it('validates, then saves an API key', async () => {
    await saveAgentConnection({
      ...INITIAL_FORM,
      selectedAgent: 'claude-code',
      selectedAuthMethod: 'api-key',
      apiKey: ' sk-1 ',
    });
    const request = { agentType: 'claude-code', credentialKind: 'api-key', credential: 'sk-1' };
    expect(api.validateAgentCredential).toHaveBeenCalledWith(request);
    expect(api.saveAgentCredential).toHaveBeenCalledWith(request);
  });

  it('does not save an API key the provider rejects', async () => {
    api.validateAgentCredential.mockResolvedValue({ valid: false, message: 'Bad key' });
    await expect(
      saveAgentConnection({
        ...INITIAL_FORM,
        selectedAgent: 'claude-code',
        selectedAuthMethod: 'api-key',
        apiKey: 'nope',
      })
    ).rejects.toThrow('Bad key');
    expect(api.saveAgentCredential).not.toHaveBeenCalled();
  });

  it('saves a pasted subscription token as the active credential', async () => {
    await saveAgentConnection({
      ...INITIAL_FORM,
      selectedAgent: 'claude-code',
      selectedAuthMethod: 'oauth-token',
      oauthToken: 'tok',
    });
    expect(api.saveAgentCredential).toHaveBeenCalledWith({
      agentType: 'claude-code',
      credentialKind: 'oauth-token',
      credential: 'tok',
      autoActivate: true,
    });
  });

  it('switches the agent to SAM-managed AI, with limits only when given', async () => {
    await saveAgentConnection({
      ...INITIAL_FORM,
      selectedAgent: 'openai-codex',
      selectedAuthMethod: 'sam',
    });
    expect(api.saveAgentSettings).toHaveBeenCalledWith('openai-codex', { providerMode: 'sam' });
    expect(api.updateUserAiBudget).not.toHaveBeenCalled();

    await saveAgentConnection({
      ...INITIAL_FORM,
      selectedAgent: 'openai-codex',
      selectedAuthMethod: 'sam',
      monthlyCostCapUsd: '25',
    });
    expect(api.updateUserAiBudget).toHaveBeenCalledWith({ monthlyCostCapUsd: 25 });
  });

  it('refuses without an agent', async () => {
    await expect(saveAgentConnection(INITIAL_FORM)).rejects.toThrow('Please choose an agent');
  });
});

describe('firstProfileRequest', () => {
  it('runs Instant as a lightweight conversation', () => {
    expect(firstProfileRequest('claude-code', 'instant')).toEqual(
      expect.objectContaining({
        name: 'Claude Code',
        agentType: 'claude-code',
        runtime: 'cf-container',
        workspaceProfile: 'lightweight',
        taskMode: 'conversation',
      })
    );
  });

  it.each(['platform', 'byoc'] as const)('runs %s machines as full tasks', (runtime) => {
    expect(firstProfileRequest('openai-codex', runtime)).toEqual(
      expect.objectContaining({ runtime: 'vm', workspaceProfile: 'full', taskMode: 'task' })
    );
  });
});
