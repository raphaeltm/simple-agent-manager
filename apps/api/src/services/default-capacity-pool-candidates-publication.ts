import type { CredentialProvider, ProviderInstanceOffering } from '@simple-agent-manager/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import { nextCapacityPoolTimestamp } from './capacity-pool-clock';
import {
  CAPACITY_POOL_MATERIALIZED_WORKLOAD_ROLES,
  capacityCandidateIdForRole,
} from './capacity-pool-workload-roles';
import { providerInstanceOfferingDbValues } from './default-capacity-pool-candidate-values';
import {
  ACTIVE_STATUS,
  type CapacityCandidatePublicationCursorStore,
  type Db,
  DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BATCH_SIZE,
  type EnsureCandidatesForSourceOptions,
  type EnsureCandidatesForSourceResult,
  type ExistingCandidateRecord,
  MISSING_CANDIDATE_SOURCE_GENERATION_GUARD_BIND_COUNT,
  MISSING_CANDIDATE_UPDATE_FIXED_BIND_COUNT,
  type PublicationCursor,
} from './default-capacity-pool-candidates-common';
import {
  buildCandidateUpsert,
  currentCandidateQuery,
} from './default-capacity-pool-candidates-statements';
import {
  candidateValueForOffering,
  initialStatusForProviderOffering,
  isCurrentlySelectableOffering,
  legacyStatusForOffering,
  legacyVmSizeHintForOffering,
} from './default-capacity-pool-candidates-values';
import { defaultCandidateId } from './default-capacity-pool-helpers';

export async function ensureCandidatesForSource(
  db: Db,
  poolId: string,
  sourceId: string,
  provider: CredentialProvider,
  offerings: ProviderInstanceOffering[],
  options: EnsureCandidatesForSourceOptions = {}
): Promise<EnsureCandidatesForSourceResult> {
  const now = nextCapacityPoolTimestamp();
  const existingCandidates = await readExistingCandidates(db, poolId, sourceId);
  const existingStatuses = new Map(
    [...existingCandidates.entries()].map(([id, row]) => [id, row.status])
  );
  const selectableOfferings = offerings.filter(isCurrentlySelectableOffering);
  const candidateIds: string[] = [];
  const candidateValues: schema.NewCapacityPoolCandidate[] = [];
  let candidateOrder = 0;

  for (const offering of selectableOfferings) {
    const legacyVmSize = legacyVmSizeHintForOffering(provider, offering);
    const baseId = defaultCandidateId(
      poolId,
      sourceId,
      provider,
      offering.location,
      offering.providerInstanceType,
      offering.providerInstanceSku
    );
    const legacyStatus = legacyStatusForOffering(
      existingStatuses,
      poolId,
      sourceId,
      provider,
      offering,
      legacyVmSize
    );
    // The primary (editor-visible) row owns membership. Coupled roles mirror it so a
    // deliberate removal or disable applies to every workload role of the same offering.
    const primaryStatus = initialStatusForProviderOffering(
      existingStatuses.get(baseId),
      legacyStatus,
      legacyVmSize
    );
    const providerValues = providerInstanceOfferingDbValues(offering);

    for (const role of CAPACITY_POOL_MATERIALIZED_WORKLOAD_ROLES) {
      const id = capacityCandidateIdForRole(baseId, role);
      candidateIds.push(id);
      candidateValues.push(
        candidateValueForOffering({
          id,
          poolId,
          sourceId,
          provider,
          offering,
          role,
          legacyVmSize,
          status: primaryStatus,
          providerValues,
          persisted: existingCandidates.get(id),
          candidateOrder,
          now,
          sourceGeneration: options.sourceGeneration,
          sourceAuthorityGeneration: options.sourceAuthorityGeneration,
        })
      );
    }
    candidateOrder += 1;
  }

  const cursorKey = candidatePublicationCursorKey(poolId, sourceId);
  const digest = await candidateSetDigest(candidateValues, options.sourceAuthorityGeneration);
  const progress = await readPublicationProgress(options.cursorStore, cursorKey, digest);
  const alreadyPublished = progress.published;
  const batchSize = Math.max(
    1,
    options.publishBatchSize ?? DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BATCH_SIZE
  );
  // A completed catalog keeps its readiness proof while later bounded passes refresh
  // timestamps and write generations. Changed semantic content resets that proof.
  const publishFrom = alreadyPublished >= candidateValues.length ? 0 : alreadyPublished;
  const publishTo = Math.min(publishFrom + batchSize, candidateValues.length);
  const pending = candidateValues.slice(publishFrom, publishTo);

  const published = await publishCandidateValues(db, pending, options);

  const publishedTotal = publishFrom + published;
  const publicationComplete =
    publishedTotal >= candidateValues.length || (progress.complete && published === pending.length);
  // Retain completion for multi-pass catalogs: clearing the cursor would make every
  // following identical refresh mark a ready pool migration-pending again. Small catalogs
  // still complete in one pass without a progress row.
  if (!publicationComplete || progress.cursorPresent || candidateValues.length > batchSize) {
    await writePublicationProgress(
      options.cursorStore,
      cursorKey,
      candidateValues.length <= batchSize && publicationComplete
        ? null
        : { digest, published: publishedTotal, complete: publicationComplete }
    );
  }

  // Missing-offering cleanup needs BOTH a complete catalog (the provider actually enumerated
  // its inventory) and a complete publication (every surviving row is already re-published).
  // Marking earlier would strip last-known-good availability from offerings this tick simply
  // did not reach yet.
  const markedMissing = options.catalogComplete !== false && publicationComplete;
  if (markedMissing) {
    await markMissingCandidatesForSource(
      db,
      poolId,
      sourceId,
      existingCandidates,
      candidateIds,
      options
    );
  }

  return {
    totalCandidates: candidateValues.length,
    publishedCandidates: published,
    publicationComplete,
    markedMissing,
  };
}

export async function publishCandidateValues(
  db: Db,
  values: schema.NewCapacityPoolCandidate[],
  options: EnsureCandidatesForSourceOptions
): Promise<number> {
  const prepared = values.map((value) => ({ value, ...buildCandidateUpsert(value, options) }));
  const [first, ...rest] = prepared;
  if (!first) return 0;
  // A D1 batch executes statements in order in one transaction. Primary membership
  // therefore precedes its coupled role while every statement retains its generation fence.
  // Drizzle 0.45's D1 batch cannot prepare parameterized SQLiteRaw queries
  // (its raw item has no stmt). Compile through its public raw query API, then
  // use the same request-scoped D1 binding's standard atomic batch interface.
  const written = await db.$client.batch(
    [first, ...rest].map((item) => {
      const query = db.run(item.query).getQuery();
      return db.$client.prepare(query.sql).bind(...query.params);
    })
  );
  const succeeded = written.map((result) => result.meta.changes === 1);
  const checks = prepared.flatMap((item, index) =>
    succeeded[index]
      ? []
      : [
          {
            index,
            query: currentCandidateQuery(db, item.value, options, item.membership),
          },
        ]
  );
  const [firstCheck, ...otherChecks] = checks;
  if (firstCheck) {
    const verified = await db.batch([firstCheck.query, ...otherChecks.map((item) => item.query)]);
    checks.forEach((check, index) => {
      succeeded[check.index] = (verified[index]?.length ?? 0) > 0;
    });
  }
  // The durable cursor only advances across a contiguous, successfully fenced prefix.
  const firstFailure = succeeded.indexOf(false);
  return firstFailure === -1 ? values.length : firstFailure;
}

export function candidatePublicationCursorKey(poolId: string, sourceId: string): string {
  return `capacityPools.candidatePublication.v1:${poolId}:${sourceId}`;
}

/**
 * Stable digest of the ordered candidate content. Progress is only resumed for a catalog
 * that is byte-identical to the one that produced it; any catalog change restarts publication
 * rather than resuming at a meaningless offset.
 */
export async function candidateSetDigest(
  values: schema.NewCapacityPoolCandidate[],
  sourceAuthority: number | undefined
): Promise<string> {
  // Refresh timestamps/epochs change every tick; semantic authority and full catalog
  // content bind resumable progress without preventing a large inventory from finishing.
  const serialized = JSON.stringify([
    sourceAuthority ?? 0,
    values.map((value) => {
      const {
        createdAt,
        updatedAt,
        catalogReturnedAt,
        catalogGeneration,
        providerInstanceCatalogLastSeenAt,
        ...semantic
      } = value;
      void createdAt;
      void updatedAt;
      void catalogReturnedAt;
      void catalogGeneration;
      void providerInstanceCatalogLastSeenAt;
      return semantic;
    }),
  ]);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function readPublicationProgress(
  store: CapacityCandidatePublicationCursorStore | undefined,
  key: string,
  digest: string
): Promise<{ published: number; complete: boolean; cursorPresent: boolean }> {
  if (!store) return { published: 0, complete: false, cursorPresent: false };
  const raw = await store.read(key);
  const cursor = parsePublicationCursor(raw);
  // A cursor for a DIFFERENT catalog is still present and must be cleared/overwritten, but it
  // contributes no progress: publication restarts from the beginning.
  if (!cursor || cursor.digest !== digest) {
    return { published: 0, complete: false, cursorPresent: raw !== null };
  }
  return { published: cursor.published, complete: cursor.complete === true, cursorPresent: true };
}

export async function writePublicationProgress(
  store: CapacityCandidatePublicationCursorStore | undefined,
  key: string,
  cursor: PublicationCursor | null
): Promise<void> {
  if (!store) return;
  await store.write(key, cursor === null ? null : JSON.stringify(cursor));
}

export function parsePublicationCursor(raw: string | null): PublicationCursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      !('digest' in parsed) ||
      !('published' in parsed)
    )
      return null;
    const digest = parsed.digest;
    const published = parsed.published;
    if (typeof digest !== 'string' || digest.length === 0) return null;
    if (typeof published !== 'number' || !Number.isSafeInteger(published) || published < 0) {
      return null;
    }
    if ('complete' in parsed && typeof parsed.complete !== 'boolean') return null;
    return { digest, published, complete: 'complete' in parsed && parsed.complete === true };
  } catch {
    return null;
  }
}

export async function readExistingCandidates(
  db: Db,
  poolId: string,
  sourceId: string
): Promise<Map<string, ExistingCandidateRecord>> {
  const rows = await db
    .select({
      id: schema.capacityPoolCandidates.id,
      status: schema.capacityPoolCandidates.status,
      providerInstanceCatalogSource: schema.capacityPoolCandidates.providerInstanceCatalogSource,
      catalogAvailability: schema.capacityPoolCandidates.catalogAvailability,
      providerInstanceBootDiskSizeGb: schema.capacityPoolCandidates.providerInstanceBootDiskSizeGb,
      providerInstanceImage: schema.capacityPoolCandidates.providerInstanceImage,
      providerInstanceArchitecture: schema.capacityPoolCandidates.providerInstanceArchitecture,
    })
    .from(schema.capacityPoolCandidates)
    .where(
      and(
        eq(schema.capacityPoolCandidates.poolId, poolId),
        eq(schema.capacityPoolCandidates.capacitySourceId, sourceId)
      )
    );
  return new Map(rows.map((row) => [row.id, row]));
}

export async function markMissingCandidatesForSource(
  db: Db,
  poolId: string,
  sourceId: string,
  existingCandidates: ReadonlyMap<string, ExistingCandidateRecord>,
  activeCandidateIds: string[],
  options: { sourceGeneration?: number } = {}
): Promise<void> {
  const now = nextCapacityPoolTimestamp();
  const nextCandidateIds = new Set(activeCandidateIds);
  const missingCandidateIds = [...existingCandidates.keys()].filter(
    (id) => !nextCandidateIds.has(id)
  );
  const fixedBindCount =
    MISSING_CANDIDATE_UPDATE_FIXED_BIND_COUNT +
    (typeof options.sourceGeneration === 'number'
      ? MISSING_CANDIDATE_SOURCE_GENERATION_GUARD_BIND_COUNT
      : 0);
  const chunkSize = Math.max(1, D1_MAX_BOUND_PARAMETERS - fixedBindCount);

  for (let offset = 0; offset < missingCandidateIds.length; offset += chunkSize) {
    const chunk = missingCandidateIds.slice(offset, offset + chunkSize);
    await db
      .update(schema.capacityPoolCandidates)
      .set({
        catalogAvailability: 'last-known-unavailable',
        catalogUnavailableAt: now,
        catalogGeneration:
          options.sourceGeneration ?? sql`${schema.capacityPoolCandidates.catalogGeneration}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.capacityPoolCandidates.poolId, poolId),
          eq(schema.capacityPoolCandidates.capacitySourceId, sourceId),
          typeof options.sourceGeneration === 'number'
            ? sql`${schema.capacityPoolCandidates.catalogGeneration} < ${options.sourceGeneration}
                AND EXISTS (
                  SELECT 1
                  FROM capacity_sources
                  WHERE id = ${sourceId}
                    AND source_generation = ${options.sourceGeneration}
                    AND status = ${ACTIVE_STATUS}
                )`
            : undefined,
          inArray(schema.capacityPoolCandidates.id, chunk)
        )
      );
  }
}
