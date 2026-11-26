/**
 * Admin settings for the SAM AI proxy: the proxy without Cloudflare AI Gateway
 * (`ai-proxy-availability.ts`) and the monthly spending limits on every install.
 * Kept apart from the resolver so the settings registry imports no resolution code (no cycle).
 */
import {
  DEFAULT_AI_COST_ESTIMATE_GATEWAY_LAG_SECONDS,
  MAX_AI_COST_ESTIMATE_GATEWAY_LAG_SECONDS,
} from '@simple-agent-manager/shared';

import type { AdminSettingDefinition } from './admin-setting-definitions';

export const AI_PROXY_DIRECT_UPSTREAM_SETTING = 'aiProxy.directUpstreamEnabled' as const;
export const AI_PROXY_PER_USER_MONTHLY_COST_CEILING_SETTING =
  'aiProxy.perUserMonthlyCostCeilingUsd' as const;
/** Gateway installs: overlap the catalog estimate keeps before the gateway total's read time. */
export const AI_PROXY_COST_ESTIMATE_GATEWAY_LAG_SETTING =
  'aiProxy.costEstimateGatewayLagSeconds' as const;
/** Test-only fake upstream (`ai-test-upstream.ts`): users whose platform-funded calls it answers. */
export const AI_TEST_UPSTREAM_USER_IDS_SETTING = 'aiProxy.testUpstreamUserIds' as const;
/** Test-only fake upstream: list-price cost, in US cents, each fake call reports. */
export const AI_TEST_UPSTREAM_COST_PER_CALL_CENTS_SETTING =
  'aiProxy.testUpstreamCostPerCallCents' as const;
/** Default fake cost: $0.40, so a $1 cap admits three calls and refuses the fourth. */
export const DEFAULT_AI_TEST_UPSTREAM_COST_PER_CALL_CENTS = 40;
/** Most user ids the fake-upstream allowlist holds; it is read on every proxy call of a test install. */
const MAX_AI_TEST_UPSTREAM_USER_IDS = 50;
/** Longest accepted user id in that allowlist. */
const MAX_AI_TEST_UPSTREAM_USER_ID_LENGTH = 128;
/** Representation bound for the fake cost: $100 per call. */
const MAX_AI_TEST_UPSTREAM_COST_PER_CALL_CENTS = 10_000;
export type AiProxySettingName =
  | typeof AI_PROXY_DIRECT_UPSTREAM_SETTING
  | typeof AI_PROXY_PER_USER_MONTHLY_COST_CEILING_SETTING
  | typeof AI_PROXY_COST_ESTIMATE_GATEWAY_LAG_SETTING
  | typeof AI_TEST_UPSTREAM_USER_IDS_SETTING
  | typeof AI_TEST_UPSTREAM_COST_PER_CALL_CENTS_SETTING;

export const AI_PROXY_SETTINGS: readonly AdminSettingDefinition[] = [
  {
    name: AI_PROXY_DIRECT_UPSTREAM_SETTING,
    type: 'boolean',
    defaultValue: false,
    category: 'AI models',
    description:
      'Turn on the SAM AI proxy (SAM-managed "sam" provider mode and server-side custom-endpoint keys) on an installation without Cloudflare AI Gateway. Calls then go straight to Anthropic or OpenAI with the platform key stored in Admin, and SAM prices them from its own model price table for the monthly cost cap of each user. Any approved user can then spend the platform key, bounded only by the daily token budgets and the monthly cap each user sets for themselves, and by the installation monthly ceiling (aiProxy.perUserMonthlyCostCeilingUsd), so set that ceiling and a spend limit on the provider account. Ignored where an AI Gateway exists (the proxy is on there).',
    secret: false,
    // Lets every approved user spend the platform key.
    risky: true,
    validate: (value) => typeof value === 'boolean',
  },
  {
    name: AI_PROXY_PER_USER_MONTHLY_COST_CEILING_SETTING,
    type: 'integer',
    defaultValue: 0,
    category: 'AI models',
    description:
      "Monthly AI spend ceiling for each user (not a total across users), in whole USD (0 = none), for calls paid with the platform key. No user can spend more than this in a UTC month, whatever monthly cap they set, and clearing their own cap does not remove it. Users cannot set a cap above it. Without Cloudflare AI Gateway it is compared with SAM's own catalog-priced total. With a gateway it is compared with the gateway's month total (refreshed hourly) plus SAM's catalog-priced estimate of calls since that refresh, so the limit applies within minutes, not an hour later. Calls to a model with no catalog price count $0 in SAM's figures, so between refreshes daily token limits remain the bound for those. Calls on a user's own key are not counted against it.",
    secret: false,
    risky: false,
    // Representation bound only: the operator chooses the business limit in this setting.
    range: { min: 0, max: Number.MAX_SAFE_INTEGER },
    validate: (value) =>
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= Number.MAX_SAFE_INTEGER,
  },
  {
    name: AI_PROXY_COST_ESTIMATE_GATEWAY_LAG_SETTING,
    type: 'integer',
    defaultValue: DEFAULT_AI_COST_ESTIMATE_GATEWAY_LAG_SECONDS,
    category: 'AI models',
    description:
      "Installations with Cloudflare AI Gateway only. Monthly spending limits add SAM's catalog-priced estimate of recent calls to the gateway's hourly month total. Calls this many seconds before that total was read are counted by both, because gateway logs can appear a few minutes after a call. A larger value refuses slightly earlier near a limit; 0 trusts the gateway total exactly to its read time.",
    secret: false,
    risky: false,
    range: { min: 0, max: MAX_AI_COST_ESTIMATE_GATEWAY_LAG_SECONDS },
    validate: (value) =>
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= MAX_AI_COST_ESTIMATE_GATEWAY_LAG_SECONDS,
  },
  {
    name: AI_TEST_UPSTREAM_USER_IDS_SETTING,
    type: 'string-list',
    defaultValue: [],
    category: 'AI models',
    description:
      'TEST INSTALLATIONS ONLY. User ids whose SAM-managed ("sam" mode) model calls are answered by a built-in fake model instead of Anthropic or OpenAI, so AI metering and spending limits can be tested with no AI key. Each fake call reports the usage that costs aiProxy.testUpstreamCostPerCallCents at the model\'s list price, and is metered and capped like a real call. Empty (the default) means off. Ignored unless the deployment sets AI_TEST_UPSTREAM_ENABLED=true on a staging, test or self-host installation (never production) without an AI Gateway. Every other user keeps the real model. Fake spend is recorded in the listed users\' real daily and monthly counters. Passthrough (custom endpoint) calls are not faked and still spend the real key.',
    secret: false,
    // Redirects the listed users' agents to a fake model.
    risky: true,
    validate: (value) =>
      Array.isArray(value) &&
      value.length <= MAX_AI_TEST_UPSTREAM_USER_IDS &&
      value.every(
        (entry) =>
          typeof entry === 'string' &&
          entry.trim().length > 0 &&
          entry.length <= MAX_AI_TEST_UPSTREAM_USER_ID_LENGTH
      ),
  },
  {
    name: AI_TEST_UPSTREAM_COST_PER_CALL_CENTS_SETTING,
    type: 'integer',
    defaultValue: DEFAULT_AI_TEST_UPSTREAM_COST_PER_CALL_CENTS,
    category: 'AI models',
    description:
      "TEST INSTALLATIONS ONLY. List-price cost, in US cents, that each fake model call reports (see aiProxy.testUpstreamUserIds). The fake sizes its reported output tokens so the model's catalog price comes to this amount; a model with no catalog price costs $0.",
    secret: false,
    risky: false,
    range: { min: 0, max: MAX_AI_TEST_UPSTREAM_COST_PER_CALL_CENTS },
    validate: (value) =>
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= MAX_AI_TEST_UPSTREAM_COST_PER_CALL_CENTS,
  },
];
