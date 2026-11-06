/**
 * Small, best-effort reads that give a SAM notice a human label. A notice is display data,
 * so a failed lookup returns null and the message is delivered without the label.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';

/** One D1 read: the task's title, scoped to its project. */
export async function loadTaskTitleForNotice(
  env: Pick<Env, 'DATABASE'>,
  projectId: string,
  taskId: string | null | undefined
): Promise<string | null> {
  if (!taskId) return null;
  try {
    const row = await env.DATABASE.prepare(
      'SELECT title FROM tasks WHERE id = ? AND project_id = ?'
    )
      .bind(taskId, projectId)
      .first<{ title: unknown }>();
    return typeof row?.title === 'string' && row.title.trim() ? row.title : null;
  } catch (error) {
    log.warn('sam_notice.task_title_lookup_failed', {
      projectId,
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
