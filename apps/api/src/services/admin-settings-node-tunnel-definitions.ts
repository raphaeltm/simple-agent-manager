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
  provisioningBudgetMs: 20000,
  pendingCreateSettleMs: 900000,
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
    'Cloudflare I/O deadline in milliseconds for one tunnel cleanup sweep. An in-flight request is cancelled at the deadline; D1 failure bookkeeping completes afterward and remaining rows stay due.',
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
  integerDefinition(
    'vmTunnels.provisioningBudgetMs',
    NODE_TUNNEL_RUNTIME_DEFAULTS.provisioningBudgetMs,
    'Operations',
    'Extra time in milliseconds a durable provisioning attempt gets for tunnel setup (about six sequential Cloudflare calls) on top of the provisioning request timeout. Tunnel setup is resumable, so an attempt that still runs out continues from its recorded progress on the next attempt.',
    { min: 1, max: 120000 }
  ),
  integerDefinition(
    'vmTunnels.pendingCreateSettleMs',
    NODE_TUNNEL_RUNTIME_DEFAULTS.pendingCreateSettleMs,
    'Operations',
    'How long in milliseconds cleanup keeps waiting for a tunnel or DNS create whose response was never observed. After this window, a cleanup that found and deleted nothing left for the row marks it cleaned.',
    { min: 60000, max: 86400000 }
  ),
];
