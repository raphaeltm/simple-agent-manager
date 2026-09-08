import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { nodesRoutes } from '../../src/routes/nodes';
import { seedInstallation, seedNode, seedProject, seedTask, seedUser } from './helpers/seed-d1';

const USER_ID = 'node-delete-proof-user';
// Supply authentication at the request-context boundary; keep the registered
// handler, strict deletion, lifecycle finalizer and migrated D1/FKs real.
const deleteHandler = nodesRoutes.routes
  .filter((route) => route.method === 'DELETE' && route.path === '/:id')
  .at(-1)!.handler;

async function scenario(name: string, references: number, replaceBeforeDelete = false) {
  const nodeId = `node-delete-proof-${name}`;
  const projectId = `node-delete-proof-project-${name}`;
  const installationId = `node-delete-proof-installation-${name}`;
  await seedUser(USER_ID);
  await seedInstallation(installationId, USER_ID);
  await seedProject(projectId, USER_ID, installationId);
  await seedNode(nodeId, USER_ID, { status: 'destroying' });
  await env.DATABASE.prepare(
    `UPDATE nodes SET runtime = 'vm', runtime_incarnation_id = 'original',
    runtime_termination_confirmed_at = '2026-09-08T13:23:15.343113+00:00' WHERE id = ?`
  )
    .bind(nodeId)
    .run();
  for (let i = 0; i < references; i++) {
    const taskId = `${nodeId}-task-${i}`;
    await seedTask(taskId, projectId, USER_ID, { status: 'failed' });
    await env.DATABASE.prepare('UPDATE tasks SET auto_provisioned_node_id = ? WHERE id = ?')
      .bind(nodeId, taskId)
      .run();
  }
  let deleteChanges: number | undefined;
  const database = {
    prepare(query: string) {
      const statement = env.DATABASE.prepare(query);
      if (!query.startsWith('delete from "nodes"')) return statement;
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return {
            async run() {
              if (replaceBeforeDelete) {
                await env.DATABASE.prepare(
                  `UPDATE nodes SET runtime_incarnation_id = 'replacement',
                  runtime_termination_confirmed_at = NULL WHERE id = ?`
                )
                  .bind(nodeId)
                  .run();
              }
              const result = await bound.run();
              deleteChanges = result.meta.changes;
              return result;
            },
          };
        },
      } as D1PreparedStatement;
    },
  } as D1Database;
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as never)
      : c.json({ error: error.message }, 500)
  );
  app.use('*', async (c, next) => {
    c.set('auth', {
      user: {
        id: USER_ID,
        email: `${USER_ID}@test.com`,
        name: null,
        avatarUrl: null,
        role: 'user',
        status: 'active',
      },
      session: { id: null, token: null, expiresAt: new Date(Date.now() + 60_000) },
    });
    await next();
  });
  app.delete('/nodes/:id', deleteHandler);
  const response = await app.request(`/nodes/${nodeId}`, { method: 'DELETE' }, {
    ...env,
    DATABASE: database,
  } as unknown as Env);
  return { response, nodeId, projectId, deleteChanges };
}

describe('managed node DELETE with real D1 proof and task foreign-key cascades', () => {
  it.each([0, 1, 2])(
    'confirms deletion when %i task references are cleared by the FK',
    async (references) => {
      const { response, nodeId, projectId, deleteChanges } = await scenario(
        `refs-${references}`,
        references
      );
      // D1 includes FK SET NULL writes in meta.changes, unlike sqlite changes().
      expect(deleteChanges, await response.clone().text()).toBe(references + 1);
      expect(
        await env.DATABASE.prepare('SELECT id FROM nodes WHERE id = ?').bind(nodeId).first()
      ).toBeNull();
      expect(
        (
          await env.DATABASE.prepare(
            `SELECT id FROM tasks WHERE project_id = ?
      AND auto_provisioned_node_id IS NOT NULL`
          )
            .bind(projectId)
            .all()
        ).results
      ).toEqual([]);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({ success: true });
    }
  );

  it('still rejects a zero-change DELETE when the incarnation changes after proof verification', async () => {
    const { response, nodeId, deleteChanges } = await scenario('replacement', 1, true);
    expect(deleteChanges, await response.clone().text()).toBe(0);
    expect(response.status).toBe(409);
    expect(
      await env.DATABASE.prepare(
        `SELECT runtime_incarnation_id AS incarnation,
      runtime_termination_confirmed_at AS proof FROM nodes WHERE id = ?`
      )
        .bind(nodeId)
        .first()
    ).toEqual({ incarnation: 'replacement', proof: null });
    expect(
      await env.DATABASE.prepare(
        'SELECT auto_provisioned_node_id AS nodeId FROM tasks WHERE id = ?'
      )
        .bind(`${nodeId}-task-0`)
        .first()
    ).toEqual({ nodeId });
  });
});
