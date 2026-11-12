/**
 * Admin setting for the SAM AI proxy without Cloudflare AI Gateway (`ai-proxy-availability.ts`).
 * Kept apart from the resolver so the settings registry imports no resolution code (no cycle).
 */
import type { AdminSettingDefinition } from './admin-setting-definitions';

export const AI_PROXY_DIRECT_UPSTREAM_SETTING = 'aiProxy.directUpstreamEnabled' as const;
export type AiProxySettingName = typeof AI_PROXY_DIRECT_UPSTREAM_SETTING;

export const AI_PROXY_SETTINGS: readonly AdminSettingDefinition[] = [
  {
    name: AI_PROXY_DIRECT_UPSTREAM_SETTING,
    type: 'boolean',
    defaultValue: false,
    category: 'AI models',
    description:
      'Turn on the SAM AI proxy (SAM-managed "sam" provider mode and server-side custom-endpoint keys) on an installation without Cloudflare AI Gateway. Calls then go straight to Anthropic or OpenAI with the platform key stored in Admin, and SAM prices them from its own model price table for the monthly cost cap. Ignored where an AI Gateway exists (the proxy is on there).',
    secret: false,
    // Lets every approved user spend the platform key.
    risky: true,
    validate: (value) => typeof value === 'boolean',
  },
];
