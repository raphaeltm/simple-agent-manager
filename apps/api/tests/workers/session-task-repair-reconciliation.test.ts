import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { runSessionTaskReconciliation } from '../../src/scheduled/session-task-reconciliation';
import * as projectData from '../../src/services/project-data';
import {
  seedInstallation,
  seedNode,
  seedProject,
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
