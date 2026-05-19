import type { AgentType } from '@simple-agent-manager/shared';
import { getAgentDefinition } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { errors } from '../middleware/error';
import { getTimeoutMs } from './fetch-timeout';

interface AgentValidationResult {
  valid: boolean;
  message: string;
  validationMode: 'format' | 'provider';
}

const DEFAULT_AGENT_VALIDATION_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function validateAgentApiKeyWithProvider(agentType: AgentType, credential: string, env: Env): Promise<AgentValidationResult> {
  const agentDef = getAgentDefinition(agentType);
  if (!agentDef) {
    throw errors.badRequest('Unknown agent type');
  }
  const timeoutMs = getTimeoutMs(env.AGENT_CREDENTIAL_VALIDATION_TIMEOUT_MS, DEFAULT_AGENT_VALIDATION_TIMEOUT_MS);

  let response: Response | null = null;
  if (agentDef.provider === 'anthropic') {
    response = await fetchWithTimeout('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': credential,
        'anthropic-version': '2023-06-01',
      },
    }, timeoutMs);
  } else if (agentDef.provider === 'openai') {
    response = await fetchWithTimeout('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${credential}` },
    }, timeoutMs);
  } else if (agentDef.provider === 'google') {
    response = await fetchWithTimeout('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': credential },
    }, timeoutMs);
  } else if (agentDef.provider === 'mistral') {
    response = await fetchWithTimeout('https://api.mistral.ai/v1/models', {
      headers: { Authorization: `Bearer ${credential}` },
    }, timeoutMs);
  }

  if (!response) {
    return {
      valid: true,
      message: 'Credential format looks valid. Provider reachability validation is not available for this agent.',
      validationMode: 'format',
    };
  }

  if (response.ok) {
    return { valid: true, message: `${agentDef.name} credential validated.`, validationMode: 'provider' };
  }

  if (response.status === 401 || response.status === 403) {
    throw errors.badRequest(`Invalid or unauthorized ${agentDef.name} credential`);
  }

  throw errors.badRequest(`${agentDef.name} validation failed with HTTP ${response.status}`);
}
