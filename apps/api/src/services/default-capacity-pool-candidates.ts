import { getProviderInstanceOfferings } from '@simple-agent-manager/providers';
import type {
  CapacityPoolStatus,
  CredentialProvider,
  ProviderInstanceOffering,
  VMSize,
} from '@simple-agent-manager/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import { providerInstanceOfferingDbValues } from './default-capacity-pool-candidate-values';
import { defaultCandidateId, legacyDefaultCandidateId } from './default-capacity-pool-helpers';

type Db = ReturnType<typeof drizzle>;
type CandidateSelectionOrigin = 'system' | 'user';
type CandidateState = {
  status: CapacityPoolStatus;
  selectionOrigin: CandidateSelectionOrigin;
};

const DEFAULT_WORKLOAD_ROLE = 'workspace';
const DEFAULT_RUNTIME = 'vm';
const DEFAULT_MACHINE_CLASS = 'shared-vm';
const SYSTEM_SELECTION_ORIGIN: CandidateSelectionOrigin = 'system';
const USER_SELECTION_ORIGIN: CandidateSelectionOrigin = 'user';
const ACTIVE_STATUS: CapacityPoolStatus = 'active';
const DISABLED_STATUS: CapacityPoolStatus = 'disabled';
const DELETED_STATUS: CapacityPoolStatus = 'deleted';
const CANDIDATE_INSERT_BIND_COUNT = 27;
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
  offerings: ProviderInstanceOffering[]
): Promise<void> {
  const now = new Date().toISOString();
  const existingStatuses = await readExistingCandidateStatuses(db, poolId, sourceId);
  const selectableOfferings = offerings.filter(isCurrentlySelectableOffering);
  const candidateIds: string[] = [];
  const candidateValues: schema.NewCapacityPoolCandidate[] = [];
  let candidateOrder = 0;

  for (const offering of selectableOfferings) {
    const id = defaultCandidateId(
      poolId,
      sourceId,
      provider,
      offering.location,
      offering.providerInstanceType,
      offering.providerInstanceSku
    );
    const existingState = existingStatuses.get(id) ?? null;
    const existingStatus = existingState?.status ?? null;
    const legacyVmSize = legacyVmSizeHintForOffering(provider, offering);
    const legacyState = legacyStateForOffering(
      existingStatuses,
      poolId,
      sourceId,
      provider,
      offering,
      legacyVmSize
    );
    const initialStatus = initialStatusForProviderOffering({
      existingStatus,
      existingSelectionOrigin: existingState?.selectionOrigin ?? null,
      legacyStatus: legacyState?.status ?? null,
      legacySelectionOrigin: legacyState?.selectionOrigin ?? null,
      legacyVmSize,
    });
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
      priority: candidateOrder,
      candidateOrder,
      status: initialStatus,
      selectionOrigin:
        existingState?.selectionOrigin === USER_SELECTION_ORIGIN
          ? USER_SELECTION_ORIGIN
          : SYSTEM_SELECTION_ORIGIN,
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
          status: sql`excluded.status`,
          selectionOrigin: sql`excluded.selection_origin`,
          updatedAt: now,
        },
      });
  }

  await markMissingCandidatesForSource(db, poolId, sourceId, existingStatuses, candidateIds);
}

export function initialStatusForProviderOffering(input: {
  existingStatus?: CapacityPoolStatus | null;
  existingSelectionOrigin?: CandidateSelectionOrigin | null;
  legacyStatus?: CapacityPoolStatus | null;
  legacySelectionOrigin?: CandidateSelectionOrigin | null;
  legacyVmSize?: VMSize | null;
}): CapacityPoolStatus {
  if (input.existingSelectionOrigin === USER_SELECTION_ORIGIN && input.existingStatus) {
    return input.existingStatus;
  }
  if (input.legacyVmSize && input.legacyStatus === DELETED_STATUS) {
    return DELETED_STATUS;
  }
  if (
    input.legacyVmSize &&
    input.legacySelectionOrigin === USER_SELECTION_ORIGIN &&
    input.legacyStatus === DISABLED_STATUS
  ) {
    return DISABLED_STATUS;
  }
  if (input.existingStatus) {
    if (input.existingStatus === DELETED_STATUS) {
      return DELETED_STATUS;
    }
    if (input.existingStatus === DISABLED_STATUS) {
      return input.legacyVmSize ? ACTIVE_STATUS : DISABLED_STATUS;
    }
    return input.legacyVmSize ? ACTIVE_STATUS : DISABLED_STATUS;
  }
  return input.legacyVmSize ? ACTIVE_STATUS : DISABLED_STATUS;
}

function isCurrentlySelectableOffering(offering: ProviderInstanceOffering): boolean {
  return offering.available !== false && !offering.stale;
}

function legacyStateForOffering(
  existingStatuses: ReadonlyMap<string, CandidateState>,
  poolId: string,
  sourceId: string,
  provider: CredentialProvider,
  offering: ProviderInstanceOffering,
  legacyVmSize: VMSize | null = legacyVmSizeHintForOffering(provider, offering)
): CandidateState | null {
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
  const staticMatch = getProviderInstanceOfferings(provider).find(
    (legacyOffering) =>
      legacyOffering.instanceType === offering.providerInstanceType ||
      (legacyOffering.instanceSku !== null &&
        legacyOffering.instanceSku === offering.providerInstanceSku)
  );
  return staticMatch?.legacyVmSize ?? null;
}

async function readExistingCandidateStatuses(
  db: Db,
  poolId: string,
  sourceId: string
): Promise<Map<string, CandidateState>> {
  const rows = await db
    .select({
      id: schema.capacityPoolCandidates.id,
      status: schema.capacityPoolCandidates.status,
      selectionOrigin: schema.capacityPoolCandidates.selectionOrigin,
    })
    .from(schema.capacityPoolCandidates)
    .where(
      and(
        eq(schema.capacityPoolCandidates.poolId, poolId),
        eq(schema.capacityPoolCandidates.capacitySourceId, sourceId)
      )
    );
  return new Map(
    rows.map((row) => [
      row.id,
      {
        status: row.status as CapacityPoolStatus,
        selectionOrigin:
          row.selectionOrigin === USER_SELECTION_ORIGIN
            ? USER_SELECTION_ORIGIN
            : SYSTEM_SELECTION_ORIGIN,
      },
    ])
  );
}

async function markMissingCandidatesForSource(
  db: Db,
  poolId: string,
  sourceId: string,
  existingStatuses: ReadonlyMap<string, CandidateState>,
  activeCandidateIds: string[]
): Promise<void> {
  const now = new Date().toISOString();
  const nextCandidateIds = new Set(activeCandidateIds);
  const missingCandidateIds = [...existingStatuses.keys()].filter(
    (id) => !nextCandidateIds.has(id)
  );
  const fixedBindCount = 5; // status/update metadata plus pool/source/status predicates
  const chunkSize = Math.max(1, D1_MAX_BOUND_PARAMETERS - fixedBindCount);

  for (let offset = 0; offset < missingCandidateIds.length; offset += chunkSize) {
    const chunk = missingCandidateIds.slice(offset, offset + chunkSize);
    await db
      .update(schema.capacityPoolCandidates)
      .set({
        providerInstanceCatalogSource: null,
        providerInstanceCatalogLastSeenAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.capacityPoolCandidates.poolId, poolId),
          eq(schema.capacityPoolCandidates.capacitySourceId, sourceId),
          inArray(schema.capacityPoolCandidates.id, chunk)
        )
      );

    const staleActiveCandidateIds = chunk.filter(
      (id) => existingStatuses.get(id)?.status === ACTIVE_STATUS
    );
    if (staleActiveCandidateIds.length === 0) continue;
    await db
      .update(schema.capacityPoolCandidates)
      .set({ status: DISABLED_STATUS, updatedAt: now })
      .where(
        and(
          eq(schema.capacityPoolCandidates.poolId, poolId),
          eq(schema.capacityPoolCandidates.capacitySourceId, sourceId),
          eq(schema.capacityPoolCandidates.status, ACTIVE_STATUS),
          inArray(schema.capacityPoolCandidates.id, staleActiveCandidateIds)
        )
      );
  }
}
