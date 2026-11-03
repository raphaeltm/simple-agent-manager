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
  seedManagedVmAbsenceProof,
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
  beforeDelete?: (nodeId: string, projectId: string) => Promise<void>,
  changeBeforeAudit?: 'incarnation' | 'proof'
) {
  const nodeId = `node-delete-proof-${name}`;
  const projectId = `node-delete-proof-project-${name}`;
  const installationId = `node-delete-proof-installation-${name}`;
  await seedUser(USER_ID);
  await seedInstallation(installationId, USER_ID);
  await seedProject(projectId, USER_ID, installationId);
  await seedNode(nodeId, USER_ID, { status: 'destroying' });
  await seedManagedVmAbsenceProof(nodeId, USER_ID);
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
      if (
        changeBeforeAudit &&
        /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+node_health_events/i.test(query)
      ) {
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values);
            return {
              async run() {
                await env.DATABASE.prepare(
                  changeBeforeAudit === 'incarnation'
                    ? "UPDATE nodes SET runtime_incarnation_id = 'audit-replacement' WHERE id = ?"
                    : 'UPDATE nodes SET runtime_termination_confirmed_at = NULL WHERE id = ?'
                )
                  .bind(nodeId)
                  .run();
                return bound.run();
              },
            };
          },
        } as D1PreparedStatement;
      }
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
  it.each([undefined, 'incarnation', 'proof'] as const)(
    'reuses an existing owner audit without bypassing the current proof fence: %s',
    async (changed) => {
      const createdAt = '2026-01-01T00:00:00.000Z';
      const { response, nodeId } = await scenario(
        `audit-existing-${changed ?? 'same-proof'}`,
        1,
        false,
        async (id) => {
          await env.DATABASE.prepare(
            `INSERT INTO node_health_events
             (id,node_id,episode_started_at,event,reason,created_at)
             SELECT ?,id,COALESCE(last_heartbeat_at,created_at),
               'deleted_by_owner','owner_requested_node_deletion',?
             FROM nodes WHERE id=?`
          )
            .bind(`${id}-existing-audit`, createdAt, id)
            .run();
        },
        changed
      );
      expect(response.status, await response.clone().text()).toBe(changed ? 409 : 200);
      expect(
        await env.DATABASE.prepare('SELECT id FROM nodes WHERE id=?').bind(nodeId).first()
      ).toEqual(changed ? { id: nodeId } : null);
      expect(
        await env.DATABASE.prepare('SELECT auto_provisioned_node_id FROM tasks WHERE id=?')
          .bind(`${nodeId}-task-0`)
          .first()
      ).toEqual({ auto_provisioned_node_id: changed ? nodeId : null });
      expect(
        await env.DATABASE.prepare('SELECT id,created_at FROM node_health_events WHERE node_id=?')
          .bind(nodeId)
          .all()
      ).toMatchObject({
        results: [{ id: `${nodeId}-existing-audit`, created_at: createdAt }],
      });
    }
  );

  it('retains the node when durable owner audit fails and completes the same DELETE on retry', async () => {
    let failure: Awaited<ReturnType<typeof scenario>>;
    try {
      failure = await scenario('audit-failure', 1, false, async (nodeId) => {
        await env.DATABASE.prepare(
          `CREATE TRIGGER fail_owner_deletion_audit
          BEFORE INSERT ON node_health_events
          WHEN NEW.node_id = '${nodeId}' AND NEW.event = 'deleted_by_owner'
          BEGIN SELECT RAISE(ABORT, 'owner deletion audit write failed'); END`
        ).run();
      });
      expect(failure.response.status, await failure.response.clone().text()).toBe(500);
      expect(
        await env.DATABASE.prepare('SELECT id FROM nodes WHERE id = ?').bind(failure.nodeId).first()
      ).toEqual({ id: failure.nodeId });
      expect(
        await env.DATABASE.prepare('SELECT auto_provisioned_node_id FROM tasks WHERE id = ?')
          .bind(`${failure.nodeId}-task-0`)
          .first()
      ).toEqual({ auto_provisioned_node_id: failure.nodeId });
      expect(
        await env.DATABASE.prepare('SELECT id FROM node_health_events WHERE node_id = ?')
          .bind(failure.nodeId)
          .first()
      ).toBeNull();
    } finally {
      await env.DATABASE.exec('DROP TRIGGER IF EXISTS fail_owner_deletion_audit');
    }
    const retry = await failure.app.request(
      `/nodes/${failure.nodeId}`,
      { method: 'DELETE' },
      env as unknown as Env
    );
    expect(retry.status, await retry.clone().text()).toBe(200);
    expect(
      await env.DATABASE.prepare('SELECT id FROM nodes WHERE id = ?').bind(failure.nodeId).first()
    ).toBeNull();
    expect(
      await env.DATABASE.prepare('SELECT event, reason FROM node_health_events WHERE node_id = ?')
        .bind(failure.nodeId)
        .all()
    ).toMatchObject({
      results: [{ event: 'deleted_by_owner', reason: 'owner_requested_node_deletion' }],
    });
    expect(
      await env.DATABASE.prepare('SELECT auto_provisioned_node_id FROM tasks WHERE id = ?')
        .bind(`${failure.nodeId}-task-0`)
        .first()
    ).toEqual({ auto_provisioned_node_id: null });
  });

  it.each(['incarnation', 'proof'] as const)(
    'does not persist strict owner audit when %s changes at its write boundary',
    async (changed) => {
      const { response, nodeId } = await scenario(`audit-${changed}`, 1, false, undefined, changed);
      expect(response.status, await response.clone().text()).toBe(409);
      expect(
        await env.DATABASE.prepare('SELECT id FROM nodes WHERE id = ?').bind(nodeId).first()
      ).toEqual({ id: nodeId });
      expect(
        await env.DATABASE.prepare('SELECT auto_provisioned_node_id FROM tasks WHERE id = ?')
          .bind(`${nodeId}-task-0`)
          .first()
      ).toEqual({ auto_provisioned_node_id: nodeId });
      expect(
        await env.DATABASE.prepare(
          "SELECT id FROM node_health_events WHERE node_id = ? AND reason = 'owner_requested_node_deletion'"
        )
          .bind(nodeId)
          .first()
      ).toBeNull();
    }
  );

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
