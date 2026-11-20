/**
 * A managed VM node row whose provider create was never requested.
 *
 * `createNodeRecord` (`services/nodes.ts`) inserts every VM row with an initial absence proof:
 * `runtime_termination_confirmed_at = created_at`, `transport` NULL, no provider instance ID.
 * Before any provider create, `provisionNode` (`services/node-provisioning.ts`) runs its provider
 * identity claim, a compare-and-set on the row's `creating` status and runtime incarnation that, in
 * the same write, clears that proof, rotates the incarnation and stamps `transport`. The resumed
 * durable-allocation path requires the proof to be NULL already. So while a row still carries the
 * insert-time proof (equal to `created_at`) and a NULL `transport`, no create was ever sent for it:
 * nothing exists at the provider and teardown needs no provider call.
 *
 * Every later proof writer stamps its own, later time (`markRuntimeTerminationConfirmed`,
 * `recordRejectedAllocationAbsence`, the provisioning-failure rejection proof, the operator
 * attestation), so a row that was ever claimed cannot return to this shape. Owner-attested proofs
 * (`runtime_termination_attested_at`) and started provider deletions are excluded outright.
 *
 * The status set excludes `creating` and `running`: a row still `creating` may be about to run its
 * claim, and is reaped through its task link instead (`taskProvisionedNodeConditionSql`).
 *
 * Production rows in this shape (2026-11-15: `Node allocation plan is no longer current` thrown by
 * `assertNodeAllocationPlanCurrent` before the claim) had no placement credential fingerprint, so
 * strict teardown's managed-placement gate refused them on every sweep, forever
 * (idea 01M7GVRC956Q8JMGCRP1PQ4R5B). Prior art: `cleanupFreshProvisioningNode`
 * (`services/provisioning-authority.ts`) already deletes such a placeholder on the absence proof.
 */
import type * as schema from '../db/schema';

export const NEVER_REQUESTED_PLACEHOLDER_STATUSES = ['error', 'stopped', 'destroying'] as const;

const SAFE_ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function neverRequestedVmPlaceholderSql(alias: string): string {
  if (!SAFE_ALIAS.test(alias)) throw new Error('Unsafe SQL alias');
  return `(${alias}.status IN (${NEVER_REQUESTED_PLACEHOLDER_STATUSES.map((s) => `'${s}'`).join(', ')})
    AND ${alias}.node_class = 'managed'
    AND ${alias}.runtime = 'vm'
    AND ${alias}.node_role = 'workspace'
    AND ${alias}.provider_instance_id IS NULL
    AND ${alias}.transport IS NULL
    AND ${alias}.provider_deletion_requested_at IS NULL
    AND ${alias}.runtime_termination_attested_at IS NULL
    AND ${alias}.runtime_termination_confirmed_at IS NOT NULL
    AND ${alias}.runtime_termination_confirmed_at = ${alias}.created_at)`;
}

type PlaceholderFields = Pick<
  typeof schema.nodes.$inferSelect,
  | 'nodeClass'
  | 'runtime'
  | 'nodeRole'
  | 'providerInstanceId'
  | 'transport'
  | 'providerDeletionRequestedAt'
  | 'runtimeTerminationAttestedAt'
  | 'runtimeTerminationConfirmedAt'
  | 'createdAt'
>;

/**
 * Code twin of `neverRequestedVmPlaceholderSql` without the status set: strict teardown checks the
 * row it already claimed (`destroying`), whose pre-claim status the SQL form admitted.
 */
export function isNeverRequestedVmPlaceholder(node: PlaceholderFields): boolean {
  return (
    node.nodeClass === 'managed' &&
    node.runtime === 'vm' &&
    node.nodeRole === 'workspace' &&
    node.providerInstanceId === null &&
    node.transport === null &&
    node.providerDeletionRequestedAt === null &&
    node.runtimeTerminationAttestedAt === null &&
    node.runtimeTerminationConfirmedAt !== null &&
    node.runtimeTerminationConfirmedAt === node.createdAt
  );
}
