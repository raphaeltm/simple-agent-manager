/**
 * Executes the real API call for each setup step.
 */
import type {
  AgentType,
  SaveAgentCredentialRequest,
  UpdateAiBudgetRequest,
} from '@simple-agent-manager/shared';
import { getAgentDefinition } from '@simple-agent-manager/shared';

import {
  createCredential,
  saveAgentCredential,
  saveAgentSettings,
  updateUserAiBudget,
  validateAgentCredential,
  validateCredential,
} from '../../../lib/api';
import type { StepId } from './path-generator';

/** Auth methods a user can pick for an agent during onboarding. */
export type AuthMethod = 'api-key' | 'oauth-token' | 'sam';

/**
 * Cloud providers selectable inline during onboarding (no GCP — it needs a multi-step handshake).
 * Vultr is intentionally deferred here (binary hetzner/scaleway ternary UI); tracked follow-up:
 * tasks/backlog/2026-07-23-vultr-onboarding-wizard-parity.md. Vultr is fully usable via
 * Settings → Cloud Providers and CloudProviderConnectFlow.
 */
export type CloudProvider = 'hetzner' | 'scaleway';

/**
 * Agents whose traffic can be routed through the SAM-managed AI proxy.
 * Mirrors the server-side gate in apps/api/src/routes/agents-catalog.ts.
 */
export const SAM_PROXY_AGENT_TYPES: readonly AgentType[] = ['claude-code', 'openai-codex'];

/**
 * Returns the auth methods available for an agent, driven by the catalog
 * capabilities rather than hardcoded provider branches:
 * - 'api-key': every agent
 * - 'oauth-token': only agents that declare oauthSupport
 * - 'sam': only agents the SAM AI proxy supports
 */
export function authMethodsForAgent(agentId: string): AuthMethod[] {
  const methods: AuthMethod[] = ['api-key'];
  const def = getAgentDefinition(agentId as AgentType);
  if (def?.oauthSupport) methods.push('oauth-token');
  if (SAM_PROXY_AGENT_TYPES.includes(agentId as AgentType)) methods.push('sam');
  return methods;
}

export interface StepFormState {
  // Agent + auth selection (ai-setup step)
  selectedAgent: string | null;
  selectedAuthMethod: AuthMethod | null;
  apiKey: string;
  oauthToken: string;
  // SAM-managed AI budget (collected inline when selectedAuthMethod === 'sam')
  dailyInputTokenLimit: string;
  dailyOutputTokenLimit: string;
  monthlyCostCapUsd: string;
  // Cloud (cloud-byoc step)
  cloudProvider: CloudProvider;
  hetznerToken: string;
  scalewaySecretKey: string;
  scalewayProjectId: string;
  // Project (project step)
  selectedRepoName: string;
}

export const INITIAL_FORM: StepFormState = {
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
};

/**
 * Builds an AI budget request from the inline SAM budget fields.
 * Empty fields are omitted so the platform default applies; returns null when
 * nothing was provided so the caller can skip the budget call entirely.
 */
function buildBudgetRequest(form: StepFormState): UpdateAiBudgetRequest | null {
  const body: UpdateAiBudgetRequest = {};
  const daily = form.dailyInputTokenLimit.trim();
  const dailyOut = form.dailyOutputTokenLimit.trim();
  const monthly = form.monthlyCostCapUsd.trim();

  if (daily !== '') {
    const n = Number(daily);
    if (Number.isFinite(n) && n > 0) body.dailyInputTokenLimit = n;
  }
  if (dailyOut !== '') {
    const n = Number(dailyOut);
    if (Number.isFinite(n) && n > 0) body.dailyOutputTokenLimit = n;
  }
  if (monthly !== '') {
    const n = Number(monthly);
    if (Number.isFinite(n) && n > 0) body.monthlyCostCapUsd = n;
  }

  return Object.keys(body).length > 0 ? body : null;
}

export async function executeStep(
  stepId: StepId,
  form: StepFormState
): Promise<void> {
  switch (stepId) {
    case 'ai-setup': {
      if (!form.selectedAgent) {
        throw new Error('Please choose an agent');
      }
      const agentType = form.selectedAgent as AgentType;
      const method = form.selectedAuthMethod;

      if (method === 'api-key') {
        if (!form.apiKey.trim()) {
          throw new Error('Please enter an API key');
        }
        const request: SaveAgentCredentialRequest = {
          agentType,
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

      if (method === 'oauth-token') {
        if (!form.oauthToken.trim()) {
          throw new Error('Please paste your OAuth token');
        }
        await saveAgentCredential({
          agentType,
          credentialKind: 'oauth-token',
          credential: form.oauthToken.trim(),
          autoActivate: true,
        });
        return;
      }

      if (method === 'sam') {
        await saveAgentSettings(agentType, { providerMode: 'sam' });
        const budget = buildBudgetRequest(form);
        if (budget) {
          await updateUserAiBudget(budget);
        }
        return;
      }

      throw new Error('Please choose how to connect this agent');
    }

    case 'cloud-byoc': {
      if (form.cloudProvider === 'hetzner') {
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

      // scaleway
      if (!form.scalewaySecretKey.trim() || !form.scalewayProjectId.trim()) {
        throw new Error('Please enter your Scaleway secret key and project ID');
      }
      const validation = await validateCredential({
        provider: 'scaleway',
        secretKey: form.scalewaySecretKey.trim(),
        projectId: form.scalewayProjectId.trim(),
      });
      if (validation.valid === false) {
        throw new Error(validation.message ?? 'Invalid Scaleway credentials');
      }
      await createCredential({
        provider: 'scaleway',
        secretKey: form.scalewaySecretKey.trim(),
        projectId: form.scalewayProjectId.trim(),
      });
      return;
    }

    case 'cloud-sam':
    case 'github':
    case 'project':
      // These are handled by their own UI flows, not this function.
      // cloud-sam is an honest confirmation step — there is no backend field to
      // persist a "use SAM infra" choice, so it collects nothing (rule 42).
      return;
  }
}
