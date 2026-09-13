import { chunkIdsForBindBudget } from './project-events-storage-helpers';

export type ProjectEventOrphanScanCursor = { lifecycleAt: number; matchId: string };

type Candidate = ProjectEventOrphanScanCursor & { batchId: string };

/** LIMIT applies to inspected matches, before testing whether their parent exists. */
function readCandidates(
  sql: SqlStorage,
  projectId: string,
  cursor: ProjectEventOrphanScanCursor | null,
  scanLimit: number
): Candidate[] {
  const whereClause = cursor ? ' AND (lifecycle_checked_at, id) > (?, ?)' : '';
  return sql
    .exec(
      `SELECT id, lifecycle_checked_at, batch_id FROM project_event_matches
     WHERE project_id = ? AND state = 'batch_created' AND batch_id IS NOT NULL${whereClause}
     ORDER BY lifecycle_checked_at ASC, id LIMIT ?`,
      projectId,
      ...(cursor ? [cursor.lifecycleAt, cursor.matchId] : []),
      scanLimit + 1
    )
    .toArray()
    .map((row) => ({
      matchId: String(row.id),
      lifecycleAt: Number(row.lifecycle_checked_at),
      batchId: String(row.batch_id),
    }));
}

/**
 * Healthy windows advance at ordinary maintenance cadence. `hasMore` means an
 * orphan was actually observed but could not fit the remaining mutation budget;
 * it does NOT assert that an uninspected suffix has no orphan. A complete sweep
 * wraps its cursor so a previously healthy parent disappearing is revisited.
 * The caller persists this cursor in its existing singleton scheduler write,
 * outside the shared business-row mutation budget. Healthy matches are untouched.
 */
export function repairProjectEventOrphanMatches(
  sql: SqlStorage,
  projectId: string,
  now: number,
  mutationBudget: number,
  scanLimit: number
): {
  mutated: number;
  count: number;
  hasMore: boolean;
  cursor: ProjectEventOrphanScanCursor | null;
} {
  const checkpoint = sql
    .exec(
      `SELECT orphan_scan_lifecycle_at, orphan_scan_match_id
     FROM project_event_wake_scheduler_state WHERE project_id = ?`,
      projectId
    )
    .toArray()[0];
  const previous =
    typeof checkpoint?.orphan_scan_lifecycle_at === 'number' &&
    typeof checkpoint.orphan_scan_match_id === 'string'
      ? {
          lifecycleAt: checkpoint.orphan_scan_lifecycle_at,
          matchId: checkpoint.orphan_scan_match_id,
        }
      : null;
  const candidates = readCandidates(sql, projectId, previous, scanLimit);
  const window = candidates.slice(0, scanLimit);
  const liveBatches = new Set<string>();
  for (const ids of chunkIdsForBindBudget([...new Set(window.map((row) => row.batchId))], 1)) {
    const placeholders = ids.map(() => '?').join(', ');
    for (const row of sql
      .exec(
        `SELECT id FROM project_event_delivery_batches
       WHERE project_id = ? AND id IN (${placeholders})`,
        projectId,
        ...ids
      )
      .toArray())
      liveBatches.add(String(row.id));
  }
  const repairIds: string[] = [];
  let cursor = previous;
  let hasMore = false;
  for (const candidate of window) {
    if (!liveBatches.has(candidate.batchId)) {
      if (repairIds.length >= mutationBudget) {
        hasMore = true;
        break; // Do not advance past the orphan that must be repaired next.
      }
      repairIds.push(candidate.matchId);
    }
    cursor = { lifecycleAt: candidate.lifecycleAt, matchId: candidate.matchId };
  }
  let mutated = 0;
  let repaired = 0;
  for (const ids of chunkIdsForBindBudget(repairIds, 5)) {
    const placeholders = ids.map(() => '?').join(', ');
    const result = sql.exec(
      `UPDATE project_event_matches SET state = 'expired',
       matched_at = CASE WHEN matched_at > ? THEN ? ELSE matched_at END,
       lifecycle_checked_at = ?, reason = ?
       WHERE project_id = ? AND id IN (${placeholders})
         AND state = 'batch_created' AND batch_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM project_event_delivery_batches b
           WHERE b.project_id = project_event_matches.project_id AND b.id = project_event_matches.batch_id)
       RETURNING id`,
      now,
      now,
      now,
      'retention_orphan_batch_repaired',
      projectId,
      ...ids
    );
    repaired += result.toArray().length;
    // workerd includes index writes in rowsWritten. Keep that conservative
    // shared mutation-budget accounting, but report actual repaired matches.
    mutated += result.rowsWritten;
  }
  return {
    mutated,
    count: repaired,
    hasMore,
    cursor: !hasMore && candidates.length <= scanLimit ? null : cursor,
  };
}
