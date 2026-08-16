/**
 * Provider-side orphan reconciliation.
 *
 * Every other cleanup path in SAM starts from a D1 `nodes` row. That leaves one class
 * of leak entirely uncovered: a cloud server that EXISTS at the provider but which no
 * D1 row claims. Two real paths produce them:
 *
 *  1. `provisionNode` writes `provider_instance_id` only AFTER `createVM` returns, so a
 *     crash in that window leaves a running server the database never learned about.
 *  2. On a transient capacity failure `provisionNode` DELETES the node row outright — if
 *     the server was in fact created, nothing remembers it.
 *
 * Such a server bills forever and consumes account quota. SAM's staging and production
 * share one Hetzner project with a 10-server limit, so a single leak is a merge blocker.
 *
 * ── Why this is written fail-closed ────────────────────────────────────────────────
 * This is the only code in SAM that destroys infrastructure on the basis of something
 * being ABSENT rather than present. Absence is weak evidence: a server can look
 * unclaimed because it belongs to a SIBLING DEPLOYMENT sharing the cloud account, or
 * because we read a stale/partial view of the database. Getting this wrong destroys
 * production servers.
 *
 * So every uncertainty resolves to "do nothing":
 *  - No exact installation/environment identity → skip the entire run
 *  - Server missing/foreign `installation` label → skip that server
 *  - Server missing the `env` label       → skip that server (pre-existing servers)
 *  - Server labelled for another env      → skip that server
 *  - Server younger than the age floor    → skip (covers the creation race)
 *  - Any D1 read failure                  → abort the run, destroy nothing
 *  - Node id label malformed/absent       → skip that server
 *  - A claiming row in ANY non-terminal state → skip that server
 *
 * A server is destroyed only on positive evidence: it carries OUR exact generated
 * installation label and environment scope, it is older than the floor, its node-id
 * label is well-formed, and the corresponding D1 row is either absent or terminally
 * deleted with the same provider instance id.
 */
import { DEFAULT_PROVIDER_ORPHAN_RECONCILE_INTERVAL_MS } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveEnvironmentLabel, resolveInstallationId } from '../services/node-provider-labels';
import { parseMs } from './node-cleanup/shared';
import {
  emptyProviderOrphanResult,
  type ProviderOrphanResult,
  reconcileProviderOrphans,
} from './provider-orphan-reconciliation-core';

const DEFAULT_LAST_RUN_KV_KEY = 'cleanup:provider-orphan-reconciliation:last-run';

/** Mirrors the sibling interval-gated sweep in compose-image-artifact-cleanup.ts. */
function lastRunKey(env: Env): string {
  return env.PROVIDER_ORPHAN_RECONCILE_LAST_RUN_KV_KEY?.trim() || DEFAULT_LAST_RUN_KV_KEY;
}

export type { ProviderOrphanResult } from './provider-orphan-reconciliation-core';

function isEnabled(env: Env): boolean {
  return env.PROVIDER_ORPHAN_RECONCILIATION_ENABLED?.trim().toLowerCase() !== 'false';
}

export async function runProviderOrphanReconciliation(env: Env): Promise<ProviderOrphanResult> {
  if (!isEnabled(env)) {
    return emptyProviderOrphanResult({ enabled: false, skipped: true, skipReason: 'disabled' });
  }
  const scope = resolveOwnershipScope(env);
  if ('result' in scope) return scope.result;
  const now = new Date();
  const kvKey = lastRunKey(env);
  const intervalResult = await checkInterval(env, kvKey, now);
  if (intervalResult) return intervalResult;
  const result = await reconcileProviderOrphans(env, now, scope);
  if (!result.skipped) await recordLastRun(env, kvKey, now);
  return result;
}

function resolveOwnershipScope(
  env: Env
): { environmentLabel: string; installationId: string } | { result: ProviderOrphanResult } {
  const environmentLabel = resolveEnvironmentLabel(env);
  if (!environmentLabel) {
    log.warn('provider_orphan.skipped_no_environment', {
      reason: 'ENVIRONMENT is unset; cannot attribute provider servers to this deployment',
    });
    return {
      result: emptyProviderOrphanResult({
        skipped: true,
        skipReason: 'no-environment-identity',
      }),
    };
  }
  const installationId = resolveInstallationId(env);
  if (installationId) return { environmentLabel, installationId };
  log.warn('provider_orphan.skipped_no_installation', {
    reason: 'SAM_INSTALLATION_ID is missing or malformed; exact ownership is unavailable',
    action: 'run the generated Pulumi and Wrangler configuration update',
  });
  return {
    result: emptyProviderOrphanResult({
      skipped: true,
      skipReason: 'no-installation-identity',
    }),
  };
}

async function checkInterval(
  env: Env,
  kvKey: string,
  now: Date
): Promise<ProviderOrphanResult | null> {
  try {
    const lastRun = await env.KV.get(kvKey);
    const lastRunMs = lastRun ? Date.parse(lastRun) : Number.NaN;
    const intervalMs = parseMs(
      env.PROVIDER_ORPHAN_RECONCILE_INTERVAL_MS,
      DEFAULT_PROVIDER_ORPHAN_RECONCILE_INTERVAL_MS
    );
    return Number.isFinite(lastRunMs) && now.getTime() - lastRunMs < intervalMs
      ? emptyProviderOrphanResult({ skipped: true, skipReason: 'interval-not-elapsed' })
      : null;
  } catch (err) {
    log.error('provider_orphan.last_run_read_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyProviderOrphanResult({
      skipped: true,
      skipReason: 'last-run-read-failed',
      errors: 1,
    });
  }
}

async function recordLastRun(env: Env, kvKey: string, now: Date): Promise<void> {
  try {
    await env.KV.put(kvKey, now.toISOString());
  } catch (err) {
    log.warn('provider_orphan.last_run_write_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
