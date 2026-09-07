import type { ProviderInstanceOffering } from '@simple-agent-manager/shared';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { log, serializeError } from '../lib/logger';
import {
  CAPACITY_SOURCE_EXTERNAL_CREDENTIAL_TYPE,
  externalCapacitySourceCredentialId,
} from './default-capacity-pool-helpers';
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

/**
 * A capacity-source credential ANCHOR carries no secret material at all.
 *
 * Why an anchor row exists: migration 0125 shipped a CHECK on `capacity_sources` requiring
 * `credential_id IS NOT NULL` for every user/project-scoped cloud-provider source, and
 * `capacity_sources` is a foreign-key CASCADE parent of `capacity_pool_candidates`, so that
 * CHECK cannot be widened without a table rebuild — exactly what .claude/rules/31 forbids.
 *
 * What changed: the earlier bridge COPIED the composable credential's ciphertext and IV into
 * this row, duplicating a secret and giving the row borrowed personal authority. The anchor
 * now stores empty strings, so it is structurally sufficient for the FK/CHECK and completely
 * unusable as a credential. The source's real, exact binding is
 * `credential_source` + `credential_reference` ('cc_credentials:<id>') +
 * `external_source_ref` ('cc_attachments:<id>') + `credential_version`, which is the same
 * binding `createProviderForUser`/`exactCredentialBindingForResolved` mints independently.
 *
 * Nothing resolves anchors as usable credentials: every catalog/provider seed query filters
 * `credential_type = 'cloud-provider'`, and the anchor's type is distinct.
 */
const ANCHOR_EMPTY_SECRET = '';

/** Anchors scrubbed/pruned per bounded pass. */
export const DEFAULT_CAPACITY_SOURCE_CREDENTIAL_SCRUB_BATCH_SIZE = 50;

export interface ScrubCapacitySourceCredentialSecretsResult {
  scrubbedAnchors: number;
  deletedUnreferencedAnchors: number;
  hasMore: boolean;
}

/**
 * Bind a composable-credential-backed seed to its secret-free anchor row.
 *
 * The anchor id is unchanged from the previous bridge, so an upgrade reuses the existing row
 * (no source re-keying, no authority churn) and the conflict branch overwrites any previously
 * copied ciphertext with empty strings — the secret copy is erased on the first reconcile.
 */
export async function ensureCapacitySourceCredentialAnchor(
  db: Db,
  seed: CredentialCapacitySeed
): Promise<CredentialCapacitySeed> {
  if (seed.credentialId || seed.platformCredentialId || !seed.externalSourceRef) return seed;

  const ownerUserId = seed.createdBy ?? seed.ownerUserId;
  if (!ownerUserId) {
    throw new Error(`External capacity source seed ${seed.id} has no owning user`);
  }

  const credentialId = externalCapacitySourceCredentialId(
    seed.externalSourceRef,
    seed.credentialVersion
  );
  const now =
    typeof seed.credentialVersion === 'number' && Number.isFinite(seed.credentialVersion)
      ? new Date(seed.credentialVersion).toISOString()
      : new Date().toISOString();
  await db
    .insert(schema.credentials)
    .values({
      id: credentialId,
      userId: ownerUserId,
      projectId: seed.scope === 'project' ? seed.ownerProjectId : null,
      provider: seed.provider,
      credentialType: CAPACITY_SOURCE_EXTERNAL_CREDENTIAL_TYPE,
      credentialKind: 'api-key',
      isActive: seed.active,
      encryptedToken: ANCHOR_EMPTY_SECRET,
      iv: ANCHOR_EMPTY_SECRET,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.credentials.id,
      set: {
        userId: ownerUserId,
        projectId: seed.scope === 'project' ? seed.ownerProjectId : null,
        provider: seed.provider,
        credentialType: CAPACITY_SOURCE_EXTERNAL_CREDENTIAL_TYPE,
        credentialKind: 'api-key',
        isActive: seed.active,
        encryptedToken: ANCHOR_EMPTY_SECRET,
        iv: ANCHOR_EMPTY_SECRET,
        updatedAt: now,
      },
    });

  return { ...seed, credentialId };
}

/**
 * Bounded cleanup for anchors that reconciliation may not revisit.
 *
 * 1. Scrub any anchor that still holds copied ciphertext from the previous bridge.
 * 2. Delete anchors no capacity source references at all (credential rotation mints a new
 *    anchor id and orphans the old one). Referenced anchors are NEVER deleted: the FK is
 *    ON DELETE CASCADE, so deleting a referenced anchor would destroy real capacity sources.
 */
export async function scrubCapacitySourceCredentialSecrets(
  db: Db,
  options: { batchSize?: number } = {}
): Promise<ScrubCapacitySourceCredentialSecretsResult> {
  const batchSize = Math.max(
    1,
    options.batchSize ?? DEFAULT_CAPACITY_SOURCE_CREDENTIAL_SCRUB_BATCH_SIZE
  );
  const anchors = await db
    .select({
      id: schema.credentials.id,
      encryptedToken: schema.credentials.encryptedToken,
      iv: schema.credentials.iv,
    })
    .from(schema.credentials)
    .where(eq(schema.credentials.credentialType, CAPACITY_SOURCE_EXTERNAL_CREDENTIAL_TYPE))
    .limit(batchSize + 1);
  if (anchors.length === 0) {
    return { scrubbedAnchors: 0, deletedUnreferencedAnchors: 0, hasMore: false };
  }

  const hasMore = anchors.length > batchSize;
  const page = anchors.slice(0, batchSize);
  const anchorIds = page.map((row) => row.id);

  const leaking = page
    .filter((row) => row.encryptedToken !== ANCHOR_EMPTY_SECRET || row.iv !== ANCHOR_EMPTY_SECRET)
    .map((row) => row.id);
  if (leaking.length > 0) {
    await db
      .update(schema.credentials)
      .set({ encryptedToken: ANCHOR_EMPTY_SECRET, iv: ANCHOR_EMPTY_SECRET })
      .where(
        and(
          eq(schema.credentials.credentialType, CAPACITY_SOURCE_EXTERNAL_CREDENTIAL_TYPE),
          inArray(schema.credentials.id, leaking)
        )
      );
  }

  const referenced = await db
    .select({ credentialId: schema.capacitySources.credentialId })
    .from(schema.capacitySources)
    .where(
      and(
        isNotNull(schema.capacitySources.credentialId),
        inArray(schema.capacitySources.credentialId, anchorIds)
      )
    );
  const referencedIds = new Set(
    referenced.flatMap((row) => (row.credentialId ? [row.credentialId] : []))
  );
  const orphans = anchorIds.filter((id) => !referencedIds.has(id));
  if (orphans.length > 0) {
    await db
      .delete(schema.credentials)
      .where(
        and(
          eq(schema.credentials.credentialType, CAPACITY_SOURCE_EXTERNAL_CREDENTIAL_TYPE),
          inArray(schema.credentials.id, orphans)
        )
      );
  }

  return {
    scrubbedAnchors: leaking.length,
    deletedUnreferencedAnchors: orphans.length,
    hasMore,
  };
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
