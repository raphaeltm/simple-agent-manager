/**
 * Google Cloud list prices for the whole installation.
 *
 * Compute Engine list prices are public and the same for every project, so SAM keeps one table
 * in KV instead of one per credential. A scheduled step refreshes it once per TTL using any
 * connected Google Cloud credential that can read the Cloud Billing Catalog; catalog builds only
 * read it, so the multi-page price download never sits on a request path. A stale table is still
 * served: list prices change rarely, and an old price ranks machines better than no price.
 */
import {
  fetchGcpComputePriceTable,
  type GcpPriceTable,
  parseStoredGcpPriceTable,
} from '@simple-agent-manager/providers';
import {
  type CredentialSource,
  GCP_CLOUD_BILLING_SERVICE,
  GCP_PRICE_CATALOG_SCOPE,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { resolveAdminSetting } from './admin-settings-resolution';
import { decrypt } from './encryption';
import {
  classifyGcpApiError,
  confirmGcpApi,
  recordGcpApiIssue,
  safeProviderErrorFields,
  updateGcpApiHealthSafely,
} from './gcp-api-health';
import { createGcpTokenProvider } from './gcp-token-provider';
import { parseGcpCredential } from './provider-credential-codecs';

export const GCP_PRICE_TABLE_KV_KEY = 'gcp-price-table:v1';
export const GCP_PRICE_TABLE_ATTEMPT_KV_KEY = 'gcp-price-table:v1:last-failure';

interface StoredPriceTable {
  fetchedAt: string;
  table: GcpPriceTable;
}

export async function readGcpPriceTable(env: Env): Promise<GcpPriceTable | null> {
  return (await readStored(env))?.table ?? null;
}

async function readStored(env: Env): Promise<StoredPriceTable | null> {
  const raw = await env.KV.get(GCP_PRICE_TABLE_KV_KEY, 'json');
  if (!raw || typeof raw !== 'object') return null;
  const fetchedAt = (raw as { fetchedAt?: unknown }).fetchedAt;
  const table = parseStoredGcpPriceTable((raw as { table?: unknown }).table);
  if (typeof fetchedAt !== 'string' || Number.isNaN(Date.parse(fetchedAt)) || !table) return null;
  return { fetchedAt, table };
}

export type GcpPriceRefreshResult =
  | { status: 'fresh'; fetchedAt: string }
  | { status: 'backoff'; retryAt: string }
  | { status: 'no-credential' }
  | { status: 'refreshed'; fetchedAt: string; regions: number; credentialSource: CredentialSource }
  /**
   * Every credential tried failed. `faults` counts failures SAM operators should hear about; the
   * rest were owner-fixable states of the user's Google project (Cloud Billing API off, IAM
   * denial), recorded on the credential and shown to its owner instead.
   */
  | { status: 'failed'; attempts: number; faults: number };

/**
 * Refresh the table when it is older than the TTL. A failed refresh, or finding no Google Cloud
 * credential at all, records its time and is not retried until the retry interval passes, so a
 * project without the Cloud Billing API enabled (or an installation without Google Cloud) costs
 * one attempt per interval, not one per cron tick.
 *
 * Worst case per due tick: `priceRefreshBudgetMs` (default 90 s), however many pages or
 * credentials remain. With defaults that is one refresh a day, or one bounded attempt an hour
 * while every credential fails.
 */
export async function refreshGcpPriceTableIfDue(
  env: Env,
  now = new Date()
): Promise<GcpPriceRefreshResult> {
  const ttlMs = Number(await resolveAdminSetting(env, 'gcpCatalog.priceTableTtlMinutes')) * 60_000;
  const stored = await readStored(env);
  if (stored && Date.parse(stored.fetchedAt) + ttlMs > now.getTime()) {
    return { status: 'fresh', fetchedAt: stored.fetchedAt };
  }

  const retryMs = Number(await resolveAdminSetting(env, 'gcpCatalog.priceRetryMinutes')) * 60_000;
  const lastFailure = await readLastFailure(env);
  if (lastFailure && Date.parse(lastFailure.at) + retryMs > now.getTime()) {
    return {
      status: 'backoff',
      retryAt: new Date(Date.parse(lastFailure.at) + retryMs).toISOString(),
    };
  }

  const { candidates, offset } = await listPriceRefreshCredentials(
    env,
    lastFailure?.nextOffset ?? 0
  );
  if (candidates.length === 0) {
    // An installation without Google Cloud would otherwise probe D1 on every tick forever.
    await recordFailure(env, now, 0);
    return { status: 'no-credential' };
  }

  const options = {
    maxPages: Number(await resolveAdminSetting(env, 'gcpCatalog.priceMaxPages')),
    requestTimeoutMs: Number(await resolveAdminSetting(env, 'gcpCatalog.priceRequestTimeoutMs')),
  };
  // One budget across every credential tried: a degraded Billing API must not hold the
  // scheduled job past this, however many pages or credentials remain.
  const budgetMs = Number(await resolveAdminSetting(env, 'gcpCatalog.priceRefreshBudgetMs'));
  const budget = new AbortController();
  const budgetTimer = setTimeout(
    () => budget.abort(new Error(`GCP price refresh budget of ${budgetMs}ms spent`)),
    budgetMs
  );
  try {
    return await refreshFromCandidates(env, candidates, offset, options, budget.signal, now);
  } finally {
    clearTimeout(budgetTimer);
  }
}

async function refreshFromCandidates(
  env: Env,
  candidates: PriceRefreshCredential[],
  offset: number,
  options: { maxPages: number; requestTimeoutMs: number },
  signal: AbortSignal,
  now: Date
): Promise<GcpPriceRefreshResult> {
  let attempts = 0;
  let faults = 0;
  for (const candidate of candidates) {
    if (signal.aborted) break;
    attempts += 1;
    try {
      const decrypted = await decrypt(
        candidate.encryptedToken,
        candidate.iv,
        getCredentialEncryptionKey(env)
      );
      const token = await createGcpTokenProvider(
        parseGcpCredential(decrypted),
        {
          credentialSource: candidate.credentialSource,
          userId: candidate.userId,
          projectId: candidate.projectId,
        },
        env,
        { scopes: [GCP_PRICE_CATALOG_SCOPE] }
      )({ signal });
      const table = await fetchGcpComputePriceTable(token, options, { signal });
      // Caching a table with no usable rate would replace the previous one and unprice every
      // offering for the whole TTL. Treat it as this credential's failure instead.
      if (!hasUsableRate(table)) {
        throw new Error('Cloud Billing returned no usable core and RAM rate pair');
      }
      const fetchedAt = now.toISOString();
      await env.KV.put(GCP_PRICE_TABLE_KV_KEY, JSON.stringify({ fetchedAt, table }));
      await env.KV.delete(GCP_PRICE_TABLE_ATTEMPT_KV_KEY);
      await updateGcpApiHealthSafely(candidate.id, () =>
        confirmGcpApi(env, candidate.id, GCP_CLOUD_BILLING_SERVICE)
      );
      return {
        status: 'refreshed',
        fetchedAt,
        regions: Object.keys(table.regions).length,
        credentialSource: candidate.credentialSource,
      };
    } catch (error) {
      const ownerFixable = classifyGcpApiError(error, GCP_CLOUD_BILLING_SERVICE);
      if (ownerFixable) {
        await updateGcpApiHealthSafely(candidate.id, () =>
          recordGcpApiIssue(env, candidate.id, ownerFixable, now)
        );
      } else {
        faults += 1;
      }
      log.warn('gcp_price_table.refresh_attempt_failed', {
        credentialId: candidate.id,
        credentialSource: candidate.credentialSource,
        budgetExhausted: signal.aborted,
        ownerFixable: ownerFixable?.reason ?? null,
        ...serializeError(error),
        ...safeProviderErrorFields(error),
      });
    }
  }
  // The next retry starts after the credentials tried here, so a few that can never read
  // Billing do not hold every retry while another credential could.
  await recordFailure(env, now, offset + attempts);
  return { status: 'failed', attempts, faults };
}

function hasUsableRate(table: GcpPriceTable): boolean {
  return Object.values(table.regions).some((series) =>
    Object.values(series).some(
      (prices) => prices.coreHourly !== null && prices.ramGibHourly !== null
    )
  );
}

interface LastFailure {
  at: string;
  /** Position in the credential order where the next refresh starts. */
  nextOffset: number;
}

async function readLastFailure(env: Env): Promise<LastFailure | null> {
  const raw = await env.KV.get(GCP_PRICE_TABLE_ATTEMPT_KV_KEY, 'json');
  if (!raw || typeof raw !== 'object') return null;
  const { at, nextOffset } = raw as { at?: unknown; nextOffset?: unknown };
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
  return {
    at,
    nextOffset:
      Number.isInteger(nextOffset) && (nextOffset as number) > 0 ? (nextOffset as number) : 0,
  };
}

async function recordFailure(env: Env, now: Date, nextOffset: number): Promise<void> {
  const failure: LastFailure = { at: now.toISOString(), nextOffset };
  await env.KV.put(GCP_PRICE_TABLE_ATTEMPT_KV_KEY, JSON.stringify(failure));
}

interface PriceRefreshCredential {
  id: string;
  credentialSource: CredentialSource;
  userId: string;
  projectId: string | null;
  encryptedToken: string;
  iv: string;
}

/**
 * Credentials that may read the public price list, platform first, starting at `offset` and
 * wrapping to the start once past the end. Prices are the same for every Google project, so any
 * connected credential answers for all; only its own token is used, and only to read the catalog.
 */
async function listPriceRefreshCredentials(
  env: Env,
  offset: number
): Promise<{ candidates: PriceRefreshCredential[]; offset: number }> {
  const limit = Number(await resolveAdminSetting(env, 'gcpCatalog.priceRefreshCredentialAttempts'));
  const page = (start: number) =>
    env.DATABASE.prepare(
      `SELECT id, userId, projectId, encryptedToken, iv, credentialSource FROM (
         SELECT id, COALESCE(created_by, 'installation') AS userId, NULL AS projectId,
                encrypted_token AS encryptedToken, iv, 'platform' AS credentialSource,
                0 AS tier, updated_at AS updatedAt
           FROM platform_credentials
          WHERE provider = 'gcp' AND credential_type = 'cloud-provider' AND is_enabled = 1
         UNION ALL
         SELECT id, user_id, project_id, encrypted_token, iv,
                CASE WHEN project_id IS NULL THEN 'user' ELSE 'project' END, 1, updated_at
           FROM credentials
          WHERE provider = 'gcp' AND credential_type = 'cloud-provider' AND is_active = 1
       )
       ORDER BY tier, updatedAt DESC, id
       LIMIT ? OFFSET ?`
    )
      .bind(limit, start)
      .all<PriceRefreshCredential>();
  const rows = (await page(offset)).results ?? [];
  if (rows.length > 0 || offset === 0) return { candidates: rows, offset };
  return { candidates: (await page(0)).results ?? [], offset: 0 };
}
