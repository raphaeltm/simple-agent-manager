/** Automatic deadline authority waives artifact proof only; never ownership or active work. */
import type { Env } from '../env';
import { boundedWarmPlacementClaimGuardSql } from './warm-placement-claims';

export interface BoundedStrandedRetirement {
  readonly provenance: 'automatic_deadline_forced';
  readonly blockedSince: string;
  readonly providerInstanceId: string;
  readonly runtimeIncarnationId: string;
  beforeDestroy: () => Promise<void>;
}

export async function prepareBoundedStrandedRetirement(
  env: Env,
  nodeId: string,
  userId: string,
  nowIso: string,
  deadlineMs: number,
  idleThreshold: string
): Promise<BoundedStrandedRetirement | undefined> {
  const node = await env.DATABASE.prepare(
    `SELECT provider_instance_id, runtime_incarnation_id,
      cleanup_blocked_since FROM nodes
    WHERE id=? AND user_id=? AND status IN ('stopped','destroying')
      AND runtime='vm' AND node_class='managed' AND node_role='workspace'
      AND provider_instance_id IS NOT NULL AND runtime_incarnation_id IS NOT NULL
      AND placement_credential_source IN ('user','project','platform')
      AND NULLIF(placement_credential_reference,'') IS NOT NULL
      AND cleanup_blocked_since <= ?
      AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.node_id=nodes.id
        AND (w.status IN ('running','creating','recovery') OR w.user_id IS NOT nodes.user_id))
      AND NOT EXISTS (SELECT 1 FROM session_snapshots s WHERE s.node_id=nodes.id AND s.user_id IS NOT nodes.user_id)
      ${boundedWarmPlacementClaimGuardSql('nodes.id')}`
  )
    .bind(nodeId, userId, new Date(Date.parse(nowIso) - deadlineMs).toISOString(), idleThreshold)
    .first<{
      provider_instance_id: string;
      runtime_incarnation_id: string;
      cleanup_blocked_since: string;
    }>();
  if (!node) return undefined;
  return {
    provenance: 'automatic_deadline_forced',
    blockedSince: node.cleanup_blocked_since,
    providerInstanceId: node.provider_instance_id,
    runtimeIncarnationId: node.runtime_incarnation_id,
    async beforeDestroy() {
      const safe = await env.DATABASE.prepare(
        `SELECT id FROM nodes
        WHERE id=? AND user_id=? AND status='destroying'
          AND runtime='vm' AND node_class='managed' AND node_role='workspace'
          AND provider_instance_id IS ? AND runtime_incarnation_id IS ?
          AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.node_id=nodes.id
            AND (w.status IN ('running','creating','recovery') OR w.user_id IS NOT nodes.user_id))
          AND NOT EXISTS (SELECT 1 FROM session_snapshots s WHERE s.node_id=nodes.id AND s.user_id IS NOT nodes.user_id)
          ${boundedWarmPlacementClaimGuardSql('nodes.id')}`
      )
        .bind(nodeId, userId, node.provider_instance_id, node.runtime_incarnation_id, idleThreshold)
        .first();
      if (!safe)
        throw new Error('Bounded stranded retirement identity or active-workspace fence changed');
    },
  };
}
