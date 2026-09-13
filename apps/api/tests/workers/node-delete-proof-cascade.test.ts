import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { nodesRoutes } from '../../src/routes/nodes';
import { crudRoutes } from '../../src/routes/workspaces/crud';
import { claimSessionSnapshotRecovery } from '../../src/services/session-snapshot-recovery-lifecycle';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const USER_ID = 'node-delete-proof-user';
// Supply authentication at the request-context boundary; keep the registered
// handler, strict deletion, lifecycle finalizer and migrated D1/FKs real.
const deleteHandler = nodesRoutes.routes
  .filter((route) => route.method === 'DELETE' && route.path === '/:id')
  .at(-1)!.handler;

async function scenario(
  name: string,
  references: number,
  replaceBeforeDelete = false,
  beforeDelete?: (nodeId: string, projectId: string) => Promise<void>
) {
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
  await beforeDelete?.(nodeId, projectId);
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
  app.delete(
    '/workspaces/:id',
    crudRoutes.routes.filter((route) => route.method === 'DELETE' && route.path === '/:id').at(-1)!
      .handler
  );
  const response = await app.request(`/nodes/${nodeId}`, { method: 'DELETE' }, {
    ...env,
    DATABASE: database,
  } as unknown as Env);
  return { response, nodeId, projectId, deleteChanges, app };
}

describe('managed node DELETE with real D1 proof and task foreign-key cascades', () => {
  it.each([
    { snapshotStatus: 'available', nodeClass: 'managed', variant: 'available' },
    { snapshotStatus: 'degraded', nodeClass: 'managed', variant: 'degraded' },
    { snapshotStatus: 'pending', nodeClass: 'managed', variant: 'preparing' },
    { snapshotStatus: 'available', nodeClass: 'managed', variant: 'waking' },
    { snapshotStatus: 'available', nodeClass: 'managed', variant: 'different-session' },
    { snapshotStatus: 'available', nodeClass: 'user-owned', variant: 'byo' },
  ] as const)(
    'preserves $variant snapshot context on $nodeClass removal',
    async ({ snapshotStatus, nodeClass, variant }) => {
      let workspaceId = '';
      let chatSessionId = '';
      let snapshotId = '';
      const { response, nodeId, projectId, app } = await scenario(
        `sleep-${variant}`,
        1,
        false,
        async (node, project) => {
          workspaceId = `${node}-sleeping`;
          chatSessionId = `${node}-chat`;
          snapshotId = `${node}-snapshot`;
          await seedWorkspace(workspaceId, node, USER_ID, {
            status: 'sleeping',
            projectId: project,
            chatSessionId,
          });
          await seedWorkspace(`${node}-unrestorable`, node, USER_ID, {
            status: 'stopped',
            projectId: project,
          });
          if (nodeClass === 'user-owned') {
            await env.DATABASE.prepare(
              "UPDATE nodes SET node_class = 'user-owned', runtime_termination_confirmed_at = NULL WHERE id = ?"
            )
              .bind(node)
              .run();
          }
          const now = new Date().toISOString();
          await env.DATABASE.prepare(
            `INSERT INTO session_snapshots
        (id, project_id, workspace_id, node_id, user_id, chat_session_id, runtime, status,
         degradation, home_r2_key, manifest_r2_key, expires_at, sleeping_at, sleep_status,
         snapshot_generation, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'vm', ?, ?, ?, ?, ?, ?, 'sleeping', 'generation-1', ?, ?)`
          )
            .bind(
              snapshotId,
              project,
              workspaceId,
              node,
              USER_ID,
              chatSessionId,
              snapshotStatus,
              snapshotStatus === 'available' ? 'none' : 'wip-skipped',
              `${snapshotId}/home`,
              `${snapshotId}/manifest`,
              new Date(Date.now() + 86_400_000).toISOString(),
              now,
              now,
              now
            )
            .run();
          if (variant === 'waking') {
            await env.DATABASE.prepare(
              "UPDATE session_snapshots SET recovery_status = 'waking', recovery_attempts = 3 WHERE id = ?"
            )
              .bind(snapshotId)
              .run();
          } else if (variant === 'preparing') {
            await env.DATABASE.prepare(
              "UPDATE session_snapshots SET sleeping_at = NULL, sleep_status = 'preparing', capture_generation = 'capture-2' WHERE id = ?"
            )
              .bind(snapshotId)
              .run();
          } else if (variant === 'different-session') {
            await env.DATABASE.prepare('UPDATE workspaces SET chat_session_id = NULL WHERE id = ?')
              .bind(workspaceId)
              .run();
          }
          await env.R2.put(`${snapshotId}/home`, 'saved-home');
          await env.R2.put(`${snapshotId}/manifest`, '{}');
        }
      );
      expect(response.status, await response.clone().text()).toBe(200);
      expect(
        await env.DATABASE.prepare('SELECT id FROM nodes WHERE id = ?').bind(nodeId).first()
      ).toBeNull();
      const workspace = await env.DATABASE.prepare(
        `SELECT node_id, status, project_id, chat_session_id,
      runtime_deletion_confirmed_at, runtime_deletion_proof, resolved_reservation_json FROM workspaces WHERE id = ?`
      )
        .bind(workspaceId)
        .first();
      expect(workspace).toMatchObject({
        node_id: null,
        status: 'deleted',
        project_id: projectId,
        chat_session_id: variant === 'different-session' ? null : chatSessionId,
        runtime_deletion_proof: nodeClass === 'managed' ? 'node_runtime_terminated' : null,
      });
      if (nodeClass === 'managed') expect(workspace?.runtime_deletion_confirmed_at).toBeTruthy();
      else expect(workspace?.runtime_deletion_confirmed_at).toBeNull();
      expect(JSON.parse(workspace!.resolved_reservation_json as string)).toMatchObject({
        memoryMb: 1024,
      });
      expect(
        await env.DATABASE.prepare(
          'SELECT workspace_id, node_id FROM session_snapshots WHERE id = ?'
        )
          .bind(snapshotId)
          .first()
      ).toEqual({ workspace_id: workspaceId, node_id: null });
      expect(
        await env.DATABASE.prepare('SELECT id FROM workspaces WHERE id = ?')
          .bind(`${nodeId}-unrestorable`)
          .first()
      ).toBeNull();
      // These cases prove conservative context retention without inventing a new
      // wake claim or treating BYO deregistration as physical termination proof.
      if (variant !== 'available' && variant !== 'degraded') return;
      const claim = await claimSessionSnapshotRecovery(
        drizzle(env.DATABASE, { schema }),
        env as unknown as Env,
        {
          chatSessionId,
          userId: USER_ID,
          taskId: `${nodeId}-recovery`,
        }
      );
      expect(claim).toMatchObject({ status: 'claimed' });
      expect(await env.R2.head(`${snapshotId}/home`)).not.toBeNull();
      // Explicit workspace deletion remains destructive after its node was removed.
      const deleted = await app.request(
        `/workspaces/${workspaceId}`,
        { method: 'DELETE' },
        env as unknown as Env
      );
      expect(deleted.status, await deleted.clone().text()).toBe(200);
      expect(
        await env.DATABASE.prepare('SELECT id FROM session_snapshots WHERE id = ?')
          .bind(snapshotId)
          .first()
      ).toBeNull();
      expect(
        await env.DATABASE.prepare('SELECT id FROM workspaces WHERE id = ?')
          .bind(workspaceId)
          .first()
      ).toBeNull();
      expect(await env.R2.head(`${snapshotId}/home`)).toBeNull();
      expect(await env.R2.head(`${snapshotId}/manifest`)).toBeNull();
    }
  );

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
