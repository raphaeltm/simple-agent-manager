import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  persistRuntimeRecovered,
  persistRuntimeRecovering,
  RUNTIME_RECOVERING_MESSAGE,
  RUNTIME_REQUEST_INTERRUPTED_MESSAGE,
} from '../../src/durable-objects/vm-agent-container-recovery';
import type { Env } from '../../src/env';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

describe('Instant runtime status reconciliation with Miniflare D1', () => {
  it('moves related rows through recovery to running without losing manual-retry state', async () => {
    const prefix = `runtime-persistence-${Date.now()}-${crypto.randomUUID()}`;
    const userId = `${prefix}-user`;
    const installationId = `${prefix}-installation`;
    const projectId = `${prefix}-project`;
    const nodeId = `${prefix}-node`;
    const workspaceId = `${prefix}-workspace`;
    const chatSessionId = `${prefix}-chat`;
    const agentSessionId = `${prefix}-agent`;

    await seedUser(userId);
    await seedInstallation(installationId, userId, {
      installationIdValue: `${prefix}-external`,
    });
    await seedProject(projectId, userId, installationId);
    await seedNode(nodeId, userId, { status: 'running' });
    await env.DATABASE.prepare(`UPDATE nodes SET runtime = 'cf-container' WHERE id = ?`)
      .bind(nodeId)
      .run();
    await seedWorkspace(workspaceId, nodeId, userId, {
      projectId,
      status: 'running',
      chatSessionId,
    });
    await env.DATABASE.prepare(
      `INSERT INTO agent_sessions
         (id, workspace_id, user_id, status, agent_type, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 'codex', datetime('now'), datetime('now'))`
    )
      .bind(agentSessionId, workspaceId, userId)
      .run();

    const bindings = env as unknown as Env;
    const target = { nodeId, workspaceId, projectId, chatSessionId, agentSessionId };
    await persistRuntimeRecovering(bindings, target);

    const recoveringNode = await env.DATABASE.prepare(
      `SELECT status, health_status, error_message FROM nodes WHERE id = ?`
    )
      .bind(nodeId)
      .first<Record<string, string>>();
    const recoveringWorkspace = await env.DATABASE.prepare(
      `SELECT status, error_message FROM workspaces WHERE id = ?`
    )
      .bind(workspaceId)
      .first<Record<string, string>>();
    const recoveringAgent = await env.DATABASE.prepare(
      `SELECT status, error_message FROM agent_sessions WHERE id = ?`
    )
      .bind(agentSessionId)
      .first<Record<string, string>>();

    expect(recoveringNode).toMatchObject({
      status: 'recovery',
      health_status: 'unhealthy',
      error_message: RUNTIME_RECOVERING_MESSAGE,
    });
    expect(recoveringWorkspace).toMatchObject({
      status: 'recovery',
      error_message: RUNTIME_RECOVERING_MESSAGE,
    });
    expect(recoveringAgent).toMatchObject({
      status: 'recovery',
      error_message: RUNTIME_RECOVERING_MESSAGE,
    });

    await persistRuntimeRecovered(bindings, target, 'manual_retry');

    const recoveredNode = await env.DATABASE.prepare(
      `SELECT status, health_status, error_message FROM nodes WHERE id = ?`
    )
      .bind(nodeId)
      .first<Record<string, string | null>>();
    const recoveredWorkspace = await env.DATABASE.prepare(
      `SELECT status, error_message FROM workspaces WHERE id = ?`
    )
      .bind(workspaceId)
      .first<Record<string, string | null>>();
    const recoveredAgent = await env.DATABASE.prepare(
      `SELECT status, stopped_at, error_message FROM agent_sessions WHERE id = ?`
    )
      .bind(agentSessionId)
      .first<Record<string, string | null>>();

    expect(recoveredNode).toEqual({
      status: 'running',
      health_status: 'healthy',
      error_message: null,
    });
    expect(recoveredWorkspace).toEqual({ status: 'running', error_message: null });
    expect(recoveredAgent).toEqual({
      status: 'running',
      stopped_at: null,
      error_message: RUNTIME_REQUEST_INTERRUPTED_MESSAGE,
    });
  });
});
