import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';

/** Bounded recovery defaults; configurable without creating new infrastructure. */
export function githubTriggerRecoveryConfig(env: Env) {
  const config = {
    leaseMs: parsePositiveInt(env.GITHUB_TRIGGER_RECOVERY_LEASE_MS, 60_000),
    retryBaseMs: parsePositiveInt(env.GITHUB_TRIGGER_RECOVERY_RETRY_BASE_MS, 30_000),
    retryMaxMs: parsePositiveInt(env.GITHUB_TRIGGER_RECOVERY_RETRY_MAX_MS, 900_000),
    maxAttempts: parsePositiveInt(env.GITHUB_TRIGGER_RECOVERY_MAX_ATTEMPTS, 12),
    batchSize: parsePositiveInt(env.GITHUB_TRIGGER_RECOVERY_BATCH_SIZE, 25),
    payloadMaxBytes: parsePositiveInt(env.GITHUB_TRIGGER_RECOVERY_PAYLOAD_MAX_BYTES, 262_144),
    payloadRetentionMs: parsePositiveInt(
      env.GITHUB_TRIGGER_RECOVERY_PAYLOAD_RETENTION_MS,
      86_400_000
    ),
    dedupRetentionMs: parsePositiveInt(
      env.GITHUB_TRIGGER_RECOVERY_DEDUP_RETENTION_MS,
      7_776_000_000
    ),
  };
  config.retryMaxMs = Math.max(config.retryBaseMs, config.retryMaxMs);
  config.dedupRetentionMs = Math.max(config.payloadRetentionMs, config.dedupRetentionMs);
  return config;
}
