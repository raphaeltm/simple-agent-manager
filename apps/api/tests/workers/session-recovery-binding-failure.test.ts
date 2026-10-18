import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { reconcileSessionRecoveryBindingFailure } from '../../src/services/session-recovery-binding-failure';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

describe('workspace-binding failure anchor on real D1', () => {
  it('preserves attempts and bindings while recording the known failure exactly once', async () => {
    const userId = 'binding-user';
    const projectId = 'binding-project';
    await seedUser(userId);
    await seedInstallation('binding-install', userId);
    await seedProject(projectId, userId, 'binding-install');
    await seedNode('binding-node', userId, { status: 'deleted' });
    await seedTask('binding-task', projectId, userId, {
      status: 'sleeping',
      chatSessionId: 'binding-chat',
    });
    for (const [id, chatSessionId] of [
      ['binding-original', null],
      ['binding-retained', 'binding-chat'],
    ] as const) {
      await seedWorkspace(id, 'binding-node', userId, {
        projectId,
        status: 'deleted',
        chatSessionId,
      });
    }
    await env.DATABASE.prepare(
      `UPDATE workspaces SET runtime_deletion_confirmed_at=? WHERE node_id=?`
    )
      .bind('2026-10-18T20:20:00.000Z', 'binding-node')
      .run();
    await env.DATABASE.prepare(`UPDATE tasks SET error_message=?,updated_at=? WHERE id=?`)
      .bind(
        'D1_ERROR: UNIQUE constraint failed: workspaces.chat_session_id',
        '2026-10-18T20:10:00.000Z',
        'binding-task'
      )
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO session_snapshots
      (id,project_id,user_id,workspace_id,node_id,chat_session_id,runtime,status,degradation,
       manifest_r2_key,snapshot_generation,sleeping_at,recovery_status,recovery_task_id,recovery_attempt_id,
       recovery_claimed_at,recovery_attempts,expires_at,updated_at)
      VALUES ('binding-snapshot',?,?, 'binding-original','binding-node','binding-chat','vm',
       'available','none','binding/manifest.json','generation','2026-10-18T19:00:00.000Z','waking','binding-task',
       'binding-attempt','2026-10-18T20:00:00.000Z',3,'2026-10-25T19:00:00.000Z',?)`
    )
      .bind(projectId, userId, '2026-10-18T20:10:00.000Z')
      .run();
    const input = {
      chatSessionId: 'binding-chat',
      userId,
      taskId: 'binding-task',
      recoveryAttemptId: 'binding-attempt',
      staleBefore: '2026-10-18T21:50:00.000Z',
      now: '2026-10-18T22:00:00.000Z',
    };
    const results = await Promise.all([
      reconcileSessionRecoveryBindingFailure(env.DATABASE, input),
      reconcileSessionRecoveryBindingFailure(env.DATABASE, input),
    ]);
    expect(results.filter(Boolean)).toEqual(['2026-10-18T20:10:00.000Z']);
    expect(
      await env.DATABASE.prepare(
        `SELECT recovery_attempts,recovery_status,recovery_failed_at
      FROM session_snapshots WHERE id='binding-snapshot'`
      ).first()
    ).toEqual({
      recovery_attempts: 3,
      recovery_status: 'waking',
      recovery_failed_at: '2026-10-18T20:10:00.000Z',
    });
    expect(
      await env.DATABASE.prepare(
        `SELECT chat_session_id FROM workspaces WHERE id='binding-retained'`
      ).first()
    ).toEqual({ chat_session_id: 'binding-chat' });
  });
});
