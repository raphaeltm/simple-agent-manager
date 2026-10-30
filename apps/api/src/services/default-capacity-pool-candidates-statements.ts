import { sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import {
  capacityCandidateBaseId,
  PRIMARY_CAPACITY_WORKLOAD_ROLE,
} from './capacity-pool-workload-roles';
import {
  ACTIVE_STATUS,
  type Db,
  type EnsureCandidatesForSourceOptions,
} from './default-capacity-pool-candidates-common';

export function buildCandidateUpsert(
  value: schema.NewCapacityPoolCandidate,
  options: EnsureCandidatesForSourceOptions
) {
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
  const primaryId = capacityCandidateBaseId(value.id);
  const membership =
    value.workloadRole === PRIMARY_CAPACITY_WORKLOAD_ROLE
      ? sql`${value.status}`
      : sql`COALESCE((SELECT status FROM capacity_pool_candidates WHERE id = ${primaryId}
        AND pool_id = ${value.poolId} AND capacity_source_id = ${value.capacitySourceId}
        AND provider = ${value.provider} AND location = ${value.location}
        AND provider_instance_type IS ${value.providerInstanceType}
        AND provider_instance_sku IS ${value.providerInstanceSku}), 'disabled')`;
  const query = sql`
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
      ${membership},
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
      provider_instance_boot_disk_size_gb = capacity_pool_candidates.provider_instance_boot_disk_size_gb,
      provider_instance_image = capacity_pool_candidates.provider_instance_image,
      provider_instance_architecture = capacity_pool_candidates.provider_instance_architecture,
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
      status = CASE WHEN excluded.workload_role = 'deployment' THEN excluded.status ELSE capacity_pool_candidates.status END,
      updated_at = excluded.updated_at
    WHERE ${updateGuard}
      AND capacity_pool_candidates.provider_instance_boot_disk_size_gb IS ${value.providerInstanceBootDiskSizeGb ?? null}
      AND capacity_pool_candidates.provider_instance_image IS ${value.providerInstanceImage ?? null}
      AND capacity_pool_candidates.provider_instance_architecture IS ${value.providerInstanceArchitecture ?? null}
      AND ${catalogSourceReplacementGuard(options.catalogComplete)}
      AND ${candidateNeedsUpdatePredicate(membership)}
  `;
  return { query, membership };
}

export function catalogSourceReplacementGuard(catalogComplete: boolean | undefined) {
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

export function candidateNeedsUpdatePredicate(membership: ReturnType<typeof sql>) {
  return sql`(
    capacity_pool_candidates.provider IS NOT excluded.provider
    OR capacity_pool_candidates.location IS NOT excluded.location
    OR capacity_pool_candidates.workload_role <> excluded.workload_role
    OR capacity_pool_candidates.runtime IS NOT excluded.runtime
    OR capacity_pool_candidates.machine_class IS NOT excluded.machine_class
    OR capacity_pool_candidates.provider_instance_type IS NOT excluded.provider_instance_type
    OR capacity_pool_candidates.provider_instance_sku IS NOT excluded.provider_instance_sku
    OR capacity_pool_candidates.provider_instance_display_name IS NOT excluded.provider_instance_display_name
    OR capacity_pool_candidates.provider_instance_vcpu_count IS NOT excluded.provider_instance_vcpu_count
    OR capacity_pool_candidates.provider_instance_memory_mb IS NOT excluded.provider_instance_memory_mb
    OR capacity_pool_candidates.provider_instance_disk_gb IS NOT excluded.provider_instance_disk_gb
    OR capacity_pool_candidates.provider_instance_price_display IS NOT excluded.provider_instance_price_display
    OR capacity_pool_candidates.provider_instance_price_currency IS NOT excluded.provider_instance_price_currency
    OR capacity_pool_candidates.provider_instance_price_monthly_cents IS NOT excluded.provider_instance_price_monthly_cents
    OR capacity_pool_candidates.provider_instance_price_hourly_micros IS NOT excluded.provider_instance_price_hourly_micros
    OR capacity_pool_candidates.provider_instance_catalog_source IS NOT excluded.provider_instance_catalog_source
    OR capacity_pool_candidates.catalog_availability <> 'available'
    OR capacity_pool_candidates.authority_generation <> excluded.authority_generation
    OR capacity_pool_candidates.priority <> excluded.priority
    OR capacity_pool_candidates.candidate_order <> excluded.candidate_order
    OR (
      excluded.workload_role = 'deployment'
      AND capacity_pool_candidates.status IS NOT ${membership}
    )
  )`;
}

export function currentCandidateQuery(
  db: Db,
  value: schema.NewCapacityPoolCandidate,
  options: EnsureCandidatesForSourceOptions,
  membership: ReturnType<typeof sql>
) {
  const sourceGeneration = options.sourceGeneration;
  return db
    .select({ id: schema.capacityPoolCandidates.id })
    .from(schema.capacityPoolCandidates)
    .where(
      sql`
      capacity_pool_candidates.id = ${value.id}
      AND capacity_pool_candidates.pool_id = ${value.poolId}
      AND capacity_pool_candidates.capacity_source_id = ${value.capacitySourceId}
      AND ${
        typeof sourceGeneration === 'number'
          ? sql`EXISTS (
              SELECT 1
              FROM capacity_sources
              WHERE id = ${value.capacitySourceId}
                AND source_generation = ${sourceGeneration}
                AND status = ${ACTIVE_STATUS}
            )`
          : sql`1 = 1`
      }
      AND capacity_pool_candidates.provider IS ${value.provider}
      AND capacity_pool_candidates.location IS ${value.location}
      AND capacity_pool_candidates.workload_role = ${value.workloadRole}
      AND capacity_pool_candidates.runtime IS ${value.runtime}
      AND capacity_pool_candidates.machine_class IS ${value.machineClass}
      AND capacity_pool_candidates.provider_instance_type IS ${value.providerInstanceType}
      AND capacity_pool_candidates.provider_instance_sku IS ${value.providerInstanceSku}
      AND capacity_pool_candidates.provider_instance_display_name IS ${value.providerInstanceDisplayName}
      AND capacity_pool_candidates.provider_instance_vcpu_count IS ${value.providerInstanceVcpuCount}
      AND capacity_pool_candidates.provider_instance_memory_mb IS ${value.providerInstanceMemoryMb}
      AND capacity_pool_candidates.provider_instance_disk_gb IS ${value.providerInstanceDiskGb}
      AND capacity_pool_candidates.provider_instance_boot_disk_size_gb IS ${value.providerInstanceBootDiskSizeGb ?? null}
      AND capacity_pool_candidates.provider_instance_image IS ${value.providerInstanceImage ?? null}
      AND capacity_pool_candidates.provider_instance_architecture IS ${value.providerInstanceArchitecture ?? null}
      AND capacity_pool_candidates.provider_instance_price_display IS ${value.providerInstancePriceDisplay}
      AND capacity_pool_candidates.provider_instance_price_currency IS ${value.providerInstancePriceCurrency}
      AND capacity_pool_candidates.provider_instance_price_monthly_cents IS ${value.providerInstancePriceMonthlyCents}
      AND capacity_pool_candidates.provider_instance_price_hourly_micros IS ${value.providerInstancePriceHourlyMicros}
      AND capacity_pool_candidates.provider_instance_catalog_source IS ${value.providerInstanceCatalogSource}
      AND capacity_pool_candidates.catalog_availability = 'available'
      AND capacity_pool_candidates.authority_generation = ${value.authorityGeneration ?? 0}
      AND capacity_pool_candidates.priority = ${value.priority}
      AND capacity_pool_candidates.candidate_order = ${value.candidateOrder}
      AND (
        capacity_pool_candidates.workload_role <> 'deployment'
        OR capacity_pool_candidates.status IS ${membership}
      )
    `
    )
    .limit(1);
}
