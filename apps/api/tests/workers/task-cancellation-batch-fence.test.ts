/** D1 batch changes() is the preceding CAS result, including Drizzle RETURNING. */
import { env } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import { setTaskStatus } from '../../src/routes/tasks/_helpers';
import {
  taskRecoveryCancellationQuery,
  taskRecoveryCancellationStatement,
} from '../../src/services/task-recovery-cancellation';
import {
  seedInstallation,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const now = '2026-11-17T12:00:00.000Z';
async function fixture(status: 'cancelled' | 'failed' | 'delegated') {
  const suffix = crypto.randomUUID();
  const userId = `batch-owner-${suffix}`;
  const projectId = `batch-project-${suffix}`;
  const taskId = `batch-task-${suffix}`;
  const workspaceId = `batch-ws-${suffix}`;
  await seedUser(userId);
  await seedInstallation(`batch-install-${suffix}`, userId);
  await seedProject(projectId, userId, `batch-install-${suffix}`);
  await seedWorkspace(workspaceId, null, userId, { projectId, status: 'deleted' });
  await seedTask(taskId, projectId, userId, { status, updatedAt: now });
  await env.DATABASE.prepare(
    `INSERT INTO session_snapshots
    (id,workspace_id,project_id,user_id,chat_session_id,runtime,status,degradation,
     manifest_r2_key,manifest_json,expires_at,sleeping_at,sleep_status,
     recovery_status,recovery_task_id,recovery_attempt_id,recovery_attempts)
    VALUES(?,?,?,?,?,'vm','available','none','saved/manifest','{}','2099-01-01T00:00:00Z',
     '2026-11-17T00:00:00Z','sleeping','waking',?,'old-attempt',1)`
  )
    .bind(
      `batch-snapshot-${suffix}`,
      workspaceId,
      projectId,
      userId,
      `batch-chat-${suffix}`,
      taskId
    )
    .run();
  return { id: taskId, projectId, userId };
}

describe('atomic task cancellation batch fence', () => {
  it.each(
    (['raw', 'drizzle'] as const).flatMap((writer) =>
      (['cancelled', 'failed'] as const).flatMap((status) =>
        [false, true].map((wins) => ({ writer, status, wins }))
      )
    )
  )(
    '$writer with $status verdict only revokes after the actual CAS wins ($wins)',
    async ({ writer, status, wins }) => {
      const task = await fixture(status);
      if (writer === 'raw') {
        const result = await env.DATABASE.batch([
          env.DATABASE.prepare(
            'UPDATE tasks SET updated_at=? WHERE id=? AND project_id=? AND status=?'
          ).bind(now, task.id, task.projectId, wins ? status : 'queued'),
          taskRecoveryCancellationStatement(env.DATABASE, task, now, status),
        ]);
        expect(result[0]!.meta.changes).toBe(wins ? 1 : 0);
      } else {
        const db = drizzle(env.DATABASE, { schema });
        const [updated] = await db.batch([
          db
            .update(schema.tasks)
            .set({ updatedAt: now })
            .where(
              and(
                eq(schema.tasks.id, task.id),
                eq(schema.tasks.projectId, task.projectId),
                eq(schema.tasks.status, wins ? status : 'queued')
              )
            )
            .returning({ id: schema.tasks.id }),
          taskRecoveryCancellationQuery(db, task, now, status),
        ]);
        expect(updated).toHaveLength(wins ? 1 : 0);
      }
      // Both losers deliberately match the winner's status AND clock. Only the
      // actual preceding CAS result distinguishes them from the controls.
      expect(
        await env.DATABASE.prepare(
          'SELECT recovery_attempt_id,recovery_status FROM session_snapshots WHERE recovery_task_id=?'
        )
          .bind(task.id)
          .first()
      ).toEqual({
        recovery_attempt_id: wins ? null : 'old-attempt',
        recovery_status: wins ? 'failed' : 'waking',
      });
    }
  );

  it('the canonical setTaskStatus cancellation preserves D1 batch semantics', async () => {
    const identity = await fixture('delegated');
    const db = drizzle(env.DATABASE, { schema });
    const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, identity.id)).get();
    expect((await setTaskStatus(db, task!, 'cancelled', 'user', identity.userId)).status).toBe(
      'cancelled'
    );
    expect(
      await env.DATABASE.prepare(
        'SELECT recovery_attempt_id,recovery_status FROM session_snapshots WHERE recovery_task_id=?'
      )
        .bind(identity.id)
        .first()
    ).toEqual({ recovery_attempt_id: null, recovery_status: 'failed' });
  });
});
