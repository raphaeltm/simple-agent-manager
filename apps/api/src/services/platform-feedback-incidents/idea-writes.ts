/**
 * Every write the incident pipeline makes to an idea it owns. Each one is a compare-and-set on
 * `tasks.updated_at = platform_feedback_triages.idea_owned_at` (see `idea-ownership.ts`), so a
 * person's or agent's edit made since the pipeline's last write is never overwritten, and each
 * one records the new `updated_at` it wrote, in the same D1 batch, so ownership survives it.
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { PIPELINE_IDEA_TRIGGERED_BY } from './idea-ownership';

const OWNED_IDEA_PREDICATE = `id = ? AND project_id = ? AND triggered_by = '${PIPELINE_IDEA_TRIGGERED_BY}'
  AND updated_at = (SELECT idea_owned_at FROM platform_feedback_triages
                    WHERE signature = ? AND idea_id = ? AND idea_owned_at IS NOT NULL)`;

export interface OwnedIdeaTarget {
  signature: string;
  ideaId: string;
  projectId: string;
}

/** A refused write is expected (someone engaged with the idea); it is logged so it is countable. */
function logOwnershipLost(write: 'update' | 'cancel', target: OwnedIdeaTarget) {
  log.info('platform_feedback_incident.idea_write_refused', {
    write,
    reason: 'not_owned_by_pipeline',
    ideaId: target.ideaId,
    projectId: target.projectId,
    signature: target.signature.slice(0, 16),
  });
}

function recordOwnership(env: Env, target: OwnedIdeaTarget, writtenAt: string) {
  // Runs after the task write in the same batch: it matches only when that write landed.
  return env.DATABASE.prepare(
    `UPDATE platform_feedback_triages SET idea_owned_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE signature = ? AND idea_id = ?
       AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND updated_at = ?)`
  ).bind(writtenAt, target.signature, target.ideaId, target.ideaId, writtenAt);
}

/**
 * Refreshes the title and body of an owned idea, reopening it if the pipeline itself cancelled
 * it (a recurring signature keeps one idea). Returns false when the pipeline no longer owns it.
 */
export async function updateOwnedIncidentIdea(
  env: Env,
  target: OwnedIdeaTarget,
  content: { title?: string; description: string },
  writtenAt: string
): Promise<boolean> {
  const before = await env.DATABASE.prepare(
    `SELECT status FROM tasks WHERE ${OWNED_IDEA_PREDICATE}`
  )
    .bind(target.ideaId, target.projectId, target.signature, target.ideaId)
    .first<{ status: string }>();
  if (!before || !['draft', 'cancelled'].includes(before.status)) {
    logOwnershipLost('update', target);
    return false;
  }
  const statements = [
    env.DATABASE.prepare(
      `UPDATE tasks SET title = COALESCE(?, title), description = ?, status = 'draft',
         updated_at = ?
       WHERE ${OWNED_IDEA_PREDICATE} AND status IN ('draft', 'cancelled')`
    ).bind(
      content.title ?? null,
      content.description,
      writtenAt,
      target.ideaId,
      target.projectId,
      target.signature,
      target.ideaId
    ),
    recordOwnership(env, target, writtenAt),
  ];
  if (before.status === 'cancelled') {
    statements.push(
      env.DATABASE.prepare(
        `INSERT INTO task_status_events (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
         SELECT ?, ?, 'cancelled', 'draft', 'system', NULL, ?, ?
         WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND updated_at = ?)`
      ).bind(
        ulid(),
        target.ideaId,
        'Incident signature recurred; reopened its idea',
        writtenAt,
        target.ideaId,
        writtenAt
      )
    );
  }
  const results = await env.DATABASE.batch(statements);
  const written = (results[0]?.meta.changes ?? 0) === 1;
  if (!written) logOwnershipLost('update', target);
  return written;
}

/**
 * Cancels an owned draft idea whose incident ended. Returns false when the pipeline no longer
 * owns it or it is not a draft.
 */
export async function cancelOwnedIncidentIdea(
  env: Env,
  target: OwnedIdeaTarget,
  reason: string,
  writtenAt: string
): Promise<boolean> {
  const results = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE tasks SET status = 'cancelled', updated_at = ?
       WHERE ${OWNED_IDEA_PREDICATE} AND status = 'draft'`
    ).bind(writtenAt, target.ideaId, target.projectId, target.signature, target.ideaId),
    recordOwnership(env, target, writtenAt),
    env.DATABASE.prepare(
      `INSERT INTO task_status_events (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
       SELECT ?, ?, 'draft', 'cancelled', 'system', NULL, ?, ?
       WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND updated_at = ? AND status = 'cancelled')`
    ).bind(ulid(), target.ideaId, reason, writtenAt, target.ideaId, writtenAt),
  ]);
  const written = (results[0]?.meta.changes ?? 0) === 1;
  if (!written) logOwnershipLost('cancel', target);
  return written;
}
