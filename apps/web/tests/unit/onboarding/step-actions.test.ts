import { beforeEach,describe, expect, it, vi } from 'vitest';

import { executeStep, INITIAL_FORM, type StepFormState } from '../../../src/components/onboarding/choose-path/step-actions';

// Mock the API module
vi.mock('../../../src/lib/api', () => ({
  createCredential: vi.fn().mockResolvedValue({}),
  saveAgentCredential: vi.fn().mockResolvedValue({}),
  validateAgentCredential: vi.fn().mockResolvedValue({ valid: true }),
  validateCredential: vi.fn().mockResolvedValue({ valid: true }),
}));

// Import mocked functions for assertions
import {
  createCredential,
  saveAgentCredential,
  validateAgentCredential,
  validateCredential,
} from '../../../src/lib/api';

describe('INITIAL_FORM', () => {
  it('has all fields set to empty/null defaults', () => {
    expect(INITIAL_FORM).toEqual({
      apiKey: '',
      selectedAgent: null,
      hetznerToken: '',
      selectedRepoUrl: '',
      selectedRepoName: '',
    });
  });
});

describe('executeStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── ai-apikey step ──

  describe('ai-apikey', () => {
    it('throws when selectedAgent is null', async () => {
      const form: StepFormState = { ...INITIAL_FORM, apiKey: 'sk-test' };
      await expect(executeStep('ai-apikey', form)).rejects.toThrow('Please enter an API key');
    });

    it('throws when apiKey is empty', async () => {
      const form: StepFormState = { ...INITIAL_FORM, selectedAgent: 'claude-code', apiKey: '' };
      await expect(executeStep('ai-apikey', form)).rejects.toThrow('Please enter an API key');
    });

    it('throws when apiKey is whitespace-only', async () => {
      const form: StepFormState = { ...INITIAL_FORM, selectedAgent: 'claude-code', apiKey: '   ' };
      await expect(executeStep('ai-apikey', form)).rejects.toThrow('Please enter an API key');
    });

    it('validates before saving (validation-first invariant)', async () => {
      const callOrder: string[] = [];
      vi.mocked(validateAgentCredential).mockImplementation(async () => {
        callOrder.push('validate');
        return { valid: true };
      });
      vi.mocked(saveAgentCredential).mockImplementation(async () => {
        callOrder.push('save');
        return {} as any;
      });

      const form: StepFormState = { ...INITIAL_FORM, selectedAgent: 'claude-code', apiKey: 'sk-test' };
      await executeStep('ai-apikey', form);

      expect(callOrder).toEqual(['validate', 'save']);
    });

    it('does not call save when validation fails', async () => {
      vi.mocked(validateAgentCredential).mockResolvedValue({
        valid: false,
        message: 'Key is expired',
      });

      const form: StepFormState = { ...INITIAL_FORM, selectedAgent: 'claude-code', apiKey: 'sk-bad' };
      await expect(executeStep('ai-apikey', form)).rejects.toThrow('Key is expired');
      expect(saveAgentCredential).not.toHaveBeenCalled();
    });

    it('uses fallback error message when validation.message is undefined', async () => {
      vi.mocked(validateAgentCredential).mockResolvedValue({
        valid: false,
        message: undefined,
      } as any);

      const form: StepFormState = { ...INITIAL_FORM, selectedAgent: 'claude-code', apiKey: 'sk-bad' };
      await expect(executeStep('ai-apikey', form)).rejects.toThrow('Invalid API key');
    });

    it('trims the apiKey before sending', async () => {
      vi.mocked(validateAgentCredential).mockResolvedValue({ valid: true });
      vi.mocked(saveAgentCredential).mockResolvedValue({} as any);

      const form: StepFormState = { ...INITIAL_FORM, selectedAgent: 'claude-code', apiKey: '  sk-test  ' };
      await executeStep('ai-apikey', form);

      expect(validateAgentCredential).toHaveBeenCalledWith(
        expect.objectContaining({ credential: 'sk-test' })
      );
      expect(saveAgentCredential).toHaveBeenCalledWith(
        expect.objectContaining({ credential: 'sk-test' })
      );
    });

    it('passes correct agentType and credentialKind', async () => {
      vi.mocked(validateAgentCredential).mockResolvedValue({ valid: true });
      vi.mocked(saveAgentCredential).mockResolvedValue({} as any);

      const form: StepFormState = { ...INITIAL_FORM, selectedAgent: 'codex', apiKey: 'sk-test' };
      await executeStep('ai-apikey', form);

      expect(saveAgentCredential).toHaveBeenCalledWith({
        agentType: 'codex',
        credentialKind: 'api-key',
        credential: 'sk-test',
      });
    });
  });

  // ── cloud-hetzner step ──

  describe('cloud-hetzner', () => {
    it('throws when hetznerToken is empty', async () => {
      const form: StepFormState = { ...INITIAL_FORM };
      await expect(executeStep('cloud-hetzner', form)).rejects.toThrow(
        'Please enter your Hetzner API token'
      );
    });

    it('throws when hetznerToken is whitespace-only', async () => {
      const form: StepFormState = { ...INITIAL_FORM, hetznerToken: '   ' };
      await expect(executeStep('cloud-hetzner', form)).rejects.toThrow(
        'Please enter your Hetzner API token'
      );
    });

    it('validates before creating (validation-first invariant)', async () => {
      const callOrder: string[] = [];
      vi.mocked(validateCredential).mockImplementation(async () => {
        callOrder.push('validate');
        return { valid: true };
      });
      vi.mocked(createCredential).mockImplementation(async () => {
        callOrder.push('create');
        return {} as any;
      });

      const form: StepFormState = { ...INITIAL_FORM, hetznerToken: 'hetz-token' };
      await executeStep('cloud-hetzner', form);

      expect(callOrder).toEqual(['validate', 'create']);
    });

    it('does not call create when validation fails', async () => {
      vi.mocked(validateCredential).mockResolvedValue({
        valid: false,
        message: 'Token revoked',
      });

      const form: StepFormState = { ...INITIAL_FORM, hetznerToken: 'hetz-bad' };
      await expect(executeStep('cloud-hetzner', form)).rejects.toThrow('Token revoked');
      expect(createCredential).not.toHaveBeenCalled();
    });

    it('uses fallback error message when validation.message is undefined', async () => {
      vi.mocked(validateCredential).mockResolvedValue({
        valid: false,
        message: undefined,
      } as any);

      const form: StepFormState = { ...INITIAL_FORM, hetznerToken: 'hetz-bad' };
      await expect(executeStep('cloud-hetzner', form)).rejects.toThrow('Invalid Hetzner token');
    });

    it('trims the hetznerToken before sending', async () => {
      vi.mocked(validateCredential).mockResolvedValue({ valid: true });
      vi.mocked(createCredential).mockResolvedValue({} as any);

      const form: StepFormState = { ...INITIAL_FORM, hetznerToken: '  hetz-token  ' };
      await executeStep('cloud-hetzner', form);

      expect(validateCredential).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'hetz-token' })
      );
      expect(createCredential).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'hetz-token' })
      );
    });

    it('passes provider: hetzner to both validate and create', async () => {
      vi.mocked(validateCredential).mockResolvedValue({ valid: true });
      vi.mocked(createCredential).mockResolvedValue({} as any);

      const form: StepFormState = { ...INITIAL_FORM, hetznerToken: 'hetz-token' };
      await executeStep('cloud-hetzner', form);

      expect(validateCredential).toHaveBeenCalledWith({ provider: 'hetzner', token: 'hetz-token' });
      expect(createCredential).toHaveBeenCalledWith({ provider: 'hetzner', token: 'hetz-token' });
    });
  });

  // ── Pass-through steps ──

  describe('pass-through steps', () => {
    const passSteps = ['ai-oauth', 'ai-sam', 'cloud-sam', 'github', 'project'] as const;

    for (const stepId of passSteps) {
      it(`${stepId} resolves without calling any API`, async () => {
        await executeStep(stepId, INITIAL_FORM);

        expect(validateAgentCredential).not.toHaveBeenCalled();
        expect(saveAgentCredential).not.toHaveBeenCalled();
        expect(validateCredential).not.toHaveBeenCalled();
        expect(createCredential).not.toHaveBeenCalled();
      });
    }
  });
});
