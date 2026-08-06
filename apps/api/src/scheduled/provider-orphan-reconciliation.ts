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
 *  - No `ENVIRONMENT` identity            → skip the entire run
 *  - Server missing the `env` label       → skip that server (pre-existing servers)
 *  - Server labelled for another env      → skip that server
 *  - Server younger than the age floor    → skip (covers the creation race)
 *  - Any D1 read failure                  → abort the run, destroy nothing
 *  - Node id label malformed/absent       → skip that server
 *  - A claiming row in ANY non-terminal state → skip that server
 *
 * A server is destroyed only on positive evidence: it carries OUR environment label, it
 * is older than the floor, its node-id label is well-formed, and the corresponding D1
 * row is either absent or terminally deleted.
 */
import { createProvider,type Provider } from '@simple-agent-manager/providers';
import {
  DEFAULT_PROVIDER_ORPHAN_DESTROY_LIMIT,
  DEFAULT_PROVIDER_ORPHAN_MIN_AGE_MS,
  DEFAULT_PROVIDER_ORPHAN_RECONCILE_INTERVAL_MS,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import {
  resolveEnvironmentLabel,
  SAM_ENVIRONMENT_LABEL_KEY,
  SAM_MANAGED_LABEL_KEY,
  SAM_MANAGED_LABEL_VALUE,
  SAM_NODE_LABEL_KEY,
} from '../services/node-provider-labels';
import { persistError } from '../services/observability';
import { getPlatformCloudCredential } from '../services/platform-credentials';
import { buildProviderConfig } from '../services/provider-credentials';
import { parseMs, parsePositiveInt } from './node-cleanup/shared';

const DEFAULT_LAST_RUN_KV_KEY = 'cleanup:provider-orphan-reconciliation:last-run';

/** Mirrors the sibling interval-gated sweep in compose-image-artifact-cleanup.ts. */
function lastRunKey(env: Env): string {
  return env.PROVIDER_ORPHAN_RECONCILE_LAST_RUN_KV_KEY?.trim() || DEFAULT_LAST_RUN_KV_KEY;
}

/**
 * D1 node statuses that do NOT claim a provider server. Only a row in one of these
 * states permits destroying the matching server. Anything else — including unexpected
 * or future status values — counts as a live claim, so the default is to preserve.
 */
const TERMINAL_NODE_STATUSES: ReadonlySet<string> = new Set(['deleted', 'destroyed']);

export interface ProviderOrphanResult {
  enabled: boolean;
  skipped: boolean;
  skipReason: string | null;
  scanned: number;
  destroyed: number;
  skippedUnlabeled: number;
  skippedForeignEnv: number;
  skippedYoung: number;
  skippedClaimed: number;
  errors: number;
}

function emptyResult(overrides: Partial<ProviderOrphanResult> = {}): ProviderOrphanResult {
  return {
    enabled: true,
    skipped: false,
    skipReason: null,
    scanned: 0,
    destroyed: 0,
    skippedUnlabeled: 0,
    skippedForeignEnv: 0,
    skippedYoung: 0,
    skippedClaimed: 0,
    errors: 0,
    ...overrides,
  };
}

function isEnabled(env: Env): boolean {
  return env.PROVIDER_ORPHAN_RECONCILIATION_ENABLED?.trim().toLowerCase() !== 'false';
}

/** ULID shape — the only form a `node` label should ever take. */
const NODE_ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{26}$/i;

export async function runProviderOrphanReconciliation(env: Env): Promise<ProviderOrphanResult> {
  if (!isEnabled(env)) {
    return emptyResult({ enabled: false, skipped: true, skipReason: 'disabled' });
  }

  // Identity gate. Without a trustworthy environment name we cannot distinguish our
  // own servers from a sibling deployment's in a shared cloud account.
  const environmentLabel = resolveEnvironmentLabel(env);
  if (!environmentLabel) {
    log.warn('provider_orphan.skipped_no_environment', {
      reason: 'ENVIRONMENT is unset; cannot attribute provider servers to this deployment',
    });
    return emptyResult({ skipped: true, skipReason: 'no-environment-identity' });
  }

  const now = new Date();
  const intervalMs = parseMs(
    env.PROVIDER_ORPHAN_RECONCILE_INTERVAL_MS,
    DEFAULT_PROVIDER_ORPHAN_RECONCILE_INTERVAL_MS
  );
  const kvKey = lastRunKey(env);

  let lastRun: string | null;
  try {
    lastRun = await env.KV.get(kvKey);
  } catch (err) {
    log.error('provider_orphan.last_run_read_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyResult({ skipped: true, skipReason: 'last-run-read-failed', errors: 1 });
  }

  const lastRunMs = lastRun ? Date.parse(lastRun) : Number.NaN;
  if (Number.isFinite(lastRunMs) && now.getTime() - lastRunMs < intervalMs) {
    return emptyResult({ skipped: true, skipReason: 'interval-not-elapsed' });
  }

  const result = await reconcile(env, now, environmentLabel);

  // Only advance the interval marker when we actually completed a scan. A run that
  // aborted before listing must be retried on the next tick, not suppressed for an hour.
  if (!result.skipped) {
    try {
      await env.KV.put(kvKey, now.toISOString());
    } catch (err) {
      log.warn('provider_orphan.last_run_write_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

async function reconcile(
  env: Env,
  now: Date,
  environmentLabel: string
): Promise<ProviderOrphanResult> {
  const result = emptyResult();

  const minAgeMs = parseMs(env.PROVIDER_ORPHAN_MIN_AGE_MS, DEFAULT_PROVIDER_ORPHAN_MIN_AGE_MS);
  const destroyLimit = parsePositiveInt(
    env.PROVIDER_ORPHAN_DESTROY_LIMIT,
    DEFAULT_PROVIDER_ORPHAN_DESTROY_LIMIT
  );

  // Resolve the platform credential. Orphans by definition have no owning D1 row, so
  // there is no user whose credential could be resolved — the platform credential is
  // the only one that can see them.
  let provider: Provider;
  try {
    const db = drizzle(env.DATABASE);
    const platformCredential = await getPlatformCloudCredential(
      db,
      getCredentialEncryptionKey(env)
    );
    if (!platformCredential) {
      return emptyResult({ skipped: true, skipReason: 'no-platform-credential' });
    }

    provider = createProvider(
      buildProviderConfig(platformCredential.provider, platformCredential.decryptedToken, env)
    );
  } catch (err) {
    log.error('provider_orphan.credential_resolution_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyResult({ skipped: true, skipReason: 'credential-resolution-failed', errors: 1 });
  }

  // Ask the provider only for servers labelled as ours AND belonging to this
  // environment. Filtering server-side keeps a sibling deployment's servers out of the
  // candidate set entirely rather than relying on us to filter them out correctly.
  let servers: Awaited<ReturnType<Provider['listVMs']>>;
  try {
    servers = await provider.listVMs({
      [SAM_MANAGED_LABEL_KEY]: SAM_MANAGED_LABEL_VALUE,
      [SAM_ENVIRONMENT_LABEL_KEY]: environmentLabel,
    });
  } catch (err) {
    log.error('provider_orphan.list_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyResult({ skipped: true, skipReason: 'provider-list-failed', errors: 1 });
  }

  result.scanned = servers.length;

  const ageFloor = now.getTime() - minAgeMs;
  const candidates: Array<{ serverId: string; nodeId: string; createdAt: string }> = [];

  for (const server of servers) {
    const labels = server.labels ?? {};

    // Defence in depth: the provider filtered for us, but client-side label filtering
    // in some provider implementations makes it worth re-checking rather than trusting.
    const serverEnv = labels[SAM_ENVIRONMENT_LABEL_KEY];
    if (!serverEnv) {
      result.skippedUnlabeled++;
      continue;
    }
    if (serverEnv !== environmentLabel) {
      result.skippedForeignEnv++;
      continue;
    }

    const nodeId = labels[SAM_NODE_LABEL_KEY];
    if (!nodeId || !NODE_ID_PATTERN.test(nodeId)) {
      // Cannot attribute to a specific node row — never destroy on a guess.
      result.skippedUnlabeled++;
      continue;
    }

    const createdMs = Date.parse(server.createdAt);
    if (!Number.isFinite(createdMs) || createdMs > ageFloor) {
      // Unparseable creation time is treated as "too young" — fail closed.
      result.skippedYoung++;
      continue;
    }

    candidates.push({ serverId: server.id, nodeId, createdAt: server.createdAt });
  }

  if (candidates.length === 0) {
    return result;
  }

  // Single batched lookup of every candidate's claiming row. One query keeps the D1
  // cost independent of candidate count (rule 47) and gives a consistent snapshot.
  let claimingRows: Map<string, string>;
  try {
    claimingRows = await loadClaimingNodeStatuses(
      env,
      candidates.map((c) => c.nodeId)
    );
  } catch (err) {
    // A partial or failed read would make live nodes look unclaimed. Abort.
    log.error('provider_orphan.claim_lookup_failed', {
      error: err instanceof Error ? err.message : String(err),
      candidates: candidates.length,
    });
    return { ...result, skipped: true, skipReason: 'claim-lookup-failed', errors: 1 };
  }

  for (const candidate of candidates) {
    if (result.destroyed >= destroyLimit) {
      log.info('provider_orphan.destroy_limit_reached', {
        destroyLimit,
        remaining: candidates.length - result.destroyed,
      });
      break;
    }

    const status = claimingRows.get(candidate.nodeId.toLowerCase());
    if (status !== undefined && !TERMINAL_NODE_STATUSES.has(status)) {
      result.skippedClaimed++;
      continue;
    }

    try {
      log.warn('provider_orphan.destroying', {
        serverId: candidate.serverId,
        nodeId: candidate.nodeId,
        createdAt: candidate.createdAt,
        claimStatus: status ?? 'no-row',
        environment: environmentLabel,
      });

      await provider.deleteVM(candidate.serverId);

      await persistError(env.OBSERVABILITY_DATABASE, {
        source: 'api',
        level: 'warn',
        message: 'Destroyed provider server that no live node row claimed',
        context: {
          recoveryType: 'provider_orphan_reconciliation',
          nodeId: candidate.nodeId,
          providerInstanceId: candidate.serverId,
          serverCreatedAt: candidate.createdAt,
          claimStatus: status ?? 'no-row',
          environment: environmentLabel,
          minAgeMs,
        },
        nodeId: candidate.nodeId,
      });

      result.destroyed++;
    } catch (err) {
      log.error('provider_orphan.destroy_failed', {
        serverId: candidate.serverId,
        nodeId: candidate.nodeId,
        error: err instanceof Error ? err.message : String(err),
      });
      result.errors++;
    }
  }

  return result;
}

/**
 * Look up the D1 status of each candidate node id.
 *
 * Returns a map keyed by lowercased node id. A missing key means "no row exists",
 * which is a destroy-eligible signal; a present key carries the row's status, which
 * gates the destroy.
 */
async function loadClaimingNodeStatuses(
  env: Env,
  nodeIds: string[]
): Promise<Map<string, string>> {
  const statuses = new Map<string, string>();
  if (nodeIds.length === 0) return statuses;

  const placeholders = nodeIds.map(() => '?').join(', ');
  const rows = await env.DATABASE.prepare(
    `SELECT id, status FROM nodes WHERE lower(id) IN (${placeholders})`
  )
    .bind(...nodeIds.map((id) => id.toLowerCase()))
    .all<{ id: string; status: string }>();

  for (const row of rows.results) {
    statuses.set(row.id.toLowerCase(), row.status);
  }

  return statuses;
}
