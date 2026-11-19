/**
 * Candidate selection for `sweepMaxLifetimeNodes` (`node-phases.ts`). Split out of
 * `node-phases.ts` (`.claude/rules/18-file-size-limits.md`).
 */
import type { Env } from '../../env';
import {
  boundedWarmPlacementClaimGuardSql,
  type CleanupConfig,
  LAST_WORKSPACE_ACTIVITY_SQL,
  sleepingContainerRetentionGuardSql,
} from './shared';

export interface MaxLifetimeCandidate {
  id: string;
  user_id: string;
  status: string;
  created_at: string;
  runtime_incarnation_id: string | null;
  active_ws_count: number;
  last_activity: string;
}

const ACTIVE_WORKSPACE_STATUSES_SQL = "'running', 'creating', 'recovery'";

/**
 * Nodes past the ordinary lifetime, empty ones first, in one bounded page; plus, in a second
 * bounded page, busy nodes past the absolute ceiling. The second page exists because refused
 * empty nodes return to the first page after their backoff: with at least `nodeSweepLimit` of
 * them a busy node past the ceiling would never be reached, and its sessions never slept
 * (policy a3780107). Each page costs one query per sweep tick and at most `nodeSweepLimit` rows.
 */
export async function selectMaxLifetimeCandidates(
  env: Env,
  now: Date,
  config: CleanupConfig,
  thresholds: { lifetimeThreshold: string; absoluteThreshold: string; idleThreshold: string }
): Promise<MaxLifetimeCandidate[]> {
  const page = (extraWhere: string, extraBinds: string[], orderBy: string) =>
    env.DATABASE.prepare(
      `SELECT n.id, n.user_id, n.status, n.created_at, n.runtime_incarnation_id,
              COUNT(DISTINCT CASE WHEN w.status IN (${ACTIVE_WORKSPACE_STATUSES_SQL}) THEN w.id END) as active_ws_count,
              ${LAST_WORKSPACE_ACTIVITY_SQL} as last_activity
       FROM nodes n
       LEFT JOIN workspaces w ON w.node_id = n.id
       WHERE n.status NOT IN ('stopped', 'destroying', 'deleted')
         AND n.node_role = 'workspace'
         AND n.node_class != 'user-owned'
         AND EXISTS (
           SELECT 1 FROM tasks t
           WHERE t.auto_provisioned_node_id = n.id
         )
         AND (n.cleanup_backoff_until IS NULL OR n.cleanup_backoff_until <= ?)
         ${boundedWarmPlacementClaimGuardSql('n.id')}
         ${sleepingContainerRetentionGuardSql('n')}
         AND n.created_at < ?
         ${extraWhere}
       GROUP BY n.id, n.user_id, n.status, n.created_at
       ORDER BY ${orderBy}
       LIMIT ?`
    )
      .bind(
        now.toISOString(),
        thresholds.idleThreshold,
        thresholds.lifetimeThreshold,
        ...extraBinds,
        config.nodeSweepLimit
      )
      .all<MaxLifetimeCandidate>();

  const ordinary = await page('', [], 'active_ws_count ASC, n.created_at ASC');
  const pastCeilingBusy = await page(
    `AND n.created_at < ?
         AND EXISTS (
           SELECT 1 FROM workspaces active_ws
           WHERE active_ws.node_id = n.id AND active_ws.status IN (${ACTIVE_WORKSPACE_STATUSES_SQL})
         )`,
    [thresholds.absoluteThreshold],
    'n.created_at ASC'
  );
  const seen = new Set<string>();
  return [...ordinary.results, ...pastCeilingBusy.results].filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}
