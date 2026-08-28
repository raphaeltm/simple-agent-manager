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
  placement_explanation_json
`;

export const CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS = `?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`;

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
    placementExplanationJson: snapshot?.placementExplanationJson ?? null,
  };
}
