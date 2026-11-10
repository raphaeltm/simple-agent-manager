/**
 * The onboarding agent step: which agent, how it signs in, and the first profile.
 */
import type {
  AgentType,
  CreateAgentProfileRequest,
  SaveAgentCredentialRequest,
  UpdateAiBudgetRequest,
} from '@simple-agent-manager/shared';
import { getAgentDefinition } from '@simple-agent-manager/shared';

import {
  saveAgentCredential,
  saveAgentSettings,
  updateUserAiBudget,
  validateAgentCredential,
} from '../../../lib/api';
import type { RuntimeChoice } from './questions';

/** Auth methods a user can pick for an agent during onboarding. */
export type AuthMethod = 'api-key' | 'oauth-token' | 'sam';

/**
 * Agents whose traffic can be routed through the SAM-managed AI proxy.
 * Mirrors the server-side gate in apps/api/src/routes/agents-catalog.ts.
 */
export const SAM_PROXY_AGENT_TYPES: readonly AgentType[] = ['claude-code', 'openai-codex'];

/**
 * Returns the auth methods available for an agent, driven by the catalog
 * capabilities rather than hardcoded provider branches:
 * - 'oauth-token': only agents that declare oauthSupport, listed first
 * - 'api-key': every agent
 * - 'sam': only agents the SAM AI proxy supports
 */
export function authMethodsForAgent(
  agentId: string,
  { samAvailable = true }: { samAvailable?: boolean } = {}
): AuthMethod[] {
  // A subscription comes first where the agent has one: signing in is quicker than finding and
  // pasting an API key, and SAM can run the sign-in for Claude Code and Codex.
  const def = getAgentDefinition(agentId as AgentType);
  const methods: AuthMethod[] = def?.oauthSupport ? ['oauth-token', 'api-key'] : ['api-key'];
  if (samAvailable && SAM_PROXY_AGENT_TYPES.includes(agentId as AgentType)) methods.push('sam');
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
  // Project (project step)
  selectedRepoName: string;
  /** Name for a SAM-hosted project (the repository is created with it). */
  hostedProjectName: string;
}

export const INITIAL_FORM: StepFormState = {
  selectedAgent: null,
  selectedAuthMethod: null,
  apiKey: '',
  oauthToken: '',
  dailyInputTokenLimit: '',
  dailyOutputTokenLimit: '',
  monthlyCostCapUsd: '',
  selectedRepoName: '',
  hostedProjectName: '',
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

/** Saves how the chosen agent signs in. The guided subscription sign-in saves on its own. */
export async function saveAgentConnection(form: StepFormState): Promise<void> {
  if (!form.selectedAgent) throw new Error('Please choose an agent');
  const agentType = form.selectedAgent as AgentType;
  const method = form.selectedAuthMethod;

  if (method === 'api-key') {
    if (!form.apiKey.trim()) throw new Error('Please enter an API key');
    const request: SaveAgentCredentialRequest = {
      agentType,
      credentialKind: 'api-key',
      credential: form.apiKey.trim(),
    };
    const validation = await validateAgentCredential(request);
    if (validation.valid === false) throw new Error(validation.message ?? 'Invalid API key');
    await saveAgentCredential(request);
    return;
  }

  if (method === 'oauth-token') {
    if (!form.oauthToken.trim()) throw new Error('Please paste your sign-in token');
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
    if (budget) await updateUserAiBudget(budget);
    return;
  }

  throw new Error('Please choose how to connect this agent');
}

/**
 * The project's first profile, so its first chat starts without a detour through the profile
 * wizard: the chosen agent on the runtime the user picked. Instant runs as a conversation in a
 * lightweight workspace (the runtime allows nothing else); a machine runs full tasks.
 */
export function firstProfileRequest(
  agentType: AgentType,
  runtime: RuntimeChoice
): CreateAgentProfileRequest {
  const name = getAgentDefinition(agentType)?.name ?? agentType;
  return runtime === 'instant'
    ? {
        name,
        description: 'Chats and changes on Instant, ready in seconds',
        agentType,
        runtime: 'cf-container',
        workspaceProfile: 'lightweight',
        taskMode: 'conversation',
      }
    : {
        name,
        description: 'Writes code and opens pull requests on its own machine',
        agentType,
        runtime: 'vm',
        workspaceProfile: 'full',
        taskMode: 'task',
      };
}
