/**
 * Server-written proof that SAM owns a managed node and can finish tearing it down.
 *
 * A node qualifies through either:
 * - a task that auto-provisioned it (`tasks.auto_provisioned_node_id`), or
 * - its own server-written pool/credential snapshot. Direct and pool-placed provisioning has
 *   no task link, and a woken conversation clears the one it had, so the snapshot is the
 *   durable proof. It is independent of current pool revisions so retiring a source cannot
 *   strand a VM provisioned under its old authority. Providerless destroying rows
 *   need strict inventory reconciliation to establish absence; requiring absence
 *   proof here would prevent that reconciliation.
 *
 * `capacity_source_id` is the one snapshot column a later, unrelated write can clear: it is
 * `ON DELETE SET NULL` to `capacity_sources`, whose `credential_id` cascades from `credentials`.
 * Deleting a cloud credential (a disconnect, a platform credential rotation) deletes its source,
 * cascades the source's pool candidates, and releases the column on every node placed from it.
 * A released column is accepted only in that exact shape: the column is NULL AND the candidate
 * the node names no longer exists, which is what the cascade leaves and nothing else does
 * (no code deletes a candidate row; only the source cascade does). Every other server-written
 * snapshot field is still required, so the release grants no admission a placed node lacked.
 *
 * The snapshot branch admits `stopped` and `destroying` nodes (the NodeLifecycle and cleanup
 * handoffs), plus `running` nodes only when the caller opts in. Only a node this predicate
 * admits may be handed to NodeLifecycle: once its warm timer moves it to `stopped`, the cleanup
 * sweep can destroy only nodes that pass it.
 */
export function cleanupNodeProvenanceSql(
  alias: 'n' | 'nodes',
  allowManagedRunningProvenance = false
): string {
  const managedPoolStatuses = allowManagedRunningProvenance
    ? "'stopped', 'running', 'destroying'"
    : "'stopped', 'destroying'";
  const present = [
    'capacity_pool_id',
    'capacity_pool_candidate_id',
    'placement_credential_reference',
    'placement_credential_fingerprint',
    'cloud_provider',
    'provider_instance_type',
  ]
    .map((column) => `NULLIF(TRIM(${alias}.${column}), '') IS NOT NULL`)
    .join('\n         AND ');
  return `(EXISTS (
    SELECT 1 FROM tasks auto_task
    WHERE auto_task.auto_provisioned_node_id = ${alias}.id
  ) OR (
    ${alias}.status IN (${managedPoolStatuses})
    AND ${alias}.node_class = 'managed'
    AND ${alias}.runtime = 'vm'
    AND ${alias}.workload_role = 'workspace'
    AND ${alias}.capacity_pool_scope IN ('user', 'project', 'installation')
    AND (${alias}.capacity_pool_scope != 'project'
      OR NULLIF(TRIM(${alias}.capacity_pool_project_id), '') IS NOT NULL)
    AND (${alias}.capacity_pool_scope = 'project' OR ${alias}.capacity_pool_project_id IS NULL)
    AND ${alias}.capacity_pool_revision > 0
    AND ${alias}.capacity_source_generation > 0
    AND ${alias}.placement_credential_source IN ('user', 'project', 'platform')
    AND ${alias}.placement_credential_version > 0
    AND (${alias}.provider_instance_id IS NOT NULL
      OR (${alias}.status = 'destroying'
        AND (${alias}.runtime_termination_confirmed_at IS NOT NULL
          OR NULLIF(TRIM(${alias}.runtime_incarnation_id), '') IS NOT NULL)))
    AND ${alias}.provider_instance_vcpu_count > 0
    AND ${alias}.provider_instance_memory_mb > 0
    AND ${present}
    AND (NULLIF(TRIM(${alias}.capacity_source_id), '') IS NOT NULL
      OR ${capacitySourceReleasedSql(alias)})
  ))`;
}

/**
 * The exact shape the `capacity_sources` cascade leaves on a placed node: the column is NULL and
 * the pool candidate it was placed from is gone with its source. A NULL column whose candidate
 * still exists was not released by that cascade, so it is not this shape.
 */
export function capacitySourceReleasedSql(alias: string): string {
  return `(${alias}.capacity_source_id IS NULL
      AND NULLIF(TRIM(${alias}.capacity_pool_candidate_id), '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM capacity_pool_candidates released_candidate
        WHERE released_candidate.id = ${alias}.capacity_pool_candidate_id
      ))`;
}

/** `capacitySourceReleasedSql` for one node, for callers that hold the row in code. */
export async function isNodeCapacitySourceReleased(
  database: D1Database,
  node: { id: string; capacitySourceId: string | null; capacityPoolCandidateId: string | null }
): Promise<boolean> {
  if (node.capacitySourceId !== null || !node.capacityPoolCandidateId?.trim()) return false;
  const row = await database
    .prepare(
      `SELECT ${capacitySourceReleasedSql('n')} AS released
       FROM nodes n
       WHERE n.id = ? AND n.capacity_pool_candidate_id IS ?`
    )
    .bind(node.id, node.capacityPoolCandidateId)
    .first<{ released: number }>();
  return row?.released === 1;
}
