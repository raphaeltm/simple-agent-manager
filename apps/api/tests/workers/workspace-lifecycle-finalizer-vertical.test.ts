import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import { persistRuntimeEnded } from '../../src/durable-objects/vm-agent-container-runtime';
import type { Env } from '../../src/env';
import { deleteNodeResources, stopNodeResources } from '../../src/services/nodes';
import { cleanupWorkspaceForDeletion } from '../../src/services/workspace-cleanup';
import {
  seedAgentSession,
  seedComputeUsage,
  seedInstallation,
  seedNode,
  seedProject,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

async function seedBase(prefix: string): Promise<{
  userId: string;
  installationId: string;
  projectId: string;
  nodeId: string;
  workspaceId: string;
  agentSessionId: string;
}> {
  const userId = `${prefix}-user`;
  const installationId = `${prefix}-installation`;
  const projectId = `${prefix}-project`;
  const nodeId = `${prefix}-node`;
  const workspaceId = `${prefix}-workspace`;
  const agentSessionId = `${prefix}-agent`;

  await seedUser(userId);
  await seedInstallation(installationId, userId, {
    installationIdValue: `${prefix}-external-installation`,
  });
  await seedProject(projectId, userId, installationId);
  await seedNode(nodeId, userId, { status: 'running' });
  await seedWorkspace(workspaceId, nodeId, userId, {
    projectId,
    status: 'running',
  });
  await seedAgentSession(agentSessionId, workspaceId, userId, { status: 'running' });

  return { userId, installationId, projectId, nodeId, workspaceId, agentSessionId };
}

async function countRunningAgentSessions(workspaceId: string): Promise<number> {
  const row = await env.DATABASE.prepare(
    `SELECT COUNT(*) AS count FROM agent_sessions WHERE workspace_id = ? AND status = 'running'`
  )
    .bind(workspaceId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function getAgentSession(
  agentSessionId: string
): Promise<{ status: string; stopped_at: string | null; error_message: string | null } | null> {
  return env.DATABASE.prepare(
    `SELECT status, stopped_at, error_message FROM agent_sessions WHERE id = ?`
  )
    .bind(agentSessionId)
    .first<{ status: string; stopped_at: string | null; error_message: string | null }>();
}

describe('workspace lifecycle finalizer vertical slices', () => {
  it('stopNodeResources closes running agent sessions for deleted node workspaces', async () => {
    const ids = await seedBase(`stop-node-${crypto.randomUUID()}`);
    await seedComputeUsage(`${ids.workspaceId}-usage`, ids.userId, ids.workspaceId, ids.nodeId);

    await stopNodeResources(ids.nodeId, ids.userId, env as unknown as Env);

    const workspace = await env.DATABASE.prepare(`SELECT status FROM workspaces WHERE id = ?`)
      .bind(ids.workspaceId)
      .first<{ status: string }>();
    const node = await env.DATABASE.prepare(`SELECT status FROM nodes WHERE id = ?`)
      .bind(ids.nodeId)
      .first<{ status: string }>();
    const usage = await env.DATABASE.prepare(
      `SELECT ended_at FROM compute_usage WHERE workspace_id = ?`
    )
      .bind(ids.workspaceId)
      .first<{ ended_at: string | null }>();

    expect(workspace).toEqual({ status: 'deleted' });
    expect(node).toEqual({ status: 'deleted' });
    expect(await getAgentSession(ids.agentSessionId)).toMatchObject({
      status: 'stopped',
      stopped_at: expect.any(String),
    });
    expect(usage?.ended_at).toEqual(expect.any(String));
    expect(await countRunningAgentSessions(ids.workspaceId)).toBe(0);
  });

  it('deleteNodeResources closes running agent sessions for deleted node workspaces', async () => {
    const ids = await seedBase(`delete-node-${crypto.randomUUID()}`);

    const result = await deleteNodeResources(ids.nodeId, ids.userId, env as unknown as Env);

    const workspace = await env.DATABASE.prepare(`SELECT status FROM workspaces WHERE id = ?`)
      .bind(ids.workspaceId)
      .first<{ status: string }>();
    expect(result).toMatchObject({ nodeFound: true, errors: [] });
    expect(workspace).toEqual({ status: 'deleted' });
    expect(await getAgentSession(ids.agentSessionId)).toMatchObject({
      status: 'completed',
      stopped_at: expect.any(String),
    });
    expect(await countRunningAgentSessions(ids.workspaceId)).toBe(0);
  });

  it('cleanupWorkspaceForDeletion leaves no running agent session after hard workspace deletion', async () => {
    const ids = await seedBase(`hard-delete-ws-${crypto.randomUUID()}`);
    await env.DATABASE.prepare(`UPDATE workspaces SET node_id = NULL WHERE id = ?`)
      .bind(ids.workspaceId)
      .run();
    const db = drizzle(env.DATABASE, { schema });
    const [workspace] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ids.workspaceId))
      .limit(1);
    if (!workspace) throw new Error('expected seeded workspace');

    await cleanupWorkspaceForDeletion({
      db,
      env: env as unknown as Env,
      workspace,
      userId: ids.userId,
      logContext: { closePath: 'test_hard_workspace_delete' },
    });

    const workspaceAfter = await env.DATABASE.prepare(`SELECT id FROM workspaces WHERE id = ?`)
      .bind(ids.workspaceId)
      .first<{ id: string }>();
    expect(workspaceAfter).toBeNull();
    expect(await countRunningAgentSessions(ids.workspaceId)).toBe(0);
  });

  it('persistRuntimeEnded closes running agent sessions for Instant terminal teardown', async () => {
    const ids = await seedBase(`runtime-ended-${crypto.randomUUID()}`);
    await env.DATABASE.prepare(`UPDATE nodes SET runtime = 'cf-container' WHERE id = ?`)
      .bind(ids.nodeId)
      .run();

    await persistRuntimeEnded(
      env as unknown as Env,
      { nodeId: ids.nodeId, workspaceId: ids.workspaceId },
      'error',
      'container exited'
    );

    const node = await env.DATABASE.prepare(
      `SELECT status, health_status, error_message FROM nodes WHERE id = ?`
    )
      .bind(ids.nodeId)
      .first<Record<string, string | null>>();
    const workspace = await env.DATABASE.prepare(
      `SELECT status, error_message FROM workspaces WHERE id = ?`
    )
      .bind(ids.workspaceId)
      .first<Record<string, string | null>>();

    expect(node).toEqual({
      status: 'error',
      health_status: 'unhealthy',
      error_message: 'container exited',
    });
    expect(workspace).toEqual({
      status: 'error',
      error_message: 'container exited',
    });
    expect(await getAgentSession(ids.agentSessionId)).toMatchObject({
      status: 'error',
      stopped_at: expect.any(String),
      error_message: 'container exited',
    });
    expect(await countRunningAgentSessions(ids.workspaceId)).toBe(0);
  });
});
