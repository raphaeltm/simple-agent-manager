import { getProviderInstanceOfferings } from '@simple-agent-manager/providers';
import type { CredentialProvider, ProviderInstanceOffering, VMSize } from '@simple-agent-manager/shared';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import { providerInstanceOfferingDbValues } from './default-capacity-pool-candidate-values';
import {
  defaultCandidateId,
  legacyDefaultCandidateId,
} from './default-capacity-pool-helpers';

type Db = ReturnType<typeof drizzle>;

const DEFAULT_WORKLOAD_ROLE = 'workspace';
const DEFAULT_RUNTIME = 'vm';
const DEFAULT_MACHINE_CLASS = 'shared-vm';
const ACTIVE_STATUS = 'active';
const DISABLED_STATUS = 'disabled';
const DELETED_STATUS = 'deleted';
const CANDIDATE_INSERT_BIND_COUNT = 26;
const CANDIDATE_UPSERT_UPDATE_BIND_COUNT = 1;
const CANDIDATE_UPSERT_CHUNK_SIZE = Math.max(
  1,
  Math.floor(
    (D1_MAX_BOUND_PARAMETERS - CANDIDATE_UPSERT_UPDATE_BIND_COUNT) /
      CANDIDATE_INSERT_BIND_COUNT
  )
);

export async function ensureCandidatesForSource(
  db: Db,
  poolId: string,
  sourceId: string,
  provider: CredentialProvider,
  offerings: ProviderInstanceOffering[]
): Promise<void> {
  const now = new Date().toISOString();
  const existingStatuses = await readExistingCandidateStatuses(db, poolId, sourceId);
  const candidateIds: string[] = [];
  const candidateValues: schema.NewCapacityPoolCandidate[] = [];
  let candidateOrder = 0;

  for (const offering of offerings) {
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
      offering
    );
    const initialStatus =
      legacyStatus === DISABLED_STATUS || legacyStatus === DELETED_STATUS
        ? legacyStatus
        : ACTIVE_STATUS;
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
      machineSize: legacyVmSizeHintForOffering(provider, offering),
      ...providerInstanceOfferingDbValues(offering),
      priority: candidateOrder,
      candidateOrder,
      status: initialStatus,
      createdAt: now,
      updatedAt: now,
    });
    candidateOrder += 1;
  }

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
          providerInstancePriceDisplay: sql`excluded.provider_instance_price_display`,
          providerInstancePriceCurrency: sql`excluded.provider_instance_price_currency`,
          providerInstancePriceMonthlyCents: sql`excluded.provider_instance_price_monthly_cents`,
          providerInstancePriceHourlyMicros: sql`excluded.provider_instance_price_hourly_micros`,
          providerInstanceCatalogSource: sql`excluded.provider_instance_catalog_source`,
          providerInstanceCatalogLastSeenAt: sql`excluded.provider_instance_catalog_last_seen_at`,
          updatedAt: now,
        },
      });
  }

  await disableMissingCandidatesForSource(db, poolId, sourceId, candidateIds);
}

function legacyStatusForOffering(
  existingStatuses: ReadonlyMap<string, string>,
  poolId: string,
  sourceId: string,
  provider: CredentialProvider,
  offering: ProviderInstanceOffering
): string | null {
  const legacyVmSize = legacyVmSizeHintForOffering(provider, offering);
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

async function disableMissingCandidatesForSource(
  db: Db,
  poolId: string,
  sourceId: string,
  activeCandidateIds: string[]
): Promise<void> {
  const now = new Date().toISOString();
  const predicates = [
    eq(schema.capacityPoolCandidates.poolId, poolId),
    eq(schema.capacityPoolCandidates.capacitySourceId, sourceId),
  ];
  await db
    .update(schema.capacityPoolCandidates)
    .set({ status: DISABLED_STATUS, updatedAt: now })
    .where(
      activeCandidateIds.length > 0
        ? and(
            ...predicates,
            eq(schema.capacityPoolCandidates.status, ACTIVE_STATUS),
            notInArray(schema.capacityPoolCandidates.id, activeCandidateIds)
          )
        : and(...predicates, eq(schema.capacityPoolCandidates.status, ACTIVE_STATUS))
    );
}
