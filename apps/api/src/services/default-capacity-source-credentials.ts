import type { ProviderInstanceOffering } from '@simple-agent-manager/shared';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { log, serializeError } from '../lib/logger';
import { CAPACITY_SOURCE_EXTERNAL_CREDENTIAL_TYPE } from './default-capacity-pool-helpers';
import type {
  CredentialCapacitySeed,
  DefaultCapacityPoolOfferingResolution,
  DefaultCapacityPoolsBackfillOptions,
} from './default-capacity-pools';
import {
  buildProviderCatalogForCredential,
  getStaticProviderCatalogOfferings,
} from './provider-catalogs';

type Db = ReturnType<typeof drizzle>;

/** Synthetic mirror rows retired per bounded pass. */
export const DEFAULT_CAPACITY_SOURCE_CREDENTIAL_RETIREMENT_BATCH_SIZE = 50;

export interface RetireSyntheticCapacitySourceCredentialsResult {
  detachedSources: number;
  deletedCredentials: number;
  hasMore: boolean;
}

/**
 * Retire the synthetic legacy `credentials` rows that earlier revisions minted to give a
 * composable-credential-backed capacity source a `credential_id` FK target.
 *
 * That bridge COPIED encrypted provider credential material into a second row, duplicating a
 * secret and lending a source borrowed personal authority. Capacity sources now carry the
 * exact reference instead (`credential_source` + `credential_reference` = `cc_credentials:<id>`
 * + `external_source_ref` = `cc_attachments:<id>` + `credential_version`), which is the same
 * binding `createProviderForUser`/`exactCredentialBindingForResolved` mints independently.
 *
 * Ordering matters: `capacity_sources.credential_id` references `credentials.id` ON DELETE
 * CASCADE, so the referencing sources are detached BEFORE the mirror row is deleted. Deleting
 * first would cascade real capacity sources away.
 *
 * Only rows carrying the SAM-generated marker credential type are touched; no user or platform
 * credential is ever in scope.
 */
export async function retireSyntheticCapacitySourceCredentials(
  db: Db,
  options: { batchSize?: number } = {}
): Promise<RetireSyntheticCapacitySourceCredentialsResult> {
  const batchSize = Math.max(
    1,
    options.batchSize ?? DEFAULT_CAPACITY_SOURCE_CREDENTIAL_RETIREMENT_BATCH_SIZE
  );
  const mirrors = await db
    .select({ id: schema.credentials.id })
    .from(schema.credentials)
    .where(eq(schema.credentials.credentialType, CAPACITY_SOURCE_EXTERNAL_CREDENTIAL_TYPE))
    .limit(batchSize + 1);
  if (mirrors.length === 0) {
    return { detachedSources: 0, deletedCredentials: 0, hasMore: false };
  }

  const hasMore = mirrors.length > batchSize;
  const mirrorIds = mirrors.slice(0, batchSize).map((row) => row.id);

  const detached = await db
    .update(schema.capacitySources)
    .set({ credentialId: null })
    .where(
      and(
        isNotNull(schema.capacitySources.credentialId),
        inArray(schema.capacitySources.credentialId, mirrorIds)
      )
    )
    .returning({ id: schema.capacitySources.id });

  await db.delete(schema.credentials).where(inArray(schema.credentials.id, mirrorIds));

  return { detachedSources: detached.length, deletedCredentials: mirrorIds.length, hasMore };
}

/** Default TTL for the per-isolate, credential-scoped provider catalog cache. */
export const DEFAULT_CAPACITY_POOL_CATALOG_CACHE_TTL_MS = 300_000;
/** Hard cap on cached credential entries so a many-tenant isolate cannot grow unbounded. */
const CATALOG_CACHE_MAX_ENTRIES = 64;

interface CachedCatalogEntry {
  expiresAt: number;
  resolution: DefaultCapacityPoolOfferingResolution;
}

const catalogCache = new Map<string, CachedCatalogEntry>();

/** Test seam: drop cached catalogs so a suite cannot leak state between cases. */
export function clearCapacityCatalogCache(): void {
  catalogCache.clear();
}

/**
 * Credential-scoped cache key. `stateFingerprint` already encodes the credential's identity,
 * activation state, encrypted material and timestamps, so any credential rotation or
 * attachment change is a cache MISS by construction — a stale token can never be reused.
 */
function catalogCacheKey(seed: CredentialCapacitySeed): string {
  return `${seed.provider}:${seed.credentialSource}:${seed.credentialReference}:${seed.externalSourceRef ?? ''}:${seed.stateFingerprint}`;
}

function readCachedCatalog(
  key: string,
  now: number
): DefaultCapacityPoolOfferingResolution | null {
  const entry = catalogCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    catalogCache.delete(key);
    return null;
  }
  return entry.resolution;
}

function writeCachedCatalog(
  key: string,
  resolution: DefaultCapacityPoolOfferingResolution,
  ttlMs: number,
  now: number
): void {
  // Only a successful, complete refresh is cacheable. Caching a failure or a partial
  // inventory would let a transient outage masquerade as authoritative emptiness for the
  // whole TTL and strip last-known-good availability across every scope in the pass.
  if (!resolution.refreshSucceeded || resolution.catalogComplete === false) return;
  if (ttlMs <= 0) return;
  if (catalogCache.size >= CATALOG_CACHE_MAX_ENTRIES) {
    const oldestKey = catalogCache.keys().next().value;
    if (oldestKey !== undefined) catalogCache.delete(oldestKey);
  }
  catalogCache.set(key, { expiresAt: now + ttlMs, resolution });
}

function resolveCatalogCacheTtlMs(options: DefaultCapacityPoolsBackfillOptions): number {
  const raw = options.env?.CAPACITY_POOL_CATALOG_CACHE_TTL_MS;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CAPACITY_POOL_CATALOG_CACHE_TTL_MS;
  return parsed;
}

export async function resolveOfferingsForSeed(
  seed: CredentialCapacitySeed,
  options: DefaultCapacityPoolsBackfillOptions
): Promise<DefaultCapacityPoolOfferingResolution> {
  if (options.offeringResolver) {
    return normalizeOfferingResolution(await options.offeringResolver(seed));
  }

  if (options.env) {
    // One provider catalog call per credential per TTL, not one per pool scope. The
    // installation, user and project pools funded by the same platform credential otherwise
    // each issue their own external inventory request on every reconciliation pass.
    const cacheKey = catalogCacheKey(seed);
    const ttlMs = resolveCatalogCacheTtlMs(options);
    const now = Date.now();
    const cached = readCachedCatalog(cacheKey, now);
    if (cached) return cached;

    try {
      const catalog = await buildProviderCatalogForCredential({
        env: options.env,
        seed: {
          id: seed.id,
          provider: seed.provider,
          encryptedToken: seed.encryptedToken,
          iv: seed.iv,
          credentialSource: seed.credentialSource,
          credentialId: seed.catalogCredentialId,
          platformCredentialId: seed.platformCredentialId,
          capacitySourceCredentialId: seed.credentialId,
          credentialReference: seed.credentialReference,
          credentialVersion: seed.credentialVersion,
          externalSourceRef: seed.externalSourceRef,
          active: seed.active,
          createdBy: seed.createdBy,
          stateFingerprint: seed.stateFingerprint,
        },
      });
      const refreshStatus = catalog.refreshStatus;
      const resolution: DefaultCapacityPoolOfferingResolution = {
        offerings: catalog.offerings ?? [],
        refreshSucceeded: refreshStatus?.succeeded ?? true,
        catalogComplete: refreshStatus?.complete ?? true,
      };
      writeCachedCatalog(cacheKey, resolution, ttlMs, now);
      return resolution;
    } catch (error) {
      log.warn('default_capacity_pools.catalog_build_failed', {
        provider: seed.provider,
        scope: seed.scope,
        credentialSource: seed.credentialSource,
        ...serializeError(error),
      });
      return { offerings: [], refreshSucceeded: false };
    }
  }

  return {
    offerings: getStaticProviderCatalogOfferings(seed.provider),
    refreshSucceeded: true,
    catalogComplete: false,
  };
}

function normalizeOfferingResolution(
  value: ProviderInstanceOffering[] | DefaultCapacityPoolOfferingResolution
): DefaultCapacityPoolOfferingResolution {
  if (Array.isArray(value)) {
    return { offerings: value, refreshSucceeded: true, catalogComplete: true };
  }
  return value;
}
