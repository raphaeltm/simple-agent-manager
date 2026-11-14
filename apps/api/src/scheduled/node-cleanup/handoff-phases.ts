/**
 * Cleanup phases for managed nodes the NodeLifecycle DO handed off (`stopped`) or that a teardown
 * left `destroying`, plus the confirm phase of two-phase provider deletion. Split from
 * `node-phases.ts`; see that file for the role/class gates every destroy query carries.
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { preservedVmRetirementActivitySql } from '../../services/preserved-vm-retirement';
import {
  boundedWarmPlacementClaimGuardSql,
  type CleanupConfig,
  type CleanupDb,
  cleanupNodeProvenanceSql,
  destroyNodeForCleanup,
  getNodeWorkspaceIdleThresholdIso,
  minimumTeardownAttemptMs,
  type NodeCleanupDestroyResult,
  type NodeCleanupResult,
} from './shared';

type HandoffCleanupStatus = 'stopped' | 'destroying';

interface HandoffCleanupOptions {
  status: HandoffCleanupStatus;
  skippedActiveLogEvent: string;
  logEvent: string;
  failureLogEvent: string;
  successMessage: string;
  failureMessagePrefix: string;
  recoveryType: string;
  failureRecoveryType: string;
}

async function sweepManagedHandoffNodes(
  db: CleanupDb,
  env: Env,
  now: Date,
  config: CleanupConfig,
  result: NodeCleanupResult,
  options: HandoffCleanupOptions
): Promise<void> {
  const sweepDeadlineMs = Date.now() + config.stoppedHandoffSweepBudgetMs;
  const workspaceIdleThreshold = getNodeWorkspaceIdleThresholdIso(now, config);
  const preservedVmBudget = { remainingSources: config.workspaceSweepLimit };
  const activitySql = `COALESCE(MAX(${preservedVmRetirementActivitySql('w')}), n.created_at)`;
  const candidates = await env.DATABASE.prepare(
    `SELECT n.id, n.user_id, n.status, n.created_at, n.cleanup_blocked_since,
            COUNT(DISTINCT CASE WHEN w.status IN ('running', 'creating', 'recovery') THEN w.id END) as active_ws_count,
            ${activitySql} as last_activity
     FROM nodes n
     LEFT JOIN workspaces w ON w.node_id = n.id
     WHERE n.status = ?
       AND n.node_role = 'workspace'
       AND n.node_class != 'user-owned'
       AND ${cleanupNodeProvenanceSql('n')}
       AND (n.cleanup_backoff_until IS NULL OR n.cleanup_backoff_until <= ?)
       -- A started provider deletion belongs to the confirm phase until it is proven or void.
       AND n.provider_deletion_requested_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM workspaces active_workspace
         WHERE active_workspace.node_id = n.id
           AND active_workspace.status IN ('running', 'creating', 'recovery')
       )
       ${boundedWarmPlacementClaimGuardSql('n.id')}
     GROUP BY n.id, n.user_id, n.status, n.created_at
     HAVING ${activitySql} < ?
     -- Round robin: never-attempted candidates first, then the one whose last retry fell due
     -- earliest. A failed attempt pushes its own backoff forward, so a page of candidates that
     -- keep failing (or keep using the whole budget) cannot hold the head of every tick.
     ORDER BY n.cleanup_backoff_until IS NOT NULL, n.cleanup_backoff_until ASC, last_activity ASC
     LIMIT ?`
  )
    .bind(
      options.status,
      now.toISOString(),
      workspaceIdleThreshold,
      workspaceIdleThreshold,
      config.nodeSweepLimit
    )
    .all<{
      id: string;
      user_id: string;
      status: string;
      created_at: string;
      active_ws_count: number;
      last_activity: string;
    }>();

  for (const node of candidates.results) {
    if (
      sweepDeadlineMs - Date.now() < minimumTeardownAttemptMs(config) ||
      preservedVmBudget.remainingSources <= 0
    )
      break;
    if (node.active_ws_count > 0) {
      log.warn(options.skippedActiveLogEvent, {
        nodeId: node.id,
        userId: node.user_id,
        activeWorkspaces: node.active_ws_count,
        lastWorkspaceActivity: node.last_activity,
      });
      result.lifetimeSkipped++;
      continue;
    }

    const destroyed = await destroyNodeForCleanup(db, env, now.toISOString(), node, {
      preservedVmBudget,
      blockedRetirementMs: config.blockedRetirementMs,
      refusalWarnAfterMs: config.refusalWarnAfterMs,
      logEvent: options.logEvent,
      requestDeadlineMs: Math.min(
        sweepDeadlineMs,
        Date.now() + config.providerDeletionRequestTimeoutMs
      ),
      providerDeletion: 'request',
      providerDeletionConfirmMaxMs: config.providerDeletionConfirmMaxMs,
      failureLogEvent: options.failureLogEvent,
      successMessage: options.successMessage,
      failureMessagePrefix: options.failureMessagePrefix,
      recoveryType: options.recoveryType,
      failureRecoveryType: options.failureRecoveryType,
      failureBackoffMs: config.failureBackoffMs,
      workspaceIdleThresholdIso: workspaceIdleThreshold,
      context: {
        createdAt: node.created_at,
        lastWorkspaceActivity: node.last_activity,
        workspaceIdleTimeoutMs: config.workspaceIdleTimeoutMs,
      },
    });

    countHandoffOutcome(destroyed, result);
  }
}

function countHandoffOutcome(destroyed: NodeCleanupDestroyResult, result: NodeCleanupResult) {
  if (destroyed === 'destroyed') result.lifetimeDestroyed++;
  else if (destroyed === 'skipped') result.lifetimeSkipped++;
  else if (destroyed === 'pending') result.providerDeletionsRequested++;
  else result.errors++;
}

/**
 * Phase 0 — provider deletions an earlier tick started without waiting for (two-phase teardown).
 *
 * Reads the provider's own record of each deletion (`services/node-provider-deletion.ts`) and
 * writes termination proof only when it shows this exact instance deleted. A deletion still
 * running stays pending; one the provider never received or that failed has its record cleared
 * and returns to the ordinary guarded phases; one unconfirmed past
 * `operations.nodeProviderDeletionConfirmMaxMs` becomes `teardown_deletion_unconfirmed` (named,
 * alerted, one-hour failure backoff), so it leaves the hot set.
 *
 * Bounds: at most `nodeSweepLimit` candidates and `stoppedHandoffSweepBudgetMs` wall time per
 * tick; each attempt is one provider auth plus one operations read (GCP ~0.2 s + ~0.2 s), the
 * proof write, DNS cleanup and the workspace finalizer.
 */
export async function sweepProviderDeletionConfirmations(
  db: CleanupDb,
  env: Env,
  now: Date,
  config: CleanupConfig,
  result: NodeCleanupResult
): Promise<void> {
  const sweepDeadlineMs = Date.now() + config.stoppedHandoffSweepBudgetMs;
  const candidates = await env.DATABASE.prepare(
    `SELECT n.id, n.user_id, n.status, n.created_at, n.cleanup_blocked_since,
            n.provider_deletion_requested_at
     FROM nodes n
     WHERE n.provider_deletion_requested_at IS NOT NULL
       AND n.status = 'destroying'
       AND n.node_role = 'workspace'
       AND n.node_class != 'user-owned'
       AND n.runtime = 'vm'
       AND n.runtime_termination_confirmed_at IS NULL
       AND (n.cleanup_backoff_until IS NULL OR n.cleanup_backoff_until <= ?)
     ORDER BY n.cleanup_backoff_until IS NOT NULL, n.cleanup_backoff_until ASC,
       n.provider_deletion_requested_at ASC
     LIMIT ?`
  )
    .bind(now.toISOString(), config.nodeSweepLimit)
    .all<{
      id: string;
      user_id: string;
      status: string;
      created_at: string;
      cleanup_blocked_since: string | null;
      provider_deletion_requested_at: string;
    }>();

  for (const node of candidates.results) {
    if (sweepDeadlineMs - Date.now() < minimumTeardownAttemptMs(config)) break;
    const destroyed = await destroyNodeForCleanup(db, env, now.toISOString(), node, {
      confirmPendingDeletion: true,
      providerDeletion: 'request',
      providerDeletionConfirmMaxMs: config.providerDeletionConfirmMaxMs,
      requestDeadlineMs: Math.min(
        sweepDeadlineMs,
        Date.now() + config.providerDeletionRequestTimeoutMs
      ),
      blockedRetirementMs: config.blockedRetirementMs,
      refusalWarnAfterMs: config.refusalWarnAfterMs,
      logEvent: 'node_cleanup.confirming_provider_deletion',
      failureLogEvent: 'node_cleanup.provider_deletion_confirm_failed',
      successMessage: 'Destroyed managed node after its provider deletion was confirmed',
      failureMessagePrefix: 'Failed to confirm provider deletion',
      recoveryType: 'provider_deletion_confirm',
      failureRecoveryType: 'provider_deletion_confirm_failure',
      failureBackoffMs: config.failureBackoffMs,
      requireWorkspaceIdle: false,
      context: {
        createdAt: node.created_at,
        providerDeletionRequestedAt: node.provider_deletion_requested_at,
      },
    });
    if (destroyed === 'destroyed') result.lifetimeDestroyed++;
    else if (destroyed === 'pending') result.providerDeletionsPending++;
    else if (destroyed === 'skipped') result.lifetimeSkipped++;
    else result.errors++;
  }
}

/**
 * Phase 3 — nodes the NodeLifecycle DO alarm stopped but never destroyed.
 *
 * The DO cannot destroy cloud infrastructure (credentials are encrypted in D1 and
 * need worker context), so it hands off by writing `status='stopped'`.
 */
export async function sweepStoppedHandoffNodes(
  db: CleanupDb,
  env: Env,
  now: Date,
  config: CleanupConfig,
  result: NodeCleanupResult
): Promise<void> {
  await sweepManagedHandoffNodes(db, env, now, config, result, {
    status: 'stopped',
    skippedActiveLogEvent: 'node_cleanup.stopped_handoff_skipped_active_workspaces',
    logEvent: 'node_cleanup.destroying_stopped_handoff',
    failureLogEvent: 'node_cleanup.stopped_handoff_destroy_failed',
    successMessage: 'Destroyed stopped managed node left by NodeLifecycle alarm',
    failureMessagePrefix: 'Failed to destroy stopped handoff node',
    recoveryType: 'stopped_node_handoff_cleanup',
    failureRecoveryType: 'stopped_node_handoff_cleanup_failure',
  });
}

/**
 * Phase 3b — stale nodes already claimed for destruction.
 *
 * A provider allocation can fail after SAM has claimed the node as `destroying`
 * but before any provider instance ID is written. In that state there is no
 * provider-side VM to delete, and the hourly sweep must be able to write the
 * same terminal runtime proof the rest of cleanup requires.
 */
export async function sweepDestroyingHandoffNodes(
  db: CleanupDb,
  env: Env,
  now: Date,
  config: CleanupConfig,
  result: NodeCleanupResult
): Promise<void> {
  await sweepManagedHandoffNodes(db, env, now, config, result, {
    status: 'destroying',
    skippedActiveLogEvent: 'node_cleanup.destroying_handoff_skipped_active_workspaces',
    logEvent: 'node_cleanup.destroying_stale_handoff',
    failureLogEvent: 'node_cleanup.destroying_handoff_destroy_failed',
    successMessage: 'Destroyed managed node left in destroying handoff',
    failureMessagePrefix: 'Failed to destroy stale destroying handoff node',
    recoveryType: 'destroying_node_handoff_cleanup',
    failureRecoveryType: 'destroying_node_handoff_cleanup_failure',
  });
}
