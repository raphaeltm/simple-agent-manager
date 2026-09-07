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
  seedTask,
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
        await runInDurableObject(stub, async (instance, state) => {
          await instance.alarm();
          await state.storage.deleteAlarm();
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

  it('replays 01M1M75WA3V528VYZCWQGGM3NT through the stale-mirror alarm', async () => {
    const taskId = '01M1M75WA3V528VYZCWQGGM3NT';
    const prefix = `projectdata-exact-stale-alarm-${crypto.randomUUID()}`;
    const userId = `${prefix}-user`;
    const installationId = `${prefix}-install`;
    const projectId = `${prefix}-project`;
    const nodeId = `${prefix}-node`;
    const workspaceId = `${prefix}-workspace`;
    const promptStartedAt = Date.parse('2026-09-03T22:02:15.000Z');

    // The Workers pool owns the Durable Object clock, so exact incident time is
    // represented in every persisted mirror below. Threshold timing itself is
    // replayed with a controlled clock in the unit-level production sequence.
    await seedUser(userId);
    await seedInstallation(installationId, userId, { installationIdValue: `${prefix}-ext` });
    await seedProject(projectId, userId, installationId);
    await seedNode(nodeId, userId, {
      status: 'running',
      healthStatus: 'unhealthy',
      lastHeartbeatAt: new Date(promptStartedAt).toISOString(),
    });
    await env.DATABASE.prepare(`UPDATE nodes SET runtime = 'vm' WHERE id = ?`).bind(nodeId).run();
    await seedWorkspace(workspaceId, nodeId, userId, {
      projectId,
      status: 'running',
    });
    await seedTask(taskId, projectId, userId, {
      status: 'in_progress',
      workspaceId,
      taskMode: 'task',
    });

    const stub = getProjectStub(projectId);
    await stub.ensureProjectId(projectId);
    const chatSessionId = await stub.createSession(
      workspaceId,
      'Exact stale mirror alarm replay',
      taskId,
      userId
    );
    await env.DATABASE.prepare(`UPDATE tasks SET chat_session_id = ? WHERE id = ?`)
      .bind(chatSessionId, taskId)
      .run();
    await env.DATABASE.prepare(`UPDATE workspaces SET chat_session_id = ? WHERE id = ?`)
      .bind(chatSessionId, workspaceId)
      .run();
    const acpSession = await stub.createAcpSession({
      chatSessionId,
      initialPrompt: 'Keep working through the long prompt',
      agentType: 'codex',
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
        `INSERT INTO session_state
             (session_id, activity, activity_at, prompt_started_at,
              activity_probe_attempts, restart_count)
           VALUES (?, 'prompting', ?, ?, 3, 0)`,
        acpSession.id,
        promptStartedAt,
        promptStartedAt
      );
      state.storage.sql.exec(
        `UPDATE acp_sessions SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?`,
        promptStartedAt,
        promptStartedAt,
        acpSession.id
      );
      state.storage.sql.exec(
        `INSERT INTO workspace_activity
             (workspace_id, session_id, last_message_at, last_terminal_activity_at, created_at)
           VALUES (?, ?, ?, 0, ?)
           ON CONFLICT(workspace_id) DO UPDATE SET last_message_at = excluded.last_message_at`,
        workspaceId,
        chatSessionId,
        promptStartedAt,
        promptStartedAt
      );
      // The runtime probe itself is outside this vertical mutation test. The
      // removed SQL-only rewrite ignored the quarantine counter, so restoring
      // that unsafe alarm call would still flip this exact stale mirror.
    });

    await withRuntimeEnv(
      {
        SESSION_ACTIVITY_STALE_THRESHOLD_MS: '1000',
        SESSION_ACTIVITY_PROBE_TIMEOUT_MS: '100',
        // Workerd's DO clock is not controlled by Vitest's runner clock.
        // Keep task check-in I/O out of this alarm mutation test; the unit
        // replay above covers the production 30m/2h thresholds exactly.
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(365 * 24 * 60 * 60 * 1000),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(2 * 365 * 24 * 60 * 60 * 1000),
        TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS: '100',
      },
      async () => {
        await runInDurableObject(stub, async (instance, state) => {
          await instance.alarm();
          await state.storage.deleteAlarm();
        });
      }
    );

    expect((await stub.getSessionState(acpSession.id))?.activity).toBe('prompting');
    const localEvidence = await runInDurableObject(stub, async (_instance, state) => ({
      chat: state.storage.sql
        .exec(`SELECT status FROM chat_sessions WHERE id = ?`, chatSessionId)
        .toArray()[0],
      messages: state.storage.sql
        .exec(`SELECT id FROM chat_messages WHERE session_id = ?`, chatSessionId)
        .toArray(),
      markers: state.storage.sql
        .exec(`SELECT id FROM session_attention_markers WHERE session_id = ?`, chatSessionId)
        .toArray(),
      destructiveEvents: state.storage.sql
        .exec(
          `SELECT event_type FROM activity_events
             WHERE session_id = ?
               AND event_type IN ('session.activity_reconciled', 'reconciliation.dead_target_failed')`,
          chatSessionId
        )
        .toArray(),
    }));
    expect(localEvidence.chat).toMatchObject({ status: 'active' });
    expect(localEvidence.messages).toEqual([]);
    expect(localEvidence.markers).toEqual([]);
    expect(localEvidence.destructiveEvents).toEqual([]);
    expect(
      await env.DATABASE.prepare(`SELECT status FROM tasks WHERE id = ?`)
        .bind(taskId)
        .first<{ status: string }>()
    ).toMatchObject({ status: 'in_progress' });
  });
});
