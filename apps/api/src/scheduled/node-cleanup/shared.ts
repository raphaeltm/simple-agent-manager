/**
 * Shared types, config resolution, and destroy helpers for the node cleanup sweep.
 *
 * Rule 47 (control-loop I/O budget) applies to every phase in this directory:
 * - every candidate query is bounded by a configurable LIMIT
 * - VM-agent calls use the BACKGROUND timeout, never the interactive one
 * - every selected candidate has an escape path out of the candidate set
 *
 * Rule 51 (server-side node-class gates) applies to every destroy/flag query:
 * - `node_class != 'user-owned'` — SAM never touches a machine it does not own
 * - `node_role = 'workspace'`   — deployment nodes host live user applications and
 *   legitimately hold zero workspaces forever; reaping them destroys running apps
 */
import { DEFAULT_NODE_WORKSPACE_IDLE_TIMEOUT_MS } from '@simple-agent-manager/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import type { BoundedStrandedRetirement } from '../../services/bounded-stranded-retirement-authority';
import { deleteNodeResourcesStrict } from '../../services/nodes';
import {
  preparePreservedVmRetirement,
  type PreservedVmRetirement,
  type PreservedVmRetirementBudget,
} from '../../services/preserved-vm-retirement';
import { repairRetiredVmSleepSnapshots } from '../../services/retired-vm-sleep-repair';
import { finalizeWorkspaceLifecycleClosure } from '../../services/workspace-lifecycle-finalizer';
import { claimNodeForCleanup, claimPendingProviderDeletion } from './cleanup-claim';
import {
  type CleanupNode,
  type CleanupOutcomeOptions,
  errorMessage,
  handleCleanupFailure,
  persistCleanupSuccess,
  recordSweepDecision,
  refusalDecisionReason,
} from './cleanup-outcome';
import {
  diagnoseCleanupRefusal,
  handOffArtifactBlockedEmptyNode,
  recordCleanupRefusal,
} from './cleanup-refusal';
export { claimNodeForCleanup, sleepingContainerRetentionGuardSql } from './cleanup-claim';
import type { CleanupConfig } from './config';

export { cleanupNodeProvenanceSql } from '../../services/node-teardown-provenance';
export { boundedWarmPlacementClaimGuardSql } from '../../services/warm-placement-claims';
export { type CleanupConfig, parseMs, parsePositiveInt, resolveCleanupConfig } from './config';
export { emptyResult, type NodeCleanupResult } from './result';

export type CleanupDb = ReturnType<typeof drizzle<typeof schema>>;

export type { CleanupContext } from './cleanup-outcome';
/**
 * `pending`: a provider deletion was started (two-phase) or is still running. The node stays
 * `destroying` with its write-ahead record, and `sweepProviderDeletionConfirmations` writes the
 * termination proof on a later tick. Not a failure.
 */
export type NodeCleanupDestroyResult = 'destroyed' | 'skipped' | 'failed' | 'pending';

interface DestroyNodeForCleanupOptions extends CleanupOutcomeOptions {
  logEvent: string;
  preservedVmBudget?: PreservedVmRetirementBudget;
  boundedStrandedRetirement?: BoundedStrandedRetirement;
  allowActiveWorkspaces?: boolean;
  allowManagedRunningProvenance?: boolean;
  expectedLastHeartbeatAt?: string | null;
  requireWorkspaceIdle?: boolean;
  requestDeadlineMs?: number;
  /**
   * Start the provider deletion without waiting for it (two-phase). Only for callers that also
   * pass `requestDeadlineMs`; the confirm phase finishes the teardown on a later tick.
   */
  providerDeletion?: 'request';
  providerDeletionConfirmMaxMs?: number;
  /**
   * Confirm a deletion this node already started: claim it with the pending-deletion lease
   * instead of the ordinary cleanup claim (whose idle/artifact guards were met when it started).
   */
  confirmPendingDeletion?: boolean;
}

export function getNodeWorkspaceIdleThresholdIso(now: Date, config: CleanupConfig): string {
  return new Date(now.getTime() - config.workspaceIdleTimeoutMs).toISOString();
}

export async function markNodeCleanupBackoff(
  env: Env,
  nodeId: string,
  backoffUntil: string
): Promise<void> {
  try {
    await env.DATABASE.prepare(
      'UPDATE nodes SET cleanup_backoff_until = ?, updated_at = ? WHERE id = ?'
    )
      .bind(backoffUntil, new Date().toISOString(), nodeId)
      .run();
    log.warn('node_cleanup.candidate_backed_off', { nodeId, backoffUntil });
  } catch (err) {
    // Preserve the original cleanup error; a backoff-write failure is surfaced
    // separately and must not abort the remaining bounded candidate page.
    log.error('node_cleanup.candidate_backoff_failed', {
      nodeId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * SQL fragment computing a node's last workspace activity.
 *
 * MUST be used instead of `nodes.updated_at` for any idleness decision. Heartbeats
 * write `updated_at` on every beat (verified in production: `updated_at` is
 * byte-identical to `last_heartbeat_at` on every running node), so `updated_at`
 * measures liveness. A predicate like `updated_at < now - grace` is therefore
 * unsatisfiable for exactly the healthy-but-idle nodes it is meant to catch — the
 * bug that let orphan detection report zero hits for its entire lifetime.
 *
 * Falls back to `nodes.created_at` so a freshly provisioned node that has not yet
 * received its first workspace ages from creation rather than looking infinitely idle.
 *
 * Counts workspaces in ALL states, including `deleted`. Cleaning a workspace up is
 * itself recent activity on the node, so the clock legitimately restarts when the
 * stale-stopped-workspace phase deletes a row. That delays reaping by at most one
 * phase-6 window and cannot repeat, since a workspace is deleted only once.
 */
export const LAST_WORKSPACE_ACTIVITY_SQL = 'COALESCE(MAX(w.updated_at), n.created_at)';

export async function destroyNodeForCleanup(
  db: CleanupDb,
  env: Env,
  nowIso: string,
  node: CleanupNode,
  options: DestroyNodeForCleanupOptions
): Promise<NodeCleanupDestroyResult> {
  let preservedVm: PreservedVmRetirement | undefined;
  if (options.preservedVmBudget) {
    try {
      // Retry a repair interrupted after proof was persisted.
      await repairRetiredVmSleepSnapshots(env, node.id, node.user_id);
      preservedVm = await preparePreservedVmRetirement(
        env,
        node.id,
        node.user_id,
        options.preservedVmBudget
      );
    } catch (error) {
      log.warn('node_cleanup.preservation_check_failed', {
        nodeId: node.id,
        error: errorMessage(error),
      });
      await markNodeCleanupBackoff(
        env,
        node.id,
        new Date(Date.parse(nowIso) + options.failureBackoffMs).toISOString()
      );
      await recordSweepDecision(
        env,
        node,
        options,
        'destroy_failed',
        'preservation_check_failed',
        true
      );
      return 'failed';
    }
  }
  // A partially spent sweep budget is not a defect in this candidate. Keep it due
  // for the next tick rather than synchronizing its backoff with unsafe predecessors.
  if (options.preservedVmBudget?.exhausted) {
    await recordSweepDecision(env, node, options, 'skipped', 'preservation_budget_exhausted', true);
    return 'skipped';
  }
  if (options.confirmPendingDeletion) {
    const leaseUntil = new Date(
      Math.max(Date.parse(nowIso), options.requestDeadlineMs ?? Date.parse(nowIso))
    ).toISOString();
    if (!(await claimPendingProviderDeletion(env, node, nowIso, leaseUntil))) {
      await recordSweepDecision(
        env,
        node,
        options,
        'skipped',
        'pending_deletion_claim_refused',
        true
      );
      return 'skipped';
    }
    return await runStrictCleanup(db, env, nowIso, node, options, undefined);
  }
  const claimed = await claimNodeForCleanup(env, node, nowIso, {
    preservedVm,
    boundedStrandedRetirement: options.boundedStrandedRetirement,
    allowActiveWorkspaces: options.allowActiveWorkspaces,
    allowManagedRunningProvenance: options.allowManagedRunningProvenance,
    expectedLastHeartbeatAt: options.expectedLastHeartbeatAt,
    requireWorkspaceIdle: options.requireWorkspaceIdle,
    workspaceIdleThresholdIso: options.workspaceIdleThresholdIso,
  });
  if (!claimed) {
    const refusal = await diagnoseCleanupRefusal(
      env,
      node,
      nowIso,
      options.workspaceIdleThresholdIso ??
        getNodeWorkspaceIdleThresholdIso(new Date(nowIso), {
          workspaceIdleTimeoutMs: DEFAULT_NODE_WORKSPACE_IDLE_TIMEOUT_MS,
        } as CleanupConfig),
      {
        preservedVm,
        allowActiveWorkspaces: options.allowActiveWorkspaces,
        allowManagedRunningProvenance: options.allowManagedRunningProvenance,
        requireWorkspaceIdle: options.requireWorkspaceIdle,
      }
    );
    if (refusal) {
      await recordCleanupRefusal(
        env,
        node,
        nowIso,
        options.failureBackoffMs,
        refusal,
        options.blockedRetirementMs,
        options.refusalWarnAfterMs
      );
      await handOffArtifactBlockedEmptyNode(env, node, refusal);
    }
    await recordSweepDecision(
      env,
      node,
      options,
      'skipped',
      refusalDecisionReason(refusal?.reasons ?? []),
      true
    );
    return 'skipped';
  }
  return await runStrictCleanup(db, env, nowIso, node, options, preservedVm);
}

/** The strict teardown and its terminal bookkeeping, once the node is claimed. */
async function runStrictCleanup(
  db: CleanupDb,
  env: Env,
  nowIso: string,
  node: CleanupNode,
  options: DestroyNodeForCleanupOptions,
  preservedVm: PreservedVmRetirement | undefined
): Promise<NodeCleanupDestroyResult> {
  const controller = options.requestDeadlineMs === undefined ? undefined : new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (controller && options.requestDeadlineMs !== undefined) {
    timer = setTimeout(
      () => controller.abort(new Error('Stopped node cleanup request deadline exceeded')),
      Math.max(1, options.requestDeadlineMs - Date.now())
    );
  }
  try {
    log.info(options.logEvent, {
      nodeId: node.id,
      userId: node.user_id,
      ...options.context,
    });
    await recordSweepDecision(env, node, options, 'destroy_attempted', options.recoveryType);

    const strictDeletion = controller
      ? await deleteNodeResourcesStrict(node.id, node.user_id, env, {
          preservedVm,
          boundedStrandedRetirement: options.boundedStrandedRetirement,
          providerRequestContext: { signal: controller.signal },
          requestDeadlineMs: options.requestDeadlineMs,
          providerDeletion: options.providerDeletion,
          providerDeletionConfirmMaxMs: options.providerDeletionConfirmMaxMs,
        })
      : await deleteNodeResourcesStrict(
          node.id,
          node.user_id,
          env,
          ...(preservedVm || options.boundedStrandedRetirement
            ? [{ preservedVm, boundedStrandedRetirement: options.boundedStrandedRetirement }]
            : [])
        );
    if (strictDeletion.providerVm === 'deletion_pending') {
      return await recordProviderDeletionPending(env, node, options);
    }
    if (!strictDeletion.runtimeTerminationConfirmedAt) {
      throw new Error('Strict cleanup returned no managed-runtime termination proof');
    }

    // A confirmed two-phase deletion may have started under preserved-VM or stranded authority
    // on an earlier tick; the repair is idempotent, so run it for every confirmation too.
    if (
      options.preservedVmBudget ||
      options.boundedStrandedRetirement ||
      options.confirmPendingDeletion
    )
      await repairRetiredVmSleepSnapshots(env, node.id, node.user_id);

    const terminalNode = await db
      .update(schema.nodes)
      .set({
        status: 'deleted',
        warmSince: null,
        healthStatus: 'stale',
        cleanupBackoffUntil: null,
        cleanupBlockedSince: null,
        cleanupBlockedReason: null,
        updatedAt: nowIso,
      })
      .where(
        and(
          eq(schema.nodes.id, node.id),
          eq(schema.nodes.userId, node.user_id),
          sql`${schema.nodes.runtimeTerminationConfirmedAt} IS ${strictDeletion.runtimeTerminationConfirmedAt}`,
          sql`${schema.nodes.runtimeIncarnationId} IS ${strictDeletion.runtimeIncarnationId}`
        )
      )
      .run();
    if ((terminalNode.meta.changes ?? 0) !== 1) {
      throw new Error('Cleanup terminal write lost its exact node-incarnation proof');
    }

    const confirmedWorkspaces = await db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.nodeId, node.id),
          eq(schema.workspaces.userId, node.user_id),
          eq(
            schema.workspaces.runtimeDeletionConfirmedAt,
            strictDeletion.runtimeTerminationConfirmedAt
          )
        )
      );

    await finalizeWorkspaceLifecycleClosure(env, {
      workspaceIds: confirmedWorkspaces.map((workspace) => workspace.id),
      userId: node.user_id,
      agentSessionStatus: 'completed',
      nowIso,
      reason: 'node_cleanup_destroy_node_for_cleanup',
    });

    await persistCleanupSuccess(env, node, options);
    await recordSweepDecision(
      env,
      node,
      options,
      'destroyed',
      `provider_${strictDeletion.providerVm}`
    );

    return 'destroyed';
  } catch (error) {
    await handleCleanupFailure(env, node, nowIso, options, error);
    await recordSweepDecision(env, node, options, 'destroy_failed', errorMessage(error));
    return 'failed';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The provider deletion was started (or is still running). Keep the node `destroying` with its
 * write-ahead record and no backoff, so the confirm phase reads the provider's record next tick.
 * Nothing is persisted as an error: this is progress, not a failure.
 */
async function recordProviderDeletionPending(
  env: Env,
  node: CleanupNode,
  options: DestroyNodeForCleanupOptions
): Promise<NodeCleanupDestroyResult> {
  await env.DATABASE.prepare(
    `UPDATE nodes SET cleanup_backoff_until = NULL
     WHERE id = ? AND user_id = ? AND status = 'destroying'
       AND provider_deletion_requested_at IS NOT NULL`
  )
    .bind(node.id, node.user_id)
    .run();
  await recordSweepDecision(
    env,
    node,
    options,
    'destroy_pending',
    options.confirmPendingDeletion
      ? 'provider_deletion_in_progress'
      : 'provider_deletion_requested',
    options.confirmPendingDeletion === true
  );
  return 'pending';
}
