/**
 * Executes the real API call for each setup step.
 */
import type { SaveAgentCredentialRequest } from '@simple-agent-manager/shared';

import {
  createCredential,
  saveAgentCredential,
  validateAgentCredential,
  validateCredential,
} from '../../../lib/api';
import type { StepId } from './path-generator';

export interface StepFormState {
  apiKey: string;
  selectedAgent: string | null;
  hetznerToken: string;
  selectedRepoUrl: string;
  selectedRepoName: string;
}

export const INITIAL_FORM: StepFormState = {
  apiKey: '',
  selectedAgent: null,
  hetznerToken: '',
  selectedRepoUrl: '',
  selectedRepoName: '',
};

export async function executeStep(
  stepId: StepId,
  form: StepFormState
): Promise<void> {
  switch (stepId) {
    case 'ai-apikey': {
      if (!form.selectedAgent || !form.apiKey.trim()) {
        throw new Error('Please enter an API key');
      }
      const request: SaveAgentCredentialRequest = {
        agentType: form.selectedAgent as SaveAgentCredentialRequest['agentType'],
        credentialKind: 'api-key',
        credential: form.apiKey.trim(),
      };
      const validation = await validateAgentCredential(request);
      if (validation.valid === false) {
        throw new Error(validation.message ?? 'Invalid API key');
      }
      await saveAgentCredential(request);
      return;
    }

    case 'ai-oauth':
    case 'ai-sam':
    case 'cloud-sam':
    case 'github':
    case 'project':
      // These are handled by their own UI flows, not this function
      return;

    case 'cloud-hetzner': {
      if (!form.hetznerToken.trim()) {
        throw new Error('Please enter your Hetzner API token');
      }
      const validation = await validateCredential({
        provider: 'hetzner',
        token: form.hetznerToken.trim(),
      });
      if (validation.valid === false) {
        throw new Error(validation.message ?? 'Invalid Hetzner token');
      }
      await createCredential({
        provider: 'hetzner',
        token: form.hetznerToken.trim(),
      });
      return;
    }
  }
}
