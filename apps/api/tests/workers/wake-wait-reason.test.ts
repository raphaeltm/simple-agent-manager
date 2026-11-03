/**
 * A waiting wake must say why it is waiting.
 *
 * Production 2026-11-02, chat 26f76165…: the chat said "Waiting for server
 * capacity..." for 25 minutes while three different things blocked it — the
 * slept workspace's deletion, Hetzner returning 412 for every offering, then a
 * new server booting. The server recorded each cause; the banner showed none.
 *
 * Driven through the real admission writer (`waitForVmAdmissionCapacity`, the
 * TaskRunner's wait path) and the real wake-state reader the session detail
 * route uses, on migrated D1.
 */
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { requireApproved, requireAuth } from '../../src/middleware/auth';
import { chatRoutes } from '../../src/routes/chat';
import { attachWakeState } from '../../src/routes/chat/wake-state';
import { waitForVmAdmissionCapacity } from '../../src/services/vm-admission-control';
import type { VmTaskAdmissionIdentity } from '../../src/services/vm-admission-control-types';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedSignedInUser,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

async function seedSleepingSession(
  suffix: string,
  opts: { recoveryStatus: string | null; sleptWorkspaceStatus: string }
) {
  const userId = `wake-wait-user-${suffix}`;
  const projectId = `wake-wait-project-${suffix}`;
  const nodeId = `wake-wait-node-${suffix}`;
  const workspaceId = `wake-wait-ws-${suffix}`;
  const taskId = `wake-wait-task-${suffix}`;
  await seedUser(userId);
  await seedInstallation(`wake-wait-install-${suffix}`, userId);
  await seedProject(projectId, userId, `wake-wait-install-${suffix}`);
  await seedNode(nodeId, userId);
  // A real sleeping chat session in ProjectData, so the session detail route serves it.
  const projectData = env.PROJECT_DATA.get(env.PROJECT_DATA.idFromName(projectId)) as unknown as {
    ensureProjectId(id: string): Promise<void>;
    createSession(
      ws: string,
      topic: string,
      taskId: string | null,
      userId: string
    ): Promise<string>;
    sleepSession(id: string): Promise<boolean>;
  };
  await projectData.ensureProjectId(projectId);
  const chatSessionId = await projectData.createSession(workspaceId, 'Wake wait', null, userId);
  expect(await projectData.sleepSession(chatSessionId)).toBe(true);
  await seedWorkspace(workspaceId, nodeId, userId, {
    projectId,
    status: opts.sleptWorkspaceStatus,
    chatSessionId,
  });
  if (opts.sleptWorkspaceStatus === 'deleted') {
    // Production writes `deleted` only with deletion proof.
    await env.DATABASE.prepare(
      `UPDATE workspaces SET runtime_deletion_confirmed_at = '2026-11-02T09:00:00.000Z' WHERE id = ?`
    )
      .bind(workspaceId)
      .run();
  }
  await seedTask(taskId, projectId, userId, {
    status: 'queued',
    chatSessionId,
    executionStep: 'node_selection',
  });
  await env.DATABASE.prepare(
    `INSERT INTO session_snapshots (id, project_id, workspace_id, node_id, user_id, chat_session_id,
       runtime, status, degradation, manifest_r2_key, expires_at, sleep_status,
       recovery_status, recovery_task_id)
     VALUES (?, ?, ?, ?, ?, ?, 'vm', 'available', 'none', ?, '2099-01-01T00:00:00.000Z',
       'sleeping', ?, ?)`
  )
    .bind(
      `wake-wait-snap-${suffix}`,
      projectId,
      workspaceId,
      nodeId,
      userId,
      chatSessionId,
      `snapshots/${suffix}/manifest.json`,
      opts.recoveryStatus,
      taskId
    )
    .run();
  const identity: VmTaskAdmissionIdentity = {
    taskId,
    projectId,
    userId,
    provider: 'hetzner',
    credentialSource: 'user',
    credentialDomainKey: `user:${userId}:hetzner`,
    providerDomainKey: `hetzner:user:${userId}`,
    scopeKey: `user:${userId}:workspace-vm:hetzner:user:${userId}`,
    requestedVmSize: 'medium',
    requestedVmLocation: 'fsn1',
    preferredNodeId: null,
  };
  return { userId, projectId, workspaceId, nodeId, chatSessionId, taskId, identity };
}

function readWakeState(projectId: string, chatSessionId: string) {
  return attachWakeState(drizzle(env.DATABASE, { schema }), null, {
    projectId,
    sessionId: chatSessionId,
    sessionStatus: 'sleeping',
  });
}

/** The session detail route exactly as the browser reaches it, with a real session cookie. */
async function readWakeStateOverHttp(seeded: {
  userId: string;
  projectId: string;
  chatSessionId: string;
}) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.use('/api/projects/*', requireAuth(), requireApproved());
  app.route('/api/projects/:projectId/sessions', chatRoutes);
  const cookie = await seedSignedInUser(seeded.userId);
  const response = await app.request(
    `/api/projects/${seeded.projectId}/sessions/${seeded.chatSessionId}`,
    { headers: { Cookie: cookie } },
    env as unknown as Env
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    session: { status: string };
    state: Record<string, unknown> | null;
  };
  // Liveness: the route served the sleeping session, so an absent reason means something.
  expect(body.session.status).toBe('sleeping');
  return body.state;
}

describe('a waiting wake reports why it is waiting', () => {
  it('names provider capacity and the next retry, and follows a change of cause', async () => {
    const seeded = await seedSleepingSession('capacity', {
      recoveryStatus: 'waking',
      sleptWorkspaceStatus: 'deleted',
    });
    const retryAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const wait = await waitForVmAdmissionCapacity(
      env as unknown as Env,
      seeded.identity,
      'provider_transient_capacity',
      retryAt
    );
    expect(wait.kind).toBe('waiting');
    const recorded = await env.DATABASE.prepare(
      'SELECT admission_next_retry_at FROM tasks WHERE id = ?'
    )
      .bind(seeded.taskId)
      .first<{ admission_next_retry_at: string }>();

    await expect(readWakeState(seeded.projectId, seeded.chatSessionId)).resolves.toMatchObject({
      recoveryStatus: 'waking',
      wakePhase: 'waiting_for_node_capacity',
      waitReason: 'provider_transient_capacity',
      waitRetryAt: recorded?.admission_next_retry_at,
    });

    // The same wait step, a different cause: a new server is now booting.
    await waitForVmAdmissionCapacity(
      env as unknown as Env,
      seeded.identity,
      'compatible_node_provisioning'
    );
    await expect(readWakeState(seeded.projectId, seeded.chatSessionId)).resolves.toMatchObject({
      wakePhase: 'waiting_for_node_capacity',
      waitReason: 'compatible_node_provisioning',
    });

    // Once the runner moves past the wait, the old cause is history, not progress.
    await env.DATABASE.prepare("UPDATE tasks SET execution_step = 'node_provisioning' WHERE id = ?")
      .bind(seeded.taskId)
      .run();
    await expect(readWakeState(seeded.projectId, seeded.chatSessionId)).resolves.toMatchObject({
      wakePhase: 'node_provisioning',
      waitReason: null,
      waitRetryAt: null,
    });
  });

  it('names the previous workspace until its deletion is proven, over the session route', async () => {
    const seeded = await seedSleepingSession('cleanup', {
      recoveryStatus: null,
      sleptWorkspaceStatus: 'stopping',
    });
    await expect(readWakeStateOverHttp(seeded)).resolves.toMatchObject({
      waitReason: 'previous_workspace_cleanup',
      waitRetryAt: null,
    });

    // The deletion fence releases the wake on proof, not on the status column
    // (`assertReplacementDeletionConfirmed`). Proof with the row still `stopping`
    // must clear the reason, or the label would outlast the thing it names.
    await env.DATABASE.prepare(
      `UPDATE workspaces SET runtime_deletion_confirmed_at = '2026-11-02T10:00:00.000Z' WHERE id = ?`
    )
      .bind(seeded.workspaceId)
      .run();
    const state = await readWakeStateOverHttp(seeded);
    expect(state?.waitReason ?? null).toBeNull();
  });

  it('names no cleanup cause when the row does not show a deletion in progress', async () => {
    // No proof, but the slept workspace is neither stopping nor a legacy tombstone:
    // the fence releases the wake unless the node's lifecycle object reports a
    // pending attempt, so the banner must not claim the wake is blocked on cleanup.
    const seeded = await seedSleepingSession('stopped-unproven', {
      recoveryStatus: null,
      sleptWorkspaceStatus: 'stopped',
    });
    const state = await readWakeStateOverHttp(seeded);
    expect(state?.waitReason ?? null).toBeNull();
  });

  it('accepts node termination proof as the fence does', async () => {
    const seeded = await seedSleepingSession('node-proof', {
      recoveryStatus: null,
      sleptWorkspaceStatus: 'stopping',
    });
    await env.DATABASE.prepare(
      `UPDATE nodes SET runtime_termination_confirmed_at = '2026-11-02T10:00:00.000Z' WHERE id = ?`
    )
      .bind(seeded.nodeId)
      .run();
    const state = await readWakeStateOverHttp(seeded);
    expect(state?.waitReason ?? null).toBeNull();
  });

  it('serves the admission reason and retry time to the browser', async () => {
    const seeded = await seedSleepingSession('http-capacity', {
      recoveryStatus: 'waking',
      sleptWorkspaceStatus: 'deleted',
    });
    const retryAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await waitForVmAdmissionCapacity(
      env as unknown as Env,
      seeded.identity,
      'provider_account_capacity',
      retryAt
    );
    const state = await readWakeStateOverHttp(seeded);
    expect(state).toMatchObject({
      recoveryStatus: 'waking',
      wakePhase: 'waiting_for_node_capacity',
      waitReason: 'provider_account_capacity',
    });
    expect(typeof state?.waitRetryAt).toBe('string');
  });
});
