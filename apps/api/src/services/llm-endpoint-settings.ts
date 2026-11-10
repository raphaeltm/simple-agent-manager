/**
 * Admin settings for an OpenAI-compatible endpoint that SAM's own LLM calls can use instead
 * of Cloudflare AI Gateway and Workers AI (policy 9017df94: integration settings are
 * admin-editable D1 settings, not Worker vars).
 *
 * Nothing changes until an admin sets `llm.openAICompatible.baseUrl`. The API key is stored
 * encrypted in `platform_credentials` like every other secret admin setting. The dependency
 * back to the registry is type-only; only the shared secret length floor is imported at runtime.
 */
import { isAcceptableOperatorEndpoint } from '../lib/network-hosts';
import {
  type AdminSettingDefinition,
  type AdminSettingName,
  MIN_SECRET_SETTING_LENGTH,
} from './admin-setting-definitions';

/** Which control-plane caller is asking; each can use its own model on the endpoint. */
export type LlmPurpose = 'agent' | 'taskTitle' | 'diagnosis' | 'aiProxy';

const LLM_ENDPOINT_SETTING_KEYS = [
  'baseUrl',
  'apiKey',
  'model',
  'agentModel',
  'taskTitleModel',
  'diagnosisModel',
  'aiProxyModel',
  'allowPrivateNetwork',
] as const;

type LlmEndpointSettingKey = (typeof LLM_ENDPOINT_SETTING_KEYS)[number];
export type LlmEndpointSettingName = `llm.openAICompatible.${LlmEndpointSettingKey}`;

/** Per-purpose model override, falling back to `llm.openAICompatible.model`. */
export const LLM_PURPOSE_MODEL_SETTING: Readonly<Record<LlmPurpose, LlmEndpointSettingName>> = {
  agent: 'llm.openAICompatible.agentModel',
  taskTitle: 'llm.openAICompatible.taskTitleModel',
  diagnosis: 'llm.openAICompatible.diagnosisModel',
  aiProxy: 'llm.openAICompatible.aiProxyModel',
};

/** Longest accepted API key. */
const MAX_API_KEY_LENGTH = 4096;

/** Longest accepted model id; real ids are far shorter. */
const MAX_MODEL_ID_LENGTH = 200;

/**
 * An OpenAI-compatible base URL such as `https://llm.example.com/v1`: HTTPS to any host but a
 * metadata or link-local one; plain HTTP only to a private-network host, so the API key never
 * crosses the internet unencrypted (lib/network-hosts.ts). No credentials, query or fragment:
 * SAM appends `/chat/completions` itself.
 */
export function validLlmBaseUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2048) return false;
  try {
    const url = new URL(value.trim());
    return isAcceptableOperatorEndpoint(url) && !/\/chat\/completions\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

/** Normalized base URL without a trailing slash. Caller must have validated it. */
export function normalizeLlmBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function validModelId(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_MODEL_ID_LENGTH &&
    !/\s/.test(value.trim())
  );
}

const DESCRIPTIONS: Readonly<Record<LlmEndpointSettingKey, string>> = {
  baseUrl:
    "OpenAI-compatible base URL (for example https://llm.example.com/v1) for SAM's own model calls: the SAM agent, project agents, task titles, the diagnosis runner and the AI proxy's Workers AI route. Empty keeps Cloudflare AI Gateway and Workers AI.",
  apiKey: 'API key sent as a Bearer token to the OpenAI-compatible endpoint. Optional.',
  model: 'Model id used on the OpenAI-compatible endpoint when no purpose-specific model is set.',
  agentModel: 'Model id for the SAM agent and project agents on the OpenAI-compatible endpoint.',
  taskTitleModel: 'Model id for generated task titles on the OpenAI-compatible endpoint.',
  diagnosisModel: 'Model id for the diagnosis runner on the OpenAI-compatible endpoint.',
  aiProxyModel:
    "Model id that serves the AI proxy's Workers AI route (/ai/v1) on the OpenAI-compatible endpoint.",
  allowPrivateNetwork:
    'Let SAM call an endpoint on this machine or its private network (loopback, 10/8, 172.16/12, 192.168/16, a Docker service name), such as a local model server. Off: such a base URL is refused when used. Cloud metadata addresses are refused either way.',
};

function definition(key: LlmEndpointSettingKey): AdminSettingDefinition {
  const name: AdminSettingName = `llm.openAICompatible.${key}`;
  const base = {
    name,
    type: 'string' as const,
    defaultValue: null,
    category: 'AI models' as const,
    description: DESCRIPTIONS[key],
    // Redirecting every control-plane model call is spend- and data-affecting.
    risky: key === 'baseUrl' || key === 'apiKey',
  };
  if (key === 'allowPrivateNetwork') {
    // Reaching the operator's own network is a separate decision from "the URL is HTTP": a base
    // URL on a private host is refused at use time unless this is on (llm-chat-target.ts).
    return {
      ...base,
      type: 'boolean',
      defaultValue: false,
      risky: true,
      secret: false,
      validate: (value) => typeof value === 'boolean',
    };
  }
  if (key === 'apiKey') {
    return {
      ...base,
      secret: true,
      credential: { provider: 'openai-compatible', kind: 'api-key' },
      // Same floor as the OAuth secrets: a real key is never this short.
      validate: (value) =>
        typeof value === 'string' &&
        value.trim().length >= MIN_SECRET_SETTING_LENGTH &&
        value.length <= MAX_API_KEY_LENGTH,
    };
  }
  return {
    ...base,
    secret: false,
    validate: key === 'baseUrl' ? validLlmBaseUrl : validModelId,
  };
}

export function llmEndpointSettingDefinitions(): AdminSettingDefinition[] {
  return LLM_ENDPOINT_SETTING_KEYS.map(definition);
}
