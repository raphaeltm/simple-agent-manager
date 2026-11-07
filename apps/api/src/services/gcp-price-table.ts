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
import { type CredentialSource, GCP_PRICE_CATALOG_SCOPE } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { resolveAdminSetting } from './admin-settings-resolution';
import { decrypt } from './encryption';
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
  | { status: 'failed'; attempts: number };

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
  const lastFailure = await env.KV.get(GCP_PRICE_TABLE_ATTEMPT_KV_KEY);
  if (lastFailure && Date.parse(lastFailure) + retryMs > now.getTime()) {
    return {
      status: 'backoff',
      retryAt: new Date(Date.parse(lastFailure) + retryMs).toISOString(),
    };
  }

  const candidates = await listPriceRefreshCredentials(env);
  if (candidates.length === 0) {
    // An installation without Google Cloud would otherwise probe D1 on every tick forever.
    await env.KV.put(GCP_PRICE_TABLE_ATTEMPT_KV_KEY, now.toISOString());
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
    return await refreshFromCandidates(env, candidates, options, budget.signal, now);
  } finally {
    clearTimeout(budgetTimer);
  }
}

async function refreshFromCandidates(
  env: Env,
  candidates: PriceRefreshCredential[],
  options: { maxPages: number; requestTimeoutMs: number },
  signal: AbortSignal,
  now: Date
): Promise<GcpPriceRefreshResult> {
  let attempts = 0;
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
      const fetchedAt = now.toISOString();
      await env.KV.put(GCP_PRICE_TABLE_KV_KEY, JSON.stringify({ fetchedAt, table }));
      await env.KV.delete(GCP_PRICE_TABLE_ATTEMPT_KV_KEY);
      return {
        status: 'refreshed',
        fetchedAt,
        regions: Object.keys(table.regions).length,
        credentialSource: candidate.credentialSource,
      };
    } catch (error) {
      log.warn('gcp_price_table.refresh_attempt_failed', {
        credentialId: candidate.id,
        credentialSource: candidate.credentialSource,
        budgetExhausted: signal.aborted,
        ...serializeError(error),
      });
    }
  }
  await env.KV.put(GCP_PRICE_TABLE_ATTEMPT_KV_KEY, now.toISOString());
  return { status: 'failed', attempts };
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
 * Credentials that may read the public price list, platform first. Prices are the same for every
 * Google project, so any connected credential answers for all; only its own token is used, and
 * only to read the catalog.
 */
async function listPriceRefreshCredentials(env: Env): Promise<PriceRefreshCredential[]> {
  const limit = Number(await resolveAdminSetting(env, 'gcpCatalog.priceRefreshCredentialAttempts'));
  const platform = await env.DATABASE.prepare(
    `SELECT id, COALESCE(created_by, 'installation') AS userId, encrypted_token AS encryptedToken, iv
       FROM platform_credentials
      WHERE provider = 'gcp' AND credential_type = 'cloud-provider' AND is_enabled = 1
      ORDER BY updated_at DESC LIMIT ?`
  )
    .bind(limit)
    .all<{ id: string; userId: string; encryptedToken: string; iv: string }>();
  const platformRows = platform.results ?? [];
  const remaining = limit - platformRows.length;
  if (remaining <= 0) {
    return platformRows.map((row) => ({ ...row, credentialSource: 'platform', projectId: null }));
  }
  const owned = await env.DATABASE.prepare(
    `SELECT id, user_id AS userId, project_id AS projectId, encrypted_token AS encryptedToken, iv
       FROM credentials
      WHERE provider = 'gcp' AND credential_type = 'cloud-provider' AND is_active = 1
      ORDER BY updated_at DESC LIMIT ?`
  )
    .bind(remaining)
    .all<{
      id: string;
      userId: string;
      projectId: string | null;
      encryptedToken: string;
      iv: string;
    }>();
  return [
    ...platformRows.map((row) => ({
      ...row,
      credentialSource: 'platform' as const,
      projectId: null,
    })),
    ...(owned.results ?? []).map((row) => ({
      ...row,
      credentialSource: (row.projectId ? 'project' : 'user') as CredentialSource,
    })),
  ];
}
