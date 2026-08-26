/**
 * Worker-runtime regression for the production incident where ProjectData alarm
 * heartbeat maintenance treated stale ProjectData ACP rows as authoritative VM
 * runtime death.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';
import type { Env } from '../../src/env';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

function getProjectStub(projectId: string): DurableObjectStub<ProjectData> {
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectData>;
}

async function withRuntimeEnv<T>(
  overrides: Partial<Record<keyof Env, string>>,
  fn: () => Promise<T>
): Promise<T> {
  const mutableEnv = env as unknown as Env & Record<string, string | undefined>;
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, mutableEnv[key]);
    mutableEnv[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete mutableEnv[key];
      else mutableEnv[key] = value;
    }
  }
}

describe('ProjectData alarm VM liveness safety', () => {
  it('preserves a VM-backed ACP session when only ProjectData heartbeat data is stale', async () => {
    const prefix = `projectdata-vm-alarm-${Date.now()}-${crypto.randomUUID()}`;
    const userId = `${prefix}-user`;
    const installationId = `${prefix}-install`;
    const projectId = `${prefix}-project`;
    const nodeId = `${prefix}-node`;
    const workspaceId = `${prefix}-workspace`;
    const staleHeartbeatAt = Date.now() - 10 * 60 * 1000;

    await seedUser(userId);
    await seedInstallation(installationId, userId, { installationIdValue: `${prefix}-ext` });
    await seedProject(projectId, userId, installationId);
    await seedNode(nodeId, userId, {
      status: 'running',
      healthStatus: 'healthy',
      lastHeartbeatAt: new Date().toISOString(),
    });
    await env.DATABASE.prepare(`UPDATE nodes SET runtime = 'vm' WHERE id = ?`).bind(nodeId).run();

    const stub = getProjectStub(projectId);
    const chatSessionId = await stub.createSession(null, 'VM alarm liveness safety');
    const acpSession = await stub.createAcpSession({
      chatSessionId,
      initialPrompt: 'Keep working',
      agentType: 'codex',
    });
    await seedWorkspace(workspaceId, nodeId, userId, {
      projectId,
      status: 'running',
      chatSessionId,
    });
    await stub.transitionAcpSession(acpSession.id, 'assigned', {
      actorType: 'system',
      workspaceId,
      nodeId,
    });
    await stub.transitionAcpSession(acpSession.id, 'running', {
      actorType: 'vm-agent',
      actorId: nodeId,
      acpSdkSessionId: `${prefix}-sdk`,
    });

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE acp_sessions SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?`,
        staleHeartbeatAt,
        staleHeartbeatAt,
        acpSession.id
      );
    });

    await withRuntimeEnv(
      {
        ACP_SESSION_DETECTION_WINDOW_MS: '1000',
        TASK_LIVENESS_PROBE_TIMEOUT_MS: '1000',
      },
      async () => {
        await runInDurableObject(stub, async (instance) => {
          await instance.alarm();
        });
      }
    );

    expect((await stub.getAcpSession(acpSession.id))?.status).toBe('running');

    const interruptedEvents = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.sql
        .exec(
          `SELECT id FROM acp_session_events
           WHERE acp_session_id = ? AND to_status = 'interrupted'`,
          acpSession.id
        )
        .toArray()
    );
    expect(interruptedEvents).toEqual([]);

    const workspace = await env.DATABASE.prepare(`SELECT status FROM workspaces WHERE id = ?`)
      .bind(workspaceId)
      .first<{ status: string }>();
    expect(workspace?.status).toBe('running');
  });
});
