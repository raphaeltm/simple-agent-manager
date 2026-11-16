/**
 * When a member leaves a project, their open human tasks move to the team (inbox slice H1, design
 * idea 01M6MFVAJF20DZK8NJ97VAXC7A "the assignee leaves the project"), and a team task they had
 * taken is released for someone else to take. Each moved task gets a `reassigned` lifecycle row
 * and a `sam.inbox` event from SAM, so the agent that assigned it is told.
 *
 * Called after the member's status is `removed` (`routes/projects/member-offboarding.ts`), next to
 * `revokeSessionAccessForDepartedMember`. Best-effort: a failure is logged, the removal stands, and
 * the departed member can no longer read or act on the task anyway (every task read joins an
 * active membership).
 */
import { INBOX_SETTINGS } from '@simple-agent-manager/operations';
import { ulid } from '@simple-agent-manager/worker-core';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { createInboxTaskPort } from './task-port';

/** Unused for an open task (its watches never expire); required by the event input. */
const CLOSED_WATCH_HOURS_DEFAULT =
  INBOX_SETTINGS.find((setting) => setting.name === 'inbox.closedTaskWatchHours')?.defaultValue ??
  168;

export async function moveDepartedMemberTasksToTeam(
  env: Env,
  projectId: string,
  userId: string
): Promise<number> {
  try {
    const now = Date.now();
    // One statement per shape. Each repeats the membership predicate, so a member who was
    // re-added in between keeps their tasks.
    const stillGone = `NOT EXISTS (SELECT 1 FROM project_members pm
      WHERE pm.project_id = asks.project_id AND pm.user_id = ? AND pm.status = 'active')`;
    const [assigned, claimed] = await env.DATABASE.batch([
      env.DATABASE.prepare(
        `UPDATE asks SET assignee_kind = 'team', assignee_user_id = NULL, claimed_by_user_id = NULL,
                updated_at = ?
          WHERE project_id = ? AND kind = 'task' AND status = 'open'
            AND assignee_kind = 'user' AND assignee_user_id = ? AND ${stillGone}
          RETURNING id`
      ).bind(now, projectId, userId, userId),
      env.DATABASE.prepare(
        `UPDATE asks SET claimed_by_user_id = NULL, updated_at = ?
          WHERE project_id = ? AND kind = 'task' AND status = 'open'
            AND assignee_kind = 'team' AND claimed_by_user_id = ? AND ${stillGone}
          RETURNING id`
      ).bind(now, projectId, userId, userId),
    ]);
    const moved = [
      ...((assigned?.results ?? []) as Array<{ id: string }>).map((row) => ({
        id: row.id,
        from: 'user',
      })),
      ...((claimed?.results ?? []) as Array<{ id: string }>).map((row) => ({
        id: row.id,
        from: 'claim',
      })),
    ];
    if (moved.length === 0) return 0;
    await env.DATABASE.batch(
      moved.map((task) =>
        env.DATABASE.prepare(
          `INSERT INTO ask_activity (id, ask_id, project_id, actor_kind, actor_id, kind,
             detail_json, created_at) VALUES (?, ?, ?, 'system', NULL, 'reassigned', ?, ?)`
        ).bind(
          ulid(),
          task.id,
          projectId,
          JSON.stringify({
            reason: 'member_left',
            fromKind: task.from === 'user' ? 'user' : 'team',
            fromUserId: userId,
            toKind: 'team',
            toUserId: null,
          }),
          now
        )
      )
    );
    const port = createInboxTaskPort(env);
    for (const task of moved) {
      await port.admitEvent({
        projectId,
        askId: task.id,
        eventType: 'inbox.task.reassigned',
        actor: { kind: 'system', id: null, name: 'SAM' },
        teammateInput: false,
        detail: { reason: 'member_left', toKind: 'team' },
        taskOpen: true,
        closedWatchHours: CLOSED_WATCH_HOURS_DEFAULT,
        // Three round trips per task here (watch renewal, intent insert and read); the outbox
        // reconcile sweep admits the intents, so a member with many tasks cannot exhaust the
        // offboarding request's subrequest budget.
        deferAdmission: true,
      });
    }
    log.info('inbox.departed_member_tasks_moved', { projectId, userId, tasks: moved.length });
    return moved.length;
  } catch (error) {
    log.error('inbox.departed_member_tasks_failed', {
      projectId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}
