/**
 * The release step of provider-existence reconciliation (`deployment-node-provider-existence.ts`):
 * claim a node whose VM the provider has twice confirmed absent, then tear it down through the
 * ordinary deployment teardown, `cleanupDeploymentNode` -> `deleteNodeResourcesStrict`, which
 * deletes its app-route DNS records. Split from the sweep (file size limit).
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveCleanupConfig } from '../scheduled/node-cleanup/config';
import { cleanupDeploymentNode } from './deployment-node-cleanup';
import {
  type NodeLifecycleDecision,
  type NodeLifecycleDecisionDetail,
  recordNodeLifecycleDecision,
} from './node-lifecycle-decisions';
import { recordDeploymentEnvironmentLifecycleEventBestEffort } from './project-lifecycle-events';
import type { NodeRow } from './strict-node-deletion-shared';

/** Prefix of the node error message a release writes; operators and tests key on it. */
export const PROVIDER_INSTANCE_ABSENT_MESSAGE_PREFIX = 'Provider instance not found';
export const PROVIDER_EXISTENCE_RELEASE_SOURCE = 'deployment_node.provider_instance_absent';

/** The node is still this running managed deployment VM incarnation (`.claude/rules/51`). */
export function sameIncarnationSql(): string {
  return `node_role = 'deployment' AND node_class = 'managed' AND runtime = 'vm'
    AND status = 'running' AND provider_instance_id = ? AND runtime_incarnation_id IS ?`;
}

export async function recordExistenceDecision(
  env: Env,
  node: NodeRow,
  decision: NodeLifecycleDecision,
  reason: string,
  detail: NodeLifecycleDecisionDetail = {},
  dedupeWindowMs?: number
): Promise<void> {
  await recordNodeLifecycleDecision(env.DATABASE, {
    nodeId: node.id,
    source: 'provider_existence',
    decision,
    reason,
    detail: {
      provider: node.cloudProvider,
      providerInstanceId: node.providerInstanceId,
      ...detail,
    },
    dedupeWindowMs,
  });
}

/** A repeated deferral for the same reason is recorded at most once an hour. */
const DEFERRED_DECISION_DEDUPE_MS = 60 * 60 * 1000;

export type ReleaseOutcome = 'released' | 'release_failed' | 'deferred' | 'superseded';

/**
 * Claim a confirmed-absent node for teardown in one atomic batch:
 * 1. every environment on it moves to `stopping` (the state `cleanupDeploymentNode` requires),
 *    fenced on the node still being this running incarnation with this exact absence record, and
 *    on no environment already being started or stopped by another owner;
 * 2. the node moves to `destroying`, fenced the same way and on every environment carrying the
 *    stamp statement 1 wrote, so an environment another path is moving cannot be swept along.
 * Either both apply or neither does (statement 2's fence fails whenever statement 1 did not run).
 */
async function claimAbsentNodeRelease(
  env: Env,
  node: NodeRow,
  observedAt: string,
  stamp: string,
  message: string
): Promise<boolean> {
  const fence = `${sameIncarnationSql()} AND provider_absence_observed_at = ?
    AND provider_absence_instance_id = ?`;
  const fenceBinds = [
    node.providerInstanceId,
    node.runtimeIncarnationId,
    observedAt,
    node.providerInstanceId,
  ];
  const [, claimedNode] = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE deployment_environments SET status = 'stopping', updated_at = ?
       WHERE node_id = ? AND status != 'stopping'
         AND EXISTS (SELECT 1 FROM nodes WHERE id = ? AND ${fence})
         AND NOT EXISTS (SELECT 1 FROM deployment_environments busy
           WHERE busy.node_id = ? AND busy.status IN ('starting', 'stopping'))`
    ).bind(stamp, node.id, node.id, ...fenceBinds, node.id),
    env.DATABASE.prepare(
      `UPDATE nodes SET status = 'destroying', health_status = 'stale', error_message = ?,
         updated_at = ?
       WHERE id = ? AND ${fence}
         AND NOT EXISTS (SELECT 1 FROM deployment_environments de WHERE de.node_id = nodes.id
           AND (de.status != 'stopping' OR de.updated_at IS NOT ?))`
    ).bind(message, stamp, node.id, ...fenceBinds, stamp),
  ]);
  return (claimedNode?.meta.changes ?? 0) === 1;
}

export async function releaseConfirmedAbsentNode(
  env: Env,
  node: NodeRow,
  observedAt: string,
  confirmedAt: Date
): Promise<ReleaseOutcome> {
  const environments = await env.DATABASE.prepare(
    `SELECT id, project_id AS projectId, status FROM deployment_environments WHERE node_id = ?`
  )
    .bind(node.id)
    .all<{ id: string; projectId: string; status: string }>();
  const busy = environments.results.filter(
    (e) => e.status === 'starting' || e.status === 'stopping'
  );
  if (busy.length > 0) {
    // Another owner is starting or stopping an environment here; its own path tears the node
    // down. The absence record is kept, so this node is reconsidered next confirmation interval.
    // Recorded at most once an hour: a long stop would otherwise add a row every interval.
    await recordExistenceDecision(
      env,
      node,
      'provider_release_deferred',
      'lifecycle_in_progress',
      { environmentStatuses: busy.map((e) => e.status).join(',') },
      DEFERRED_DECISION_DEDUPE_MS
    );
    return 'deferred';
  }
  const stamp = confirmedAt.toISOString();
  const message =
    `${PROVIDER_INSTANCE_ABSENT_MESSAGE_PREFIX}: ${node.cloudProvider ?? 'provider'} instance ` +
    `${node.providerInstanceId} was not found at ${observedAt} or ${stamp}; released`;
  if (!(await claimAbsentNodeRelease(env, node, observedAt, stamp, message))) {
    await recordExistenceDecision(env, node, 'provider_release_deferred', 'superseded');
    return 'superseded';
  }
  // The claim is recorded now; the teardown records its own outcome (`deployment_teardown`
  // destroyed / destroy_failed in `cleanupDeploymentNode`).
  await recordExistenceDecision(
    env,
    node,
    'provider_instance_absent_confirmed',
    'teardown_claimed',
    { firstObservedAt: observedAt, confirmedAt: stamp }
  );
  log.warn('deployment_node_existence.teardown_claimed', {
    nodeId: node.id,
    provider: node.cloudProvider,
    providerInstanceId: node.providerInstanceId,
    firstObservedAt: observedAt,
    confirmedAt: stamp,
    environmentIds: environments.results.map((e) => e.id),
  });
  const config = resolveCleanupConfig(env);
  const cleanup = await cleanupDeploymentNode(env, node.id, node.userId, {
    retryAfterMs: config.failureBackoffMs,
    requestTimeoutMs: config.stoppedHandoffRequestTimeoutMs,
  });
  if (!cleanup.nodeDeleted) {
    // The node is `destroying`: the deployment-node cleanup sweep retries it, and the app-route
    // DNS sweep already judges its records released.
    log.warn('deployment_node_existence.teardown_pending', {
      nodeId: node.id,
      warnings: cleanup.warnings,
    });
    return 'release_failed';
  }
  log.warn('deployment_node_existence.released', {
    nodeId: node.id,
    provider: node.cloudProvider,
    providerInstanceId: node.providerInstanceId,
  });
  for (const environment of environments.results) {
    await recordDeploymentEnvironmentLifecycleEventBestEffort(env, {
      projectId: environment.projectId,
      environmentId: environment.id,
      lifecycle: 'stopped',
      status: 'stopped',
      fromStatus: environment.status,
      nodeId: node.id,
      userId: node.userId,
      source: PROVIDER_EXISTENCE_RELEASE_SOURCE,
      occurredAt: Date.now(),
    });
  }
  return 'released';
}
