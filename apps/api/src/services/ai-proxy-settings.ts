/**
 * Admin setting for the SAM AI proxy without Cloudflare AI Gateway (`ai-proxy-availability.ts`).
 * Kept apart from the resolver so the settings registry imports no resolution code (no cycle).
 */
import type { AdminSettingDefinition } from './admin-setting-definitions';

export const AI_PROXY_DIRECT_UPSTREAM_SETTING = 'aiProxy.directUpstreamEnabled' as const;
export const AI_PROXY_MONTHLY_COST_CEILING_SETTING = 'aiProxy.monthlyCostCeilingUsd' as const;
export type AiProxySettingName =
  typeof AI_PROXY_DIRECT_UPSTREAM_SETTING | typeof AI_PROXY_MONTHLY_COST_CEILING_SETTING;

/** Largest installation ceiling an admin can enter, in whole USD (input sanity bound only). */
export const MAX_AI_PROXY_MONTHLY_COST_CEILING_USD = 1_000_000;

export const AI_PROXY_SETTINGS: readonly AdminSettingDefinition[] = [
  {
    name: AI_PROXY_DIRECT_UPSTREAM_SETTING,
    type: 'boolean',
    defaultValue: false,
    category: 'AI models',
    description:
      'Turn on the SAM AI proxy (SAM-managed "sam" provider mode and server-side custom-endpoint keys) on an installation without Cloudflare AI Gateway. Calls then go straight to Anthropic or OpenAI with the platform key stored in Admin, and SAM prices them from its own model price table for the monthly cost cap of each user. Any approved user can then spend the platform key, bounded only by the daily token budgets and the monthly cap each user sets for themselves, and by the installation monthly ceiling (aiProxy.monthlyCostCeilingUsd), so set that ceiling and a spend limit on the provider account. Ignored where an AI Gateway exists (the proxy is on there).',
    secret: false,
    // Lets every approved user spend the platform key.
    risky: true,
    validate: (value) => typeof value === 'boolean',
  },
  {
    name: AI_PROXY_MONTHLY_COST_CEILING_SETTING,
    type: 'integer',
    defaultValue: 0,
    category: 'AI models',
    description:
      'Installation-wide monthly AI spend ceiling per user, in whole USD (0 = none). Applies where SAM prices AI calls itself, that is an installation without Cloudflare AI Gateway: no user can spend more than this in a UTC month, whatever monthly cap they set, and clearing their own cap does not remove it. Users cannot set a cap above it. Calls to a model with no catalog price count $0, so daily token limits remain the bound for those. Ignored where an AI Gateway exists (caps there are priced from gateway logs).',
    secret: false,
    risky: false,
    range: { min: 0, max: MAX_AI_PROXY_MONTHLY_COST_CEILING_USD },
    validate: (value) =>
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= MAX_AI_PROXY_MONTHLY_COST_CEILING_USD,
  },
];
