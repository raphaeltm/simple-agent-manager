import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authMethodsForAgent,
  executeStep,
  INITIAL_FORM,
  type StepFormState,
} from '../../../src/components/onboarding/choose-path/step-actions';

// Mock the API module
vi.mock('../../../src/lib/api', () => ({
  createCredential: vi.fn().mockResolvedValue({}),
  saveAgentCredential: vi.fn().mockResolvedValue({}),
  saveAgentSettings: vi.fn().mockResolvedValue({}),
  updateUserAiBudget: vi.fn().mockResolvedValue({ success: true }),
  validateAgentCredential: vi.fn().mockResolvedValue({ valid: true }),
  validateCredential: vi.fn().mockResolvedValue({ valid: true }),
}));

// Import mocked functions for assertions
import {
  createCredential,
  saveAgentCredential,
  saveAgentSettings,
  updateUserAiBudget,
  validateAgentCredential,
  validateCredential,
} from '../../../src/lib/api';

describe('INITIAL_FORM', () => {
  it('has all fields set to empty/null defaults', () => {
    expect(INITIAL_FORM).toEqual({
      selectedAgent: null,
      selectedAuthMethod: null,
      apiKey: '',
      oauthToken: '',
      dailyInputTokenLimit: '',
      dailyOutputTokenLimit: '',
      monthlyCostCapUsd: '',
      cloudProvider: 'hetzner',
      hetznerToken: '',
      scalewaySecretKey: '',
      scalewayProjectId: '',
      selectedRepoName: '',
    });
  });
});

describe('authMethodsForAgent (capability-driven)', () => {
  it('offers api-key + oauth-token + sam for claude-code', () => {
    expect(authMethodsForAgent('claude-code')).toEqual(['api-key', 'oauth-token', 'sam']);
  });

  it('offers api-key + oauth-token + sam for openai-codex', () => {
    expect(authMethodsForAgent('openai-codex')).toEqual(['api-key', 'oauth-token', 'sam']);
  });

  it('offers ONLY api-key for agents without oauthSupport or proxy support', () => {
    expect(authMethodsForAgent('google-gemini')).toEqual(['api-key']);
    expect(authMethodsForAgent('mistral-vibe')).toEqual(['api-key']);
    expect(authMethodsForAgent('opencode')).toEqual(['api-key']);
    expect(authMethodsForAgent('amp')).toEqual(['api-key']);
  });

  it('never offers oauth-token to a non-oauth agent (capability gate, not hardcoded)', () => {
    for (const agent of ['google-gemini', 'mistral-vibe', 'opencode', 'amp']) {
      expect(authMethodsForAgent(agent)).not.toContain('oauth-token');
      expect(authMethodsForAgent(agent)).not.toContain('sam');
    }
  });
});

describe('executeStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish default resolved values — vi.clearAllMocks() clears call
    // history but NOT mockResolvedValue implementations, so a prior test that
    // set { valid: false } would otherwise bleed into the next test.
    vi.mocked(createCredential).mockResolvedValue({} as never);
    vi.mocked(saveAgentCredential).mockResolvedValue({} as never);
    vi.mocked(saveAgentSettings).mockResolvedValue({} as never);
    vi.mocked(updateUserAiBudget).mockResolvedValue({ success: true } as never);
    vi.mocked(validateAgentCredential).mockResolvedValue({ valid: true });
    vi.mocked(validateCredential).mockResolvedValue({ valid: true });
  });

  // ── ai-setup: api-key ──

  describe('ai-setup / api-key', () => {
    const apiKeyForm = (overrides: Partial<StepFormState> = {}): StepFormState => ({
      ...INITIAL_FORM,
      selectedAgent: 'claude-code',
      selectedAuthMethod: 'api-key',
      apiKey: 'sk-test',
      ...overrides,
    });

    it('throws when selectedAgent is null', async () => {
      const form: StepFormState = { ...INITIAL_FORM, selectedAuthMethod: 'api-key', apiKey: 'sk-test' };
      await expect(executeStep('ai-setup', form)).rejects.toThrow('Please choose an agent');
    });

    it('throws when apiKey is empty', async () => {
      await expect(executeStep('ai-setup', apiKeyForm({ apiKey: '' }))).rejects.toThrow(
        'Please enter an API key'
      );
    });

    it('validates before saving (validation-first invariant)', async () => {
      const callOrder: string[] = [];
      vi.mocked(validateAgentCredential).mockImplementation(async () => {
        callOrder.push('validate');
        return { valid: true };
      });
      vi.mocked(saveAgentCredential).mockImplementation(async () => {
        callOrder.push('save');
        return {} as never;
      });

      await executeStep('ai-setup', apiKeyForm());
      expect(callOrder).toEqual(['validate', 'save']);
    });

    it('does not call save when validation fails', async () => {
      vi.mocked(validateAgentCredential).mockResolvedValue({ valid: false, message: 'Key is expired' });
      await expect(executeStep('ai-setup', apiKeyForm({ apiKey: 'sk-bad' }))).rejects.toThrow(
        'Key is expired'
      );
      expect(saveAgentCredential).not.toHaveBeenCalled();
    });

    it('trims and passes correct agentType + credentialKind', async () => {
      await executeStep('ai-setup', apiKeyForm({ selectedAgent: 'google-gemini', apiKey: '  sk-x  ' }));
      expect(saveAgentCredential).toHaveBeenCalledWith({
        agentType: 'google-gemini',
        credentialKind: 'api-key',
        credential: 'sk-x',
      });
    });
  });

  // ── ai-setup: oauth-token ──

  describe('ai-setup / oauth-token', () => {
    const oauthForm = (overrides: Partial<StepFormState> = {}): StepFormState => ({
      ...INITIAL_FORM,
      selectedAgent: 'claude-code',
      selectedAuthMethod: 'oauth-token',
      oauthToken: 'oauth-abc',
      ...overrides,
    });

    it('throws when oauthToken is empty', async () => {
      await expect(executeStep('ai-setup', oauthForm({ oauthToken: '' }))).rejects.toThrow(
        'Please paste your OAuth token'
      );
    });

    it("saves with the literal credentialKind 'oauth-token' and autoActivate: true", async () => {
      await executeStep('ai-setup', oauthForm({ selectedAgent: 'openai-codex', oauthToken: '  json-blob  ' }));
      expect(saveAgentCredential).toHaveBeenCalledWith({
        agentType: 'openai-codex',
        credentialKind: 'oauth-token',
        credential: 'json-blob',
        autoActivate: true,
      });
    });

    it('does not validate oauth tokens client-side (server gates on oauthSupport)', async () => {
      await executeStep('ai-setup', oauthForm());
      expect(validateAgentCredential).not.toHaveBeenCalled();
    });
  });

  // ── ai-setup: sam ──

  describe('ai-setup / sam', () => {
    const samForm = (overrides: Partial<StepFormState> = {}): StepFormState => ({
      ...INITIAL_FORM,
      selectedAgent: 'claude-code',
      selectedAuthMethod: 'sam',
      ...overrides,
    });

    it("persists providerMode: 'sam' via saveAgentSettings", async () => {
      await executeStep('ai-setup', samForm({ selectedAgent: 'openai-codex' }));
      expect(saveAgentSettings).toHaveBeenCalledWith('openai-codex', { providerMode: 'sam' });
    });

    it('skips the budget call when no budget fields are provided', async () => {
      await executeStep('ai-setup', samForm());
      expect(updateUserAiBudget).not.toHaveBeenCalled();
    });

    it('collects budget inline and sends only the provided positive numeric fields', async () => {
      await executeStep(
        'ai-setup',
        samForm({
          dailyInputTokenLimit: '100000',
          dailyOutputTokenLimit: '',
          monthlyCostCapUsd: '25',
        })
      );
      expect(updateUserAiBudget).toHaveBeenCalledWith({
        dailyInputTokenLimit: 100000,
        monthlyCostCapUsd: 25,
      });
    });

    it('ignores non-numeric / non-positive budget values', async () => {
      await executeStep(
        'ai-setup',
        samForm({ dailyInputTokenLimit: 'abc', monthlyCostCapUsd: '-5' })
      );
      expect(updateUserAiBudget).not.toHaveBeenCalled();
    });

    it('saves the mode before applying budget', async () => {
      const order: string[] = [];
      vi.mocked(saveAgentSettings).mockImplementation(async () => {
        order.push('settings');
        return {} as never;
      });
      vi.mocked(updateUserAiBudget).mockImplementation(async () => {
        order.push('budget');
        return { success: true } as never;
      });
      await executeStep('ai-setup', samForm({ monthlyCostCapUsd: '10' }));
      expect(order).toEqual(['settings', 'budget']);
    });
  });

  // ── cloud-byoc: hetzner ──

  describe('cloud-byoc / hetzner', () => {
    const hetznerForm = (overrides: Partial<StepFormState> = {}): StepFormState => ({
      ...INITIAL_FORM,
      cloudProvider: 'hetzner',
      hetznerToken: 'hetz-token',
      ...overrides,
    });

    it('throws when hetznerToken is empty', async () => {
      await expect(executeStep('cloud-byoc', hetznerForm({ hetznerToken: '' }))).rejects.toThrow(
        'Please enter your Hetzner API token'
      );
    });

    it('validates before creating, with provider: hetzner', async () => {
      const order: string[] = [];
      vi.mocked(validateCredential).mockImplementation(async () => {
        order.push('validate');
        return { valid: true };
      });
      vi.mocked(createCredential).mockImplementation(async () => {
        order.push('create');
        return {} as never;
      });
      await executeStep('cloud-byoc', hetznerForm({ hetznerToken: '  hetz-token  ' }));
      expect(order).toEqual(['validate', 'create']);
      expect(createCredential).toHaveBeenCalledWith({ provider: 'hetzner', token: 'hetz-token' });
    });

    it('does not create when validation fails', async () => {
      vi.mocked(validateCredential).mockResolvedValue({ valid: false, message: 'Token revoked' });
      await expect(executeStep('cloud-byoc', hetznerForm())).rejects.toThrow('Token revoked');
      expect(createCredential).not.toHaveBeenCalled();
    });
  });

  // ── cloud-byoc: scaleway ──

  describe('cloud-byoc / scaleway', () => {
    const scalewayForm = (overrides: Partial<StepFormState> = {}): StepFormState => ({
      ...INITIAL_FORM,
      cloudProvider: 'scaleway',
      scalewaySecretKey: 'sk-scw',
      scalewayProjectId: 'proj-123',
      ...overrides,
    });

    it('throws when secretKey is missing', async () => {
      await expect(
        executeStep('cloud-byoc', scalewayForm({ scalewaySecretKey: '' }))
      ).rejects.toThrow('Please enter your Scaleway secret key and project ID');
    });

    it('throws when projectId is missing', async () => {
      await expect(
        executeStep('cloud-byoc', scalewayForm({ scalewayProjectId: '' }))
      ).rejects.toThrow('Please enter your Scaleway secret key and project ID');
    });

    it('validates then creates with provider: scaleway, secretKey + projectId', async () => {
      const order: string[] = [];
      vi.mocked(validateCredential).mockImplementation(async () => {
        order.push('validate');
        return { valid: true };
      });
      vi.mocked(createCredential).mockImplementation(async () => {
        order.push('create');
        return {} as never;
      });
      await executeStep(
        'cloud-byoc',
        scalewayForm({ scalewaySecretKey: '  sk-scw  ', scalewayProjectId: '  proj-123  ' })
      );
      expect(order).toEqual(['validate', 'create']);
      expect(createCredential).toHaveBeenCalledWith({
        provider: 'scaleway',
        secretKey: 'sk-scw',
        projectId: 'proj-123',
      });
    });

    it('does not create when validation fails', async () => {
      vi.mocked(validateCredential).mockResolvedValue({ valid: false, message: 'Bad creds' });
      await expect(executeStep('cloud-byoc', scalewayForm())).rejects.toThrow('Bad creds');
      expect(createCredential).not.toHaveBeenCalled();
    });
  });

  // ── Pass-through steps ──

  describe('pass-through steps', () => {
    const passSteps = ['cloud-sam', 'github', 'project'] as const;

    for (const stepId of passSteps) {
      it(`${stepId} resolves without calling any API`, async () => {
        await executeStep(stepId, INITIAL_FORM);
        expect(validateAgentCredential).not.toHaveBeenCalled();
        expect(saveAgentCredential).not.toHaveBeenCalled();
        expect(saveAgentSettings).not.toHaveBeenCalled();
        expect(updateUserAiBudget).not.toHaveBeenCalled();
        expect(validateCredential).not.toHaveBeenCalled();
        expect(createCredential).not.toHaveBeenCalled();
      });
    }
  });
});
