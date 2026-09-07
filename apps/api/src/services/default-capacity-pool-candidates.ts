import { getProviderInstanceOfferings } from '@simple-agent-manager/providers';
import type {
  CapacityPoolStatus,
  CredentialProvider,
  ProviderInstanceOffering,
  VMSize,
} from '@simple-agent-manager/shared';
import { isCapacityPoolStatus } from '@simple-agent-manager/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import { nextCapacityPoolTimestamp } from './capacity-pool-clock';
import { providerInstanceOfferingDbValues } from './default-capacity-pool-candidate-values';
import { defaultCandidateId, legacyDefaultCandidateId } from './default-capacity-pool-helpers';

type Db = ReturnType<typeof drizzle>;
type RunnableDb = Db & { run: (query: unknown) => Promise<unknown> };

const DEFAULT_WORKLOAD_ROLE = 'workspace';
const DEFAULT_RUNTIME = 'vm';
const DEFAULT_MACHINE_CLASS = 'shared-vm';
const ACTIVE_STATUS = 'active' satisfies CapacityPoolStatus;
const DISABLED_STATUS = 'disabled' satisfies CapacityPoolStatus;
const DELETED_STATUS = 'deleted' satisfies CapacityPoolStatus;
const CANDIDATE_INSERT_BIND_COUNT = 29;
const CANDIDATE_UPSERT_UPDATE_BIND_COUNT = 1;
const CANDIDATE_UPSERT_CHUNK_SIZE = Math.max(
  1,
  Math.floor(
    (D1_MAX_BOUND_PARAMETERS - CANDIDATE_UPSERT_UPDATE_BIND_COUNT) / CANDIDATE_INSERT_BIND_COUNT
  )
);

export async function ensureCandidatesForSource(
  db: Db,
  poolId: string,
  sourceId: string,
  provider: CredentialProvider,
  offerings: ProviderInstanceOffering[],
  options: { sourceGeneration?: number } = {}
): Promise<void> {
  const now = nextCapacityPoolTimestamp();
  const existingStatuses = await readExistingCandidateStatuses(db, poolId, sourceId);
  const selectableOfferings = offerings.filter(isCurrentlySelectableOffering);
  const candidateIds: string[] = [];
  const candidateValues: schema.NewCapacityPoolCandidate[] = [];
  let candidateOrder = 0;

  for (const offering of selectableOfferings) {
    const legacyVmSize = legacyVmSizeHintForOffering(provider, offering);
    const id = defaultCandidateId(
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
    const initialStatus = initialStatusForProviderOffering(
      existingStatuses.get(id),
      legacyStatus,
      legacyVmSize
    );
    candidateIds.push(id);
    candidateValues.push({
      id,
      poolId,
      capacitySourceId: sourceId,
      provider,
      location: offering.location,
      workloadRole: DEFAULT_WORKLOAD_ROLE,
      runtime: DEFAULT_RUNTIME,
      machineClass: DEFAULT_MACHINE_CLASS,
      machineSize: legacyVmSize,
      ...providerInstanceOfferingDbValues(offering),
      catalogAvailability: 'available',
      catalogUnavailableAt: null,
      catalogReturnedAt: now,
      catalogGeneration: options.sourceGeneration ?? 0,
      priority: candidateOrder,
      candidateOrder,
      status: initialStatus,
      createdAt: now,
      updatedAt: now,
    });
    candidateOrder += 1;
  }

  if (typeof options.sourceGeneration === 'number') {
    for (const candidateValue of candidateValues) {
      await upsertCandidateIfSourceGenerationCurrent(db, candidateValue, options.sourceGeneration);
    }
  } else {
    for (let offset = 0; offset < candidateValues.length; offset += CANDIDATE_UPSERT_CHUNK_SIZE) {
      const chunk = candidateValues.slice(offset, offset + CANDIDATE_UPSERT_CHUNK_SIZE);
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
            providerInstanceBootDiskSizeGb: sql`excluded.provider_instance_boot_disk_size_gb`,
            providerInstanceImage: sql`excluded.provider_instance_image`,
            providerInstanceArchitecture: sql`excluded.provider_instance_architecture`,
            providerInstancePriceDisplay: sql`excluded.provider_instance_price_display`,
            providerInstancePriceCurrency: sql`excluded.provider_instance_price_currency`,
            providerInstancePriceMonthlyCents: sql`excluded.provider_instance_price_monthly_cents`,
            providerInstancePriceHourlyMicros: sql`excluded.provider_instance_price_hourly_micros`,
            providerInstanceCatalogSource: sql`excluded.provider_instance_catalog_source`,
            providerInstanceCatalogLastSeenAt: sql`excluded.provider_instance_catalog_last_seen_at`,
            catalogAvailability: 'available',
            catalogReturnedAt: now,
            catalogGeneration: sql`excluded.catalog_generation`,
            updatedAt: now,
          },
        });
    }
  }

  await markMissingCandidatesForSource(
    db,
    poolId,
    sourceId,
    existingStatuses,
    candidateIds,
    options
  );
}

async function upsertCandidateIfSourceGenerationCurrent(
  db: Db,
  value: schema.NewCapacityPoolCandidate,
  sourceGeneration: number
): Promise<void> {
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
      ${sourceGeneration},
      ${value.priority},
      ${value.candidateOrder},
      ${value.status},
      ${value.createdAt},
      ${value.updatedAt}
    WHERE EXISTS (
      SELECT 1
      FROM capacity_sources
      WHERE id = ${value.capacitySourceId}
        AND source_generation = ${sourceGeneration}
        AND status = ${ACTIVE_STATUS}
    )
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
      provider_instance_boot_disk_size_gb = excluded.provider_instance_boot_disk_size_gb,
      provider_instance_image = excluded.provider_instance_image,
      provider_instance_architecture = excluded.provider_instance_architecture,
      provider_instance_price_display = excluded.provider_instance_price_display,
      provider_instance_price_currency = excluded.provider_instance_price_currency,
      provider_instance_price_monthly_cents = excluded.provider_instance_price_monthly_cents,
      provider_instance_price_hourly_micros = excluded.provider_instance_price_hourly_micros,
      provider_instance_catalog_source = excluded.provider_instance_catalog_source,
      provider_instance_catalog_last_seen_at = excluded.provider_instance_catalog_last_seen_at,
      catalog_availability = 'available',
      catalog_returned_at = excluded.catalog_returned_at,
      catalog_generation = excluded.catalog_generation,
      updated_at = excluded.updated_at
    WHERE EXISTS (
      SELECT 1
      FROM capacity_sources
      WHERE id = excluded.capacity_source_id
        AND source_generation = excluded.catalog_generation
        AND status = ${ACTIVE_STATUS}
    )
      AND capacity_pool_candidates.catalog_generation <= excluded.catalog_generation
  `);
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
      legacyDefaultCandidateId(poolId, sourceId, provider, offering.location, legacyVmSize)
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

async function readExistingCandidateStatuses(
  db: Db,
  poolId: string,
  sourceId: string
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: schema.capacityPoolCandidates.id, status: schema.capacityPoolCandidates.status })
    .from(schema.capacityPoolCandidates)
    .where(
      and(
        eq(schema.capacityPoolCandidates.poolId, poolId),
        eq(schema.capacityPoolCandidates.capacitySourceId, sourceId)
      )
    );
  return new Map(rows.map((row) => [row.id, row.status]));
}

async function markMissingCandidatesForSource(
  db: Db,
  poolId: string,
  sourceId: string,
  existingStatuses: ReadonlyMap<string, string>,
  activeCandidateIds: string[],
  options: { sourceGeneration?: number } = {}
): Promise<void> {
  const now = nextCapacityPoolTimestamp();
  const nextCandidateIds = new Set(activeCandidateIds);
  const missingCandidateIds = [...existingStatuses.keys()].filter(
    (id) => !nextCandidateIds.has(id)
  );
  const fixedBindCount = 8;
  const chunkSize = Math.max(1, D1_MAX_BOUND_PARAMETERS - fixedBindCount);

  for (let offset = 0; offset < missingCandidateIds.length; offset += chunkSize) {
    const chunk = missingCandidateIds.slice(offset, offset + chunkSize);
    await db
      .update(schema.capacityPoolCandidates)
      .set({
        providerInstanceCatalogSource: null,
        providerInstanceCatalogLastSeenAt: null,
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
