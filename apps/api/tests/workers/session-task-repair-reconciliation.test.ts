import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { runSessionTaskReconciliation } from '../../src/scheduled/session-task-reconciliation';
import * as projectData from '../../src/services/project-data';
import { ensureSessionTaskBacked } from '../../src/services/session-task-repair';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const bindings = env as unknown as Env;

describe('scheduled legacy session task repair', () => {
  it.each([true, false])(
    'repairs and links a legacy chat with deleted workspace=%s',
    async (deleted) => {
      const id = crypto.randomUUID();
      const user = `u-${id}`,
        project = `p-${id}`,
        node = `n-${id}`,
        workspace = `w-${id}`;
      await seedUser(user);
      await seedInstallation(`i-${id}`, user);
      await seedProject(project, user, `i-${id}`);
      await seedNode(node, user);
      await seedWorkspace(workspace, node, user, { projectId: project });
      const chat = await projectData.createSession(
        bindings,
        project,
        workspace,
        'Legacy chat',
        null,
        user
      );
      await projectData.stopSession(bindings, project, chat);
      if (deleted)
        await env.DATABASE.prepare('DELETE FROM workspaces WHERE id = ?').bind(workspace).run();
      await env.DATABASE.prepare(
        `INSERT OR REPLACE INTO session_summaries
      (id, project_id, user_id, workspace_id, status, task_id, started_at, updated_at)
      VALUES (?, ?, ?, ?, 'stopped', NULL, ?, ?)`
      )
        .bind(chat, project, user, workspace, Date.now(), Date.now())
        .run();

      const result = await runSessionTaskReconciliation(bindings);
      expect(result.errors).toBe(0);
      expect(result.repaired).toBeGreaterThanOrEqual(1);
      const tasks = await env.DATABASE.prepare(
        'SELECT id, workspace_id, status FROM tasks WHERE chat_session_id = ?'
      )
        .bind(chat)
        .all<{ id: string; workspace_id: string | null; status: string }>();
      expect(tasks.results).toHaveLength(1);
      expect(tasks.results[0]).toMatchObject({
        workspace_id: deleted ? null : workspace,
        status: 'completed',
      });
      expect(await projectData.getSession(bindings, project, chat)).toMatchObject({
        taskId: tasks.results[0]!.id,
      });
      expect(
        await env.DATABASE.prepare('SELECT task_id FROM session_summaries WHERE id = ?')
          .bind(chat)
          .first('task_id')
      ).toBe(tasks.results[0]!.id);
      expect((await runSessionTaskReconciliation(bindings)).errors).toBe(0);
      expect(
        await env.DATABASE.prepare('SELECT count(*) n FROM tasks WHERE chat_session_id = ?')
          .bind(chat)
          .first('n')
      ).toBe(1);
    }
  );
});

describe('ensureSessionTaskBacked on a session whose task link is owned elsewhere', () => {
  it.each([
    { owned: true, expected: { root: 'chat', recovery: null } },
    { owned: false, expected: { root: null, recovery: 'chat' } },
  ])(
    'returns the session task and links it only when unowned (owned=$owned)',
    async ({ owned, expected }) => {
      const id = crypto.randomUUID();
      const user = `u-${id}`,
        project = `p-${id}`,
        root = `root-${id}`,
        recovery = `recovery-${id}`;
      await seedUser(user);
      await seedInstallation(`i-${id}`, user);
      await seedProject(project, user, `i-${id}`);
      // Pre-#2230 wakes left the ProjectData session pointing at the recovery task while the
      // task it recovered from kept the chat-session link (the production Fork 500s).
      const chat = await projectData.createSession(
        bindings,
        project,
        null,
        'Recovered chat',
        recovery,
        user
      );
      await seedTask(root, project, user, {
        chatSessionId: owned ? chat : null,
        status: 'cancelled',
        taskMode: 'conversation',
      });
      await seedTask(recovery, project, user, {
        recoverySourceTaskId: root,
        status: 'cancelled',
        taskMode: 'conversation',
      });

      const task = await ensureSessionTaskBacked(drizzle(env.DATABASE, { schema }), bindings, {
        projectId: project,
        sessionId: chat,
        fallbackUserId: user,
      });

      expect(task.id).toBe(recovery);
      const linkOf = (taskId: string) =>
        env.DATABASE.prepare('SELECT chat_session_id FROM tasks WHERE id = ?')
          .bind(taskId)
          .first<string | null>('chat_session_id');
      const asChat = (value: 'chat' | null) => (value === 'chat' ? chat : null);
      expect(await linkOf(root)).toBe(asChat(expected.root));
      expect(await linkOf(recovery)).toBe(asChat(expected.recovery));
    }
  );
});
