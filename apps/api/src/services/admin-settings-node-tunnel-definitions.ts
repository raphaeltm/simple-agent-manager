import { type AdminSettingDefinition, integerDefinition } from './admin-setting-definitions';

export const NODE_TUNNEL_RUNTIME_DEFAULTS = {
  apiAttempts: 3,
  apiRetryDelayMs: 250,
  cleanupRequestTimeoutMs: 10000,
  cleanupBatchSize: 10,
  cleanupSweepBudgetMs: 30000,
  cleanupBackoffBaseMs: 60000,
  cleanupBackoffMaxMs: 3600000,
  cleanupStuckAttempts: 6,
} as const;

export type NodeTunnelSettingName = `vmTunnels.${keyof typeof NODE_TUNNEL_RUNTIME_DEFAULTS}`;

export const NODE_TUNNEL_SETTINGS: readonly AdminSettingDefinition[] = [
  integerDefinition(
    'vmTunnels.apiAttempts',
    NODE_TUNNEL_RUNTIME_DEFAULTS.apiAttempts,
    'Operations',
    'Provisioning attempts for transient tunnel API GET/PUT/DELETE failures. Creation is never retried; cleanup always makes one attempt per request.',
    { min: 1, max: 10 }
  ),
  integerDefinition(
    'vmTunnels.apiRetryDelayMs',
    NODE_TUNNEL_RUNTIME_DEFAULTS.apiRetryDelayMs,
    'Operations',
    'Linear retry delay in milliseconds for idempotent tunnel API calls.',
    { min: 1, max: 30000 }
  ),
  integerDefinition(
    'vmTunnels.cleanupRequestTimeoutMs',
    NODE_TUNNEL_RUNTIME_DEFAULTS.cleanupRequestTimeoutMs,
    'Operations',
    'Per-request cleanup timeout in milliseconds, capped by the installation Cloudflare API timeout.',
    { min: 1, max: 30000 }
  ),
  integerDefinition(
    'vmTunnels.cleanupBatchSize',
    NODE_TUNNEL_RUNTIME_DEFAULTS.cleanupBatchSize,
    'Operations',
    'Maximum tunnel journal rows processed per cleanup sweep.',
    { min: 1, max: 100 }
  ),
  integerDefinition(
    'vmTunnels.cleanupSweepBudgetMs',
    NODE_TUNNEL_RUNTIME_DEFAULTS.cleanupSweepBudgetMs,
    'Operations',
    'Time budget in milliseconds before starting another tunnel cleanup row. An in-flight row may finish afterward; remaining rows stay due for the next sweep.',
    { min: 1, max: 120000 }
  ),
  integerDefinition(
    'vmTunnels.cleanupBackoffBaseMs',
    NODE_TUNNEL_RUNTIME_DEFAULTS.cleanupBackoffBaseMs,
    'Operations',
    'Initial retry delay in milliseconds after failed tunnel cleanup.',
    { min: 1, max: 86400000 }
  ),
  integerDefinition(
    'vmTunnels.cleanupBackoffMaxMs',
    NODE_TUNNEL_RUNTIME_DEFAULTS.cleanupBackoffMaxMs,
    'Operations',
    'Maximum cleanup retry delay in milliseconds. Ownership remains recorded until cleanup succeeds.',
    { min: 1, max: 604800000 }
  ),
  integerDefinition(
    'vmTunnels.cleanupStuckAttempts',
    NODE_TUNNEL_RUNTIME_DEFAULTS.cleanupStuckAttempts,
    'Operations',
    'Failed cleanup attempts before subsequent failures are reported at error severity.',
    { min: 1, max: 100 }
  ),
];
