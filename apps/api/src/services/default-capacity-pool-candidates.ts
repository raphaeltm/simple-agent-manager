import { getProviderInstanceOfferings } from '@simple-agent-manager/providers';
import type {
  CapacityPoolStatus,
  CapacityWorkloadRole,
  CredentialProvider,
  ProviderInstanceOffering,
  VMSize,
} from '@simple-agent-manager/shared';
import { isCapacityPoolStatus } from '@simple-agent-manager/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import { capacityCandidateAuthorityGeneration } from './capacity-pool-authority';
import { nextCapacityPoolTimestamp } from './capacity-pool-clock';
import {
  CAPACITY_POOL_MATERIALIZED_WORKLOAD_ROLES,
  capacityCandidateIdForRole,
  PRIMARY_CAPACITY_WORKLOAD_ROLE,
} from './capacity-pool-workload-roles';
import { providerInstanceOfferingDbValues } from './default-capacity-pool-candidate-values';
import { defaultCandidateId, legacyDefaultCandidateId } from './default-capacity-pool-helpers';

type Db = ReturnType<typeof drizzle>;
type RunnableDb = Db & { run: (query: unknown) => Promise<unknown> };

const DEFAULT_RUNTIME = 'vm';
const DEFAULT_MACHINE_CLASS = 'shared-vm';
const ACTIVE_STATUS = 'active' satisfies CapacityPoolStatus;
const DISABLED_STATUS = 'disabled' satisfies CapacityPoolStatus;
const DELETED_STATUS = 'deleted' satisfies CapacityPoolStatus;

/**
 * Columns bound per row by the bulk (unguarded) insert path. Kept in sync with the value
 * object built in {@link candidateValueForOffering}; an undercount silently exceeds D1's
 * 100-bound-parameter ceiling on a large catalog (.claude/rules/69).
 */
const CANDIDATE_INSERT_BIND_COUNT = 34;
const CANDIDATE_UPSERT_UPDATE_BIND_COUNT = 1;
const CANDIDATE_UPSERT_CHUNK_SIZE = Math.max(
  1,
  Math.floor(
    (D1_MAX_BOUND_PARAMETERS - CANDIDATE_UPSERT_UPDATE_BIND_COUNT) / CANDIDATE_INSERT_BIND_COUNT
  )
);

/**
 * Fixed binds in the missing-candidate UPDATE before the `id IN (...)` list:
 * 4 in SET (availability, unavailable_at, catalog_generation, updated_at) and 2 in WHERE
 * (pool_id, capacity_source_id). The unguarded variant binds fewer (catalog_generation is a
 * column reference), so this is a safe upper bound for both.
 */
const MISSING_CANDIDATE_UPDATE_FIXED_BIND_COUNT = 8;
/** Extra binds contributed by the generation fence: catalog_generation, id, source_generation, status. */
const MISSING_CANDIDATE_SOURCE_GENERATION_GUARD_BIND_COUNT = 4;

/** Default candidate ROWS published per invocation before the cursor defers the rest. */
export const DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BATCH_SIZE = 200;

/**
 * Durable progress store for bounded, resumable catalog publication. Backed by
 * `platform_settings` in production so a partially published huge catalog resumes on the
 * next tick instead of restarting (or being abandoned) after a process restart.
 */
export interface CapacityCandidatePublicationCursorStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string | null): Promise<void>;
}

interface EnsureCandidatesForSourceOptions {
  sourceGeneration?: number;
  sourceAuthorityGeneration?: number;
  catalogComplete?: boolean;
  /** Max candidate rows written per invocation. Defaults to the module constant. */
  publishBatchSize?: number;
  cursorStore?: CapacityCandidatePublicationCursorStore;
}

export interface EnsureCandidatesForSourceResult {
  /** Total candidate rows this catalog resolves to (offerings x materialized roles). */
  totalCandidates: number;
  /** Rows written by this invocation. */
  publishedCandidates: number;
  /** True only when every row for this catalog has been published (across all resumed ticks). */
  publicationComplete: boolean;
  /** True when missing-offering cleanup ran. Requires both complete catalog and complete publication. */
  markedMissing: boolean;
}

type ExistingCandidateRecord = Pick<
  schema.CapacityPoolCandidate,
  | 'id'
  | 'status'
  | 'providerInstanceCatalogSource'
  | 'catalogAvailability'
  | 'providerInstanceBootDiskSizeGb'
  | 'providerInstanceImage'
  | 'providerInstanceArchitecture'
>;

interface PublicationCursor {
  /** Digest of the ordered candidate-id list this progress belongs to. */
  digest: string;
  /** Number of rows already published for that exact catalog. */
  published: number;
}

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
  const digest = candidateSetDigest(candidateIds);
  const progress = await readPublicationProgress(options.cursorStore, cursorKey, digest);
  const alreadyPublished = progress.published;
  const batchSize = Math.max(
    1,
    options.publishBatchSize ?? DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BATCH_SIZE
  );
  const publishFrom = Math.min(alreadyPublished, candidateValues.length);
  const publishTo = Math.min(publishFrom + batchSize, candidateValues.length);
  const pending = candidateValues.slice(publishFrom, publishTo);

  await publishCandidateValues(db, pending, options, now);

  const publishedTotal = publishTo;
  const publicationComplete = publishedTotal >= candidateValues.length;
  // The common case is a small catalog that completes in one pass with no cursor to clear.
  // Writing (then deleting) a cursor row for every source on every reconciliation pass would
  // add two platform_settings writes per source per pass for no benefit.
  if (!publicationComplete || progress.cursorPresent) {
    await writePublicationProgress(
      options.cursorStore,
      cursorKey,
      publicationComplete ? null : { digest, published: publishedTotal }
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
    publishedCandidates: pending.length,
    publicationComplete,
    markedMissing,
  };
}

function candidateValueForOffering(input: {
  id: string;
  poolId: string;
  sourceId: string;
  provider: CredentialProvider;
  offering: ProviderInstanceOffering;
  role: CapacityWorkloadRole;
  legacyVmSize: VMSize | null;
  status: CapacityPoolStatus;
  providerValues: ReturnType<typeof providerInstanceOfferingDbValues>;
  persisted: ExistingCandidateRecord | undefined;
  candidateOrder: number;
  now: string;
  sourceGeneration: number | undefined;
  sourceAuthorityGeneration: number | undefined;
}): schema.NewCapacityPoolCandidate {
  // Provider catalogs do not carry boot disk / image / architecture; they are explicit
  // operator configuration. A refresh must therefore PRESERVE what is persisted instead of
  // publishing NULL over it (which also kept flipping the candidate authority generation).
  const providerInstanceBootDiskSizeGb = input.persisted?.providerInstanceBootDiskSizeGb ?? null;
  const providerInstanceImage = input.persisted?.providerInstanceImage ?? null;
  const providerInstanceArchitecture = input.persisted?.providerInstanceArchitecture ?? null;

  return {
    id: input.id,
    poolId: input.poolId,
    capacitySourceId: input.sourceId,
    provider: input.provider,
    location: input.offering.location,
    workloadRole: input.role,
    runtime: DEFAULT_RUNTIME,
    machineClass: DEFAULT_MACHINE_CLASS,
    machineSize: input.legacyVmSize,
    ...input.providerValues,
    providerInstanceBootDiskSizeGb,
    providerInstanceImage,
    providerInstanceArchitecture,
    catalogAvailability: 'available',
    catalogUnavailableAt: null,
    catalogReturnedAt: input.now,
    catalogGeneration: input.sourceGeneration ?? 0,
    authorityGeneration: capacityCandidateAuthorityGeneration({
      sourceAuthorityGeneration: input.sourceAuthorityGeneration ?? 0,
      id: input.id,
      poolId: input.poolId,
      capacitySourceId: input.sourceId,
      provider: input.provider,
      location: input.offering.location,
      workloadRole: input.role,
      runtime: DEFAULT_RUNTIME,
      machineClass: DEFAULT_MACHINE_CLASS,
      machineSize: input.legacyVmSize,
      providerInstanceType: input.providerValues.providerInstanceType ?? null,
      providerInstanceSku: input.providerValues.providerInstanceSku ?? null,
      providerInstanceVcpuCount: input.providerValues.providerInstanceVcpuCount ?? null,
      providerInstanceMemoryMb: input.providerValues.providerInstanceMemoryMb ?? null,
      providerInstanceDiskGb: input.providerValues.providerInstanceDiskGb ?? null,
      providerInstanceBootDiskSizeGb,
      providerInstanceImage,
      providerInstanceArchitecture,
      providerInstancePriceCurrency: input.providerValues.providerInstancePriceCurrency ?? null,
      providerInstancePriceMonthlyCents:
        input.providerValues.providerInstancePriceMonthlyCents ?? null,
      providerInstancePriceHourlyMicros:
        input.providerValues.providerInstancePriceHourlyMicros ?? null,
      providerInstanceCatalogSource: input.providerValues.providerInstanceCatalogSource,
      catalogAvailability: 'available',
      status: input.status,
    }),
    priority: input.candidateOrder,
    candidateOrder: input.candidateOrder,
    status: input.status,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

async function publishCandidateValues(
  db: Db,
  values: schema.NewCapacityPoolCandidate[],
  options: EnsureCandidatesForSourceOptions,
  now: string
): Promise<void> {
  if (values.length === 0) return;

  if (typeof options.sourceGeneration === 'number' || options.catalogComplete === false) {
    for (const candidateValue of values) {
      await upsertCandidateIfSourceGenerationCurrent(db, candidateValue, options);
    }
    return;
  }

  for (let offset = 0; offset < values.length; offset += CANDIDATE_UPSERT_CHUNK_SIZE) {
    const chunk = values.slice(offset, offset + CANDIDATE_UPSERT_CHUNK_SIZE);
    await db
      .insert(schema.capacityPoolCandidates)
      .values(chunk)
      .onConflictDoUpdate({
        target: schema.capacityPoolCandidates.id,
        set: {
          provider: sql`excluded.provider`,
          location: sql`excluded.location`,
          workloadRole: sql`excluded.workload_role`,
          runtime: sql`excluded.runtime`,
          machineClass: sql`excluded.machine_class`,
          machineSize: sql`excluded.machine_size`,
          providerInstanceType: sql`excluded.provider_instance_type`,
          providerInstanceSku: sql`excluded.provider_instance_sku`,
          providerInstanceDisplayName: sql`excluded.provider_instance_display_name`,
          providerInstanceVcpuCount: sql`excluded.provider_instance_vcpu_count`,
          providerInstanceMemoryMb: sql`excluded.provider_instance_memory_mb`,
          providerInstanceDiskGb: sql`excluded.provider_instance_disk_gb`,
          // COALESCE, never plain `excluded`: the catalog cannot supply these, so an
          // unconditional overwrite erases explicit operator configuration.
          providerInstanceBootDiskSizeGb: sql`COALESCE(excluded.provider_instance_boot_disk_size_gb, capacity_pool_candidates.provider_instance_boot_disk_size_gb)`,
          providerInstanceImage: sql`COALESCE(excluded.provider_instance_image, capacity_pool_candidates.provider_instance_image)`,
          providerInstanceArchitecture: sql`COALESCE(excluded.provider_instance_architecture, capacity_pool_candidates.provider_instance_architecture)`,
          providerInstancePriceDisplay: sql`excluded.provider_instance_price_display`,
          providerInstancePriceCurrency: sql`excluded.provider_instance_price_currency`,
          providerInstancePriceMonthlyCents: sql`excluded.provider_instance_price_monthly_cents`,
          providerInstancePriceHourlyMicros: sql`excluded.provider_instance_price_hourly_micros`,
          providerInstanceCatalogSource: sql`excluded.provider_instance_catalog_source`,
          providerInstanceCatalogLastSeenAt: sql`excluded.provider_instance_catalog_last_seen_at`,
          catalogAvailability: 'available',
          catalogReturnedAt: now,
          catalogGeneration: sql`excluded.catalog_generation`,
          authorityGeneration: sql`excluded.authority_generation`,
          updatedAt: now,
        },
      });
  }
}

function candidatePublicationCursorKey(poolId: string, sourceId: string): string {
  return `capacityPools.candidatePublication.v1:${poolId}:${sourceId}`;
}

/**
 * Stable digest of the ordered candidate-id list. Progress is only resumed for a catalog
 * that is byte-identical to the one that produced it; any catalog change restarts publication
 * rather than resuming at a meaningless offset.
 */
function candidateSetDigest(candidateIds: readonly string[]): string {
  let hash = 2166136261;
  const value = `${candidateIds.length}:${candidateIds.join(' ')}`;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function readPublicationProgress(
  store: CapacityCandidatePublicationCursorStore | undefined,
  key: string,
  digest: string
): Promise<{ published: number; cursorPresent: boolean }> {
  if (!store) return { published: 0, cursorPresent: false };
  const raw = await store.read(key);
  const cursor = parsePublicationCursor(raw);
  // A cursor for a DIFFERENT catalog is still present and must be cleared/overwritten, but it
  // contributes no progress: publication restarts from the beginning.
  if (!cursor || cursor.digest !== digest) return { published: 0, cursorPresent: raw !== null };
  return { published: cursor.published, cursorPresent: true };
}

async function writePublicationProgress(
  store: CapacityCandidatePublicationCursorStore | undefined,
  key: string,
  cursor: PublicationCursor | null
): Promise<void> {
  if (!store) return;
  await store.write(key, cursor === null ? null : JSON.stringify(cursor));
}

function parsePublicationCursor(raw: string | null): PublicationCursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const digest = record.digest;
    const published = record.published;
    if (typeof digest !== 'string' || digest.length === 0) return null;
    if (typeof published !== 'number' || !Number.isSafeInteger(published) || published < 0) {
      return null;
    }
    return { digest, published };
  } catch {
    return null;
  }
}

async function upsertCandidateIfSourceGenerationCurrent(
  db: Db,
  value: schema.NewCapacityPoolCandidate,
  options: EnsureCandidatesForSourceOptions
): Promise<void> {
  const sourceGeneration = options.sourceGeneration;
  const catalogGeneration =
    typeof sourceGeneration === 'number' ? sourceGeneration : value.catalogGeneration;
  const insertGuard =
    typeof sourceGeneration === 'number'
      ? sql`EXISTS (
          SELECT 1
          FROM capacity_sources
          WHERE id = ${value.capacitySourceId}
            AND source_generation = ${sourceGeneration}
            AND status = ${ACTIVE_STATUS}
        )`
      : sql`1 = 1`;
  const updateGuard =
    typeof sourceGeneration === 'number'
      ? sql`EXISTS (
          SELECT 1
          FROM capacity_sources
          WHERE id = excluded.capacity_source_id
            AND source_generation = excluded.catalog_generation
            AND status = ${ACTIVE_STATUS}
        )
          AND capacity_pool_candidates.catalog_generation <= excluded.catalog_generation`
      : sql`capacity_pool_candidates.catalog_generation <= excluded.catalog_generation`;
  await (db as RunnableDb).run(sql`
    INSERT INTO capacity_pool_candidates (
      id,
      pool_id,
      capacity_source_id,
      provider,
      location,
      workload_role,
      runtime,
      machine_class,
      machine_size,
      provider_instance_type,
      provider_instance_sku,
      provider_instance_display_name,
      provider_instance_vcpu_count,
      provider_instance_memory_mb,
      provider_instance_disk_gb,
      provider_instance_boot_disk_size_gb,
      provider_instance_image,
      provider_instance_architecture,
      provider_instance_price_display,
      provider_instance_price_currency,
      provider_instance_price_monthly_cents,
      provider_instance_price_hourly_micros,
      provider_instance_catalog_source,
      provider_instance_catalog_last_seen_at,
      catalog_availability,
      catalog_unavailable_at,
      catalog_returned_at,
      catalog_generation,
      authority_generation,
      priority,
      candidate_order,
      status,
      created_at,
      updated_at
    )
    SELECT
      ${value.id},
      ${value.poolId},
      ${value.capacitySourceId},
      ${value.provider},
      ${value.location},
      ${value.workloadRole},
      ${value.runtime},
      ${value.machineClass},
      ${value.machineSize},
      ${value.providerInstanceType},
      ${value.providerInstanceSku},
      ${value.providerInstanceDisplayName},
      ${value.providerInstanceVcpuCount},
      ${value.providerInstanceMemoryMb},
      ${value.providerInstanceDiskGb},
      ${value.providerInstanceBootDiskSizeGb ?? null},
      ${value.providerInstanceImage ?? null},
      ${value.providerInstanceArchitecture ?? null},
      ${value.providerInstancePriceDisplay},
      ${value.providerInstancePriceCurrency},
      ${value.providerInstancePriceMonthlyCents},
      ${value.providerInstancePriceHourlyMicros},
      ${value.providerInstanceCatalogSource},
      ${value.providerInstanceCatalogLastSeenAt},
      ${value.catalogAvailability},
      ${value.catalogUnavailableAt},
      ${value.catalogReturnedAt},
      ${catalogGeneration},
      ${value.authorityGeneration ?? 0},
      ${value.priority},
      ${value.candidateOrder},
      ${value.status},
      ${value.createdAt},
      ${value.updatedAt}
    WHERE ${insertGuard}
    ON CONFLICT(id) DO UPDATE SET
      provider = excluded.provider,
      location = excluded.location,
      workload_role = excluded.workload_role,
      runtime = excluded.runtime,
      machine_class = excluded.machine_class,
      machine_size = excluded.machine_size,
      provider_instance_type = excluded.provider_instance_type,
      provider_instance_sku = excluded.provider_instance_sku,
      provider_instance_display_name = excluded.provider_instance_display_name,
      provider_instance_vcpu_count = excluded.provider_instance_vcpu_count,
      provider_instance_memory_mb = excluded.provider_instance_memory_mb,
      provider_instance_disk_gb = excluded.provider_instance_disk_gb,
      provider_instance_boot_disk_size_gb = COALESCE(
        excluded.provider_instance_boot_disk_size_gb,
        capacity_pool_candidates.provider_instance_boot_disk_size_gb
      ),
      provider_instance_image = COALESCE(
        excluded.provider_instance_image,
        capacity_pool_candidates.provider_instance_image
      ),
      provider_instance_architecture = COALESCE(
        excluded.provider_instance_architecture,
        capacity_pool_candidates.provider_instance_architecture
      ),
      provider_instance_price_display = excluded.provider_instance_price_display,
      provider_instance_price_currency = excluded.provider_instance_price_currency,
      provider_instance_price_monthly_cents = excluded.provider_instance_price_monthly_cents,
      provider_instance_price_hourly_micros = excluded.provider_instance_price_hourly_micros,
      provider_instance_catalog_source = excluded.provider_instance_catalog_source,
      provider_instance_catalog_last_seen_at = excluded.provider_instance_catalog_last_seen_at,
      catalog_availability = 'available',
      catalog_returned_at = excluded.catalog_returned_at,
      catalog_generation = excluded.catalog_generation,
      authority_generation = excluded.authority_generation,
      updated_at = excluded.updated_at
    WHERE ${updateGuard}
      AND ${catalogSourceReplacementGuard(options.catalogComplete)}
  `);
}

function catalogSourceReplacementGuard(catalogComplete: boolean | undefined) {
  if (catalogComplete !== false) return sql`1 = 1`;
  return sql`
    CASE capacity_pool_candidates.provider_instance_catalog_source
      WHEN 'api' THEN 2
      WHEN 'static' THEN 1
      ELSE 0
    END <= CASE excluded.provider_instance_catalog_source
      WHEN 'api' THEN 2
      WHEN 'static' THEN 1
      ELSE 0
    END
  `;
}

function isCurrentlySelectableOffering(offering: ProviderInstanceOffering): boolean {
  return offering.available !== false && !offering.stale;
}

/**
 * Default pools discover the full provider-native catalog, but first creation only
 * selects concrete offerings that map to SAM's legacy supported sizes.
 *
 * Status priority:
 * 1. Existing concrete row status: explicit user additions/removals win.
 * 2. Legacy small/medium/large migration status: preserves old removals.
 * 3. Legacy metadata match: old supported concrete SKU starts active.
 * 4. New non-legacy catalog row: visible in editor, disabled for placement.
 */
export function initialStatusForProviderOffering(
  existingConcreteStatus: string | null | undefined,
  legacyMigrationStatus: string | null | undefined,
  legacyVmSize: VMSize | null
): CapacityPoolStatus {
  const concreteStatus = normalizeCapacityPoolStatus(existingConcreteStatus);
  if (concreteStatus) return concreteStatus;

  const legacyStatus = normalizeCapacityPoolStatus(legacyMigrationStatus);
  if (legacyStatus === DISABLED_STATUS || legacyStatus === DELETED_STATUS) return legacyStatus;
  if (legacyStatus === ACTIVE_STATUS) return ACTIVE_STATUS;

  return legacyVmSize ? ACTIVE_STATUS : DISABLED_STATUS;
}

function normalizeCapacityPoolStatus(value: string | null | undefined): CapacityPoolStatus | null {
  return isCapacityPoolStatus(value) ? value : null;
}

function legacyStatusForOffering(
  existingStatuses: ReadonlyMap<string, string>,
  poolId: string,
  sourceId: string,
  provider: CredentialProvider,
  offering: ProviderInstanceOffering,
  legacyVmSize: VMSize | null
): string | null {
  if (!legacyVmSize) return null;
  return (
    existingStatuses.get(
      capacityCandidateIdForRole(
        legacyDefaultCandidateId(poolId, sourceId, provider, offering.location, legacyVmSize),
        PRIMARY_CAPACITY_WORKLOAD_ROLE
      )
    ) ?? null
  );
}

function legacyVmSizeHintForOffering(
  provider: CredentialProvider,
  offering: ProviderInstanceOffering
): VMSize | null {
  if (isLegacyVmSize(offering.machineSize)) return offering.machineSize;

  const staticMatch = getProviderInstanceOfferings(provider).find(
    (legacyOffering) =>
      legacyOffering.instanceType === offering.providerInstanceType ||
      (legacyOffering.instanceSku !== null &&
        legacyOffering.instanceSku === offering.providerInstanceSku)
  );
  return staticMatch?.legacyVmSize ?? null;
}

function isLegacyVmSize(value: unknown): value is VMSize {
  return value === 'small' || value === 'medium' || value === 'large';
}

async function readExistingCandidates(
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
      providerInstanceBootDiskSizeGb:
        schema.capacityPoolCandidates.providerInstanceBootDiskSizeGb,
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

async function markMissingCandidatesForSource(
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
