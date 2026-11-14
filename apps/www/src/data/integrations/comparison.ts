/**
 * Rows for the comparison tables on /integrations/. Sources: AgentSettingsCard.tsx
 * (supportsSamProvider), AGENT_CATALOG oauthSupport, harness-capabilities.ts, and each provider's
 * locations and *_VOLUME_CAPABILITIES. tests/integrations-catalog.test.ts checks them.
 */

/** One row per agent in the hub's comparison table. */
export interface AgentMatrixRow {
  slug: string;
  apiKey: string;
  subscription: string | null;
  proxy: boolean;
  customEndpoint: string | null;
}

export const agentMatrix: AgentMatrixRow[] = [
  {
    slug: 'claude-code',
    apiKey: 'Anthropic',
    subscription: 'Claude Pro / Max',
    proxy: true,
    customEndpoint: 'Anthropic-compatible',
  },
  {
    slug: 'codex',
    apiKey: 'OpenAI',
    subscription: 'ChatGPT',
    proxy: true,
    customEndpoint: 'OpenAI-compatible',
  },
  { slug: 'gemini-cli', apiKey: 'Gemini', subscription: null, proxy: false, customEndpoint: null },
  {
    slug: 'google-antigravity',
    apiKey: 'Gemini',
    subscription: null,
    proxy: false,
    customEndpoint: null,
  },
  {
    slug: 'mistral-vibe',
    apiKey: 'Mistral',
    subscription: null,
    proxy: false,
    customEndpoint: null,
  },
  {
    slug: 'opencode',
    apiKey: 'OpenCode Zen / Go',
    subscription: null,
    proxy: false,
    customEndpoint: 'OpenAI-compatible',
  },
  { slug: 'amp', apiKey: 'Amp', subscription: null, proxy: false, customEndpoint: null },
];

/** One row per provider in the hub's comparison table. */
export interface CloudMatrixRow {
  slug: string;
  locations: string;
  volumes: boolean;
  credential: string;
}

export const cloudMatrix: CloudMatrixRow[] = [
  { slug: 'hetzner', locations: '5 · DE, FI, US', volumes: true, credential: 'API token' },
  { slug: 'scaleway', locations: '8 · FR, NL, PL', volumes: true, credential: 'API key' },
  { slug: 'infomaniak', locations: '2 · CH', volumes: true, credential: 'Application credential' },
  { slug: 'vultr', locations: '9 · EU, NA, Asia, AU', volumes: true, credential: 'API key' },
  {
    slug: 'digitalocean',
    locations: '10 · EU, NA, Asia, AU',
    volumes: true,
    credential: 'Access token',
  },
  {
    slug: 'upcloud',
    locations: '10 · EU, US, SG, AU',
    volumes: true,
    credential: 'API subaccount',
  },
  {
    slug: 'gcp',
    locations: '8 zones · US, EU, Asia',
    volumes: false,
    credential: 'Google sign-in (WIF) or key',
  },
];
