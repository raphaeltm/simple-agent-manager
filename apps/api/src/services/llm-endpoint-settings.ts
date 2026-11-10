/**
 * Admin settings for an OpenAI-compatible endpoint that SAM's own LLM calls can use instead
 * of Cloudflare AI Gateway and Workers AI (policy 9017df94: integration settings are
 * admin-editable D1 settings, not Worker vars).
 *
 * Nothing changes until an admin sets `llm.openAICompatible.baseUrl`. The API key is stored
 * encrypted in `platform_credentials` like every other secret admin setting. The dependency
 * back to the registry is type-only; only the shared secret length floor is imported at runtime.
 */
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

/** IPv6 loopback, unique-local (fc00::/7) and link-local (fe80::/10); nothing else. */
function isPrivateIpv6(host: string): boolean {
  return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
}

/**
 * Loopback, RFC 1918, private IPv6, `.local`/`.internal` names and single-label hosts (Docker
 * service names) are on the operator's own network.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  // Every IPv6 literal contains ':'; decide those here so the single-label rule below cannot
  // admit a public IPv6 (or IPv4-mapped) address.
  if (host.includes(':')) return isPrivateIpv6(host);
  if (host === 'localhost' || !host.includes('.')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a = -1, b = -1] = octets;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * An OpenAI-compatible base URL such as `https://llm.example.com/v1`. HTTPS anywhere; plain
 * HTTP only to a loopback or private-network host, so the API key never crosses the internet
 * unencrypted. No credentials, query or fragment: SAM appends `/chat/completions` itself.
 */
export function validLlmBaseUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2048) return false;
  try {
    const url = new URL(value.trim());
    const secure = url.protocol === 'https:';
    const privateHttp = url.protocol === 'http:' && isPrivateHost(url.hostname);
    return (
      (secure || privateHttp) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/\/chat\/completions\/?$/.test(url.pathname)
    );
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
