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
    'capacity_source_id',
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
  ))`;
}
