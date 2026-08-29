import type { CapacityPlacementSnapshot } from '@simple-agent-manager/shared';

export const CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS = `
  capacity_pool_id,
  capacity_pool_scope,
  capacity_pool_revision,
  capacity_source_id,
  capacity_pool_candidate_id,
  placement_credential_source,
  placement_credential_reference,
  placement_credential_version,
  capacity_pool_project_id,
  workload_role,
  provider_instance_type,
  provider_instance_vcpu_count,
  provider_instance_memory_mb,
  provider_instance_disk_gb,
  provider_instance_price_display,
  provider_instance_price_currency,
  provider_instance_price_monthly_cents,
  provider_instance_price_hourly_micros,
  placement_explanation_json
`;

export const CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS = `?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`;

export const CAPACITY_PLACEMENT_SNAPSHOT_SQL_ASSIGNMENTS = `
  capacity_pool_id = ?,
  capacity_pool_scope = ?,
  capacity_pool_revision = ?,
  capacity_source_id = ?,
  capacity_pool_candidate_id = ?,
  placement_credential_source = ?,
  placement_credential_reference = ?,
  placement_credential_version = ?,
  capacity_pool_project_id = ?,
  workload_role = ?,
  provider_instance_type = ?,
  provider_instance_vcpu_count = ?,
  provider_instance_memory_mb = ?,
  provider_instance_disk_gb = ?,
  provider_instance_price_display = ?,
  provider_instance_price_currency = ?,
  provider_instance_price_monthly_cents = ?,
  provider_instance_price_hourly_micros = ?,
  placement_explanation_json = ?
`;

export function capacityPlacementSnapshotSqlValues(
  snapshot: CapacityPlacementSnapshot | null | undefined
): Array<string | number | null> {
  return [
    snapshot?.capacityPoolId ?? null,
    snapshot?.capacityPoolScope ?? null,
    snapshot?.capacityPoolRevision ?? null,
    snapshot?.capacitySourceId ?? null,
    snapshot?.capacityPoolCandidateId ?? null,
    snapshot?.placementCredentialSource ?? null,
    snapshot?.placementCredentialReference ?? null,
    snapshot?.placementCredentialVersion ?? null,
    snapshot?.capacityPoolProjectId ?? null,
    snapshot?.workloadRole ?? null,
    snapshot?.providerInstanceType ?? null,
    snapshot?.providerInstanceVcpuCount ?? null,
    snapshot?.providerInstanceMemoryMb ?? null,
    snapshot?.providerInstanceDiskGb ?? null,
    snapshot?.providerInstancePriceDisplay ?? null,
    snapshot?.providerInstancePriceCurrency ?? null,
    snapshot?.providerInstancePriceMonthlyCents ?? null,
    snapshot?.providerInstancePriceHourlyMicros ?? null,
    snapshot?.placementExplanationJson ?? null,
  ];
}

export function capacityPlacementSnapshotDbValues(
  snapshot: CapacityPlacementSnapshot | null | undefined
): {
  capacityPoolId: string | null;
  capacityPoolScope: string | null;
  capacityPoolRevision: number | null;
  capacitySourceId: string | null;
  capacityPoolCandidateId: string | null;
  placementCredentialSource: string | null;
  placementCredentialReference: string | null;
  placementCredentialVersion: number | null;
  capacityPoolProjectId: string | null;
  workloadRole: string | null;
  providerInstanceType: string | null;
  providerInstanceVcpuCount: number | null;
  providerInstanceMemoryMb: number | null;
  providerInstanceDiskGb: number | null;
  providerInstancePriceDisplay: string | null;
  providerInstancePriceCurrency: string | null;
  providerInstancePriceMonthlyCents: number | null;
  providerInstancePriceHourlyMicros: number | null;
  placementExplanationJson: string | null;
} {
  return {
    capacityPoolId: snapshot?.capacityPoolId ?? null,
    capacityPoolScope: snapshot?.capacityPoolScope ?? null,
    capacityPoolRevision: snapshot?.capacityPoolRevision ?? null,
    capacitySourceId: snapshot?.capacitySourceId ?? null,
    capacityPoolCandidateId: snapshot?.capacityPoolCandidateId ?? null,
    placementCredentialSource: snapshot?.placementCredentialSource ?? null,
    placementCredentialReference: snapshot?.placementCredentialReference ?? null,
    placementCredentialVersion: snapshot?.placementCredentialVersion ?? null,
    capacityPoolProjectId: snapshot?.capacityPoolProjectId ?? null,
    workloadRole: snapshot?.workloadRole ?? null,
    providerInstanceType: snapshot?.providerInstanceType ?? null,
    providerInstanceVcpuCount: snapshot?.providerInstanceVcpuCount ?? null,
    providerInstanceMemoryMb: snapshot?.providerInstanceMemoryMb ?? null,
    providerInstanceDiskGb: snapshot?.providerInstanceDiskGb ?? null,
    providerInstancePriceDisplay: snapshot?.providerInstancePriceDisplay ?? null,
    providerInstancePriceCurrency: snapshot?.providerInstancePriceCurrency ?? null,
    providerInstancePriceMonthlyCents: snapshot?.providerInstancePriceMonthlyCents ?? null,
    providerInstancePriceHourlyMicros: snapshot?.providerInstancePriceHourlyMicros ?? null,
    placementExplanationJson: snapshot?.placementExplanationJson ?? null,
  };
}
