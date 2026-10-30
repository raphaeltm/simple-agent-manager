/** One diagnostic read after a failed claim; no provider/agent I/O. */
import {
  DEFAULT_CLEANUP_REFUSAL_WARN_AFTER_MS,
  DEFAULT_NODE_CLEANUP_BLOCKED_RETIREMENT_MS,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { cleanupNodeProvenanceSql } from '../../services/node-teardown-provenance';
import { workspaceArtifactsRetirementGuardSql } from '../../services/node-workspace-retirement-guard';
import {
  type PreservedVmRetirement,
  preservedVmRetirementActivitySql,
} from '../../services/preserved-vm-retirement';
import { boundedWarmPlacementClaimGuardSql } from '../../services/warm-placement-claims';

export {
  DEFAULT_CLEANUP_OWNERSHIP_ALERT_INTERVAL_MS,
  DEFAULT_CLEANUP_REFUSAL_WARN_AFTER_MS,
} from '@simple-agent-manager/shared';
export type CleanupRefusalNode = { id: string; user_id: string; status: string };
export interface CleanupRefusal {
  cleanup_blocked_since: string | null;
  cleanup_blocked_alerted_at: string | null;
  runtime_incarnation_id: string | null;
  provider_instance_id: string | null;
  cloud_provider: string | null;
  runtime: string;
  node_class: string;
  node_role: string;
  status: string;
  reasons: string[];
}

export async function diagnoseCleanupRefusal(
  env: Env,
  node: CleanupRefusalNode,
  nowIso: string,
  idleThreshold: string,
  options: {
    preservedVm?: PreservedVmRetirement;
    allowActiveWorkspaces?: boolean;
    allowManagedRunningProvenance?: boolean;
    requireWorkspaceIdle?: boolean;
  } = {}
): Promise<CleanupRefusal | null> {
  const row = await env.DATABASE.prepare(
    `SELECT n.*,
    EXISTS (SELECT 1 FROM workspaces w WHERE w.node_id=n.id
      AND w.status IN ('running','creating','recovery')) AS active_workspace,
    NOT (n.runtime_termination_confirmed_at IS NOT NULL OR (1=1 ${workspaceArtifactsRetirementGuardSql('n', false, !!options.preservedVm, 'workspace')})) AS unproven_workspace_deletion,
    NOT (n.runtime_termination_confirmed_at IS NOT NULL OR (1=1 ${workspaceArtifactsRetirementGuardSql('n', false, !!options.preservedVm, 'snapshot')})) AS unproven_snapshot_source,
    (n.runtime='cf-container' AND EXISTS (SELECT 1 FROM workspaces w
      WHERE w.node_id=n.id AND w.status='sleeping')) AS sleeping_container_retention,
    NOT (1=1 ${boundedWarmPlacementClaimGuardSql('n.id')}) AS warm_placement_claim,
    NOT (${cleanupNodeProvenanceSql('n', options.allowManagedRunningProvenance)}) AS provenance,
    COALESCE((SELECT MAX(${preservedVmRetirementActivitySql('w')})
      FROM workspaces w WHERE w.node_id=n.id), n.created_at) >= ? AS idle_window,
    n.cleanup_backoff_until > ? AS backoff
    FROM nodes n WHERE n.id=? AND n.user_id=?`
  )
    .bind(
      ...(options.preservedVm
        ? [options.preservedVm.sourcesJson, options.preservedVm.sourcesJson]
        : []),
      idleThreshold,
      idleThreshold,
      nowIso,
      node.id,
      node.user_id
    )
    .first<Omit<CleanupRefusal, 'reasons'> & Record<string, unknown>>();
  if (!row) return null;
  const reasons: string[] = [];
  for (const reason of [
    'active_workspace',
    'unproven_workspace_deletion',
    'unproven_snapshot_source',
  ])
    if (row[reason] && !(reason === 'active_workspace' && options.allowActiveWorkspaces))
      reasons.push(reason);
  for (const reason of [
    'sleeping_container_retention',
    'warm_placement_claim',
    'idle_window',
    'backoff',
    'provenance',
  ])
    if (row[reason] && !(reason === 'idle_window' && options.requireWorkspaceIdle === false))
      reasons.push(reason);
  if (row.status !== node.status || !reasons.length) reasons.push('lost_race');
  return { ...row, reasons };
}

export async function recordCleanupRefusal(
  env: Env,
  node: CleanupRefusalNode,
  nowIso: string,
  failureBackoffMs: number,
  refusal: CleanupRefusal,
  blockedRetirementMs = DEFAULT_NODE_CLEANUP_BLOCKED_RETIREMENT_MS,
  warnAfterMs = DEFAULT_CLEANUP_REFUSAL_WARN_AFTER_MS
): Promise<void> {
  const blockedSince = refusal.cleanup_blocked_since ?? nowIso;
  // The historical one-hour failure backoff must never postpone a 30-minute deadline.
  const backoff = new Date(
    Date.parse(nowIso) +
      Math.min(
        failureBackoffMs,
        warnAfterMs,
        Math.max(0, Date.parse(blockedSince) + blockedRetirementMs - Date.parse(nowIso))
      )
  ).toISOString();
  await env.DATABASE.prepare(
    `UPDATE nodes SET cleanup_blocked_since=COALESCE(cleanup_blocked_since, ?),
      cleanup_blocked_reason=?, cleanup_backoff_until=?
    WHERE id=? AND user_id=? AND status=? AND status IN ('stopped','destroying')`
  )
    .bind(nowIso, refusal.reasons.join(', '), backoff, node.id, node.user_id, node.status)
    .run();
  const context = {
    nodeId: node.id,
    userId: node.user_id,
    expectedStatus: node.status,
    blockedSince,
    reasons: refusal.reasons,
  };
  if (Date.parse(nowIso) - Date.parse(blockedSince) >= warnAfterMs)
    log.warn('node_cleanup.candidate_claim_refused', context);
  else log.info('node_cleanup.candidate_claim_refused', context);
}
