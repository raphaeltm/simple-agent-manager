/** #2847: a follow-up before first placement is not a request to recover a slept VM. */
import { resolveDurableExecutionConfig } from '@simple-agent-manager/project-data/internal/do/durable-execution-config';
import { expireDuePromptDeliveries } from '@simple-agent-manager/project-data/internal/do/prompt-delivery';
import { buildVmPromptDeliveryCapabilitiesPath } from '@simple-agent-manager/shared';
import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { getNodeBackendBaseUrl } from '../../src/services/node-agent-readiness';
import * as placement from '../../src/services/placement-resolver';
import * as projectData from '../../src/services/project-data';
import * as recovery from '../../src/services/session-recovery';
import type { SubmitVmTaskInput } from '../../src/services/submit-vm-task';
import { persistVmTaskSession } from '../../src/services/submit-vm-task-effects';
import { resolveVmPromptDeliveryTarget } from '../../src/services/vm-prompt-delivery-target';
import {
  acceptedPromptResponse,
  versionedPromptCapabilities,
} from '../helpers/vm-prompt-delivery-fixtures';
import { projectStub, sqlRows, testEnv } from './helpers/agent-message-channels';
import {
  seedAgentSession,
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';
import { runDueDelivery } from './helpers/vm-prompt-delivery';

const config = resolveDurableExecutionConfig({});
afterEach(() => vi.restoreAllMocks());

async function startingConversation(status = 'queued') {
  const id = crypto.randomUUID();
  const userId = `user-${id}`;
  const projectId = `project-${id}`;
  const taskId = `task-${id}`;
  await seedUser(userId);
  await seedInstallation(id, userId);
  await seedProject(projectId, userId, id);
  await seedTask(taskId, projectId, userId, { status });
  // Exercise the primary web submission writer: it creates a workspace-less chat and
  // binds tasks.chat_session_id before returning it to the caller or starting the runner.
  const chatSessionId = await persistVmTaskSession(
    {
      env: testEnv,
      projectId,
      taskId,
      user: { id: userId },
      body: {},
      message: 'Initial task',
      setOperation: () => undefined,
      getOperation: () => 'session_create',
    } as SubmitVmTaskInput,
    drizzle(env.DATABASE, { schema }),
    'Waiting for first VM'
  );
  const stub = projectStub(projectId);
  expect(
    await env.DATABASE.prepare('SELECT chat_session_id FROM tasks WHERE id = ?')
      .bind(taskId)
      .first()
  ).toMatchObject({ chat_session_id: chatSessionId });
  return { id, userId, projectId, taskId, chatSessionId, stub };
}
type Fixture = Awaited<ReturnType<typeof startingConversation>>;
const resolve = (f: Fixture, allowWake = true) =>
  resolveVmPromptDeliveryTarget(
    testEnv,
    f.projectId,
    f.chatSessionId,
    undefined,
    async () => null,
    { allowWake }
  );

async function queueFollowup(f: Fixture) {
  await projectData.acceptPromptDelivery(testEnv, f.projectId, {
    targetSessionId: f.chatSessionId,
    displayContent: 'Add this detail to the task',
    senderType: 'human',
    senderId: f.userId,
    messageClass: 'deliver',
    sourceKind: 'user_followup',
    ttlMs: config.ttlMs,
  });
}
async function inbox(f: Fixture) {
  const [row] = await sqlRows<{
    delivery_state: string;
    delivery_attempts: number;
    expires_at: number;
    next_attempt_at: number;
    last_error: string | null;
  }>(
    f.stub,
    'SELECT delivery_state, delivery_attempts, expires_at, next_attempt_at, last_error FROM session_inbox WHERE target_session_id = ?',
    f.chatSessionId
  );
  return row!;
}

async function readyRuntime(f: Fixture) {
  const nodeId = `node-${f.id}`;
  const workspaceId = `workspace-${f.id}`;
  const agentSessionId = `agent-${f.id}`;
  await seedNode(nodeId, f.userId);
  await seedWorkspace(workspaceId, nodeId, f.userId, {
    projectId: f.projectId,
    chatSessionId: f.chatSessionId,
  });
  await seedAgentSession(agentSessionId, workspaceId, f.userId);
  await env.DATABASE.prepare(
    "UPDATE tasks SET status = 'in_progress', workspace_id = ? WHERE id = ?"
  )
    .bind(workspaceId, f.taskId)
    .run();
  await projectData.linkSessionToWorkspace(testEnv, f.projectId, f.chatSessionId, workspaceId);
  const prompts: string[] = [];
  let busy = true;
  const base = getNodeBackendBaseUrl(nodeId, testEnv);
  const passthrough = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (!request.url.startsWith(base)) return passthrough(input, init);
    if (new URL(request.url).pathname === buildVmPromptDeliveryCapabilitiesPath(workspaceId)) {
      return Response.json(versionedPromptCapabilities('first-runtime'));
    }
    if (new URL(request.url).pathname.endsWith('/prompt')) {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : await request.text());
      if (busy)
        return Response.json(
          {
            ...acceptedPromptResponse(agentSessionId, body.deliveryId, 'first-runtime', Date.now()),
            status: 'not_ready',
          },
          { status: 409 }
        );
      prompts.push(body.deliveryId);
      return Response.json(
        acceptedPromptResponse(agentSessionId, body.deliveryId, 'first-runtime', Date.now())
      );
    }
    return Response.json({ ok: true });
  });
  return {
    prompts,
    finishFirstTurn: () => {
      busy = false;
    },
  };
}

describe('follow-ups before first VM placement', () => {
  it.each(['draft', 'ready', 'queued', 'delegated'])(
    'holds %s without trying recovery or failing the chat',
    async (status) => {
      const f = await startingConversation(status);
      const wake = vi.spyOn(recovery, 'ensureSessionRecovery');
      await queueFollowup(f);
      expect(await runDueDelivery(f)).toMatchObject({
        kind: 'retry',
        reason: 'not_ready',
        error: 'Task is still starting; no workspace yet',
      });
      expect(wake).not.toHaveBeenCalled();
      expect(await inbox(f)).toMatchObject({ delivery_state: 'retry_wait' });
      expect(await f.stub.getSession(f.chatSessionId)).toMatchObject({ status: 'active' });
    }
  );

  it('survives more than the attempt cap, waits behind the first turn, then delivers', async () => {
    const f = await startingConversation();
    await queueFollowup(f);
    const expiry = (await inbox(f)).expires_at;
    for (let attempt = 0; attempt < config.maxAttempts + 2; attempt++) {
      expect(await runDueDelivery(f, (await inbox(f)).next_attempt_at ?? Date.now())).toMatchObject(
        {
          kind: 'retry',
          reason: 'not_ready',
        }
      );
      expect(await inbox(f)).toMatchObject({ delivery_state: 'retry_wait', expires_at: expiry });
      expect((await inbox(f)).delivery_attempts).toBeLessThan(config.maxAttempts);
    }
    const vm = await readyRuntime(f);
    expect(await runDueDelivery(f, (await inbox(f)).next_attempt_at)).toMatchObject({
      kind: 'retry',
      reason: 'busy',
    });
    expect(vm.prompts).toEqual([]);
    vm.finishFirstTurn();
    // The next backoff attempt reaches the newly idle VM without a second human message.
    expect(await runDueDelivery(f, (await inbox(f)).next_attempt_at)).toMatchObject({
      kind: 'accepted',
    });
    expect(vm.prompts).toHaveLength(1);
    expect(await inbox(f)).toMatchObject({ delivery_state: 'acked', expires_at: expiry });
  });

  it('expires a follow-up that is still waiting for its first VM', async () => {
    const f = await startingConversation();
    await queueFollowup(f);
    await runDueDelivery(f);
    const expiry = (await inbox(f)).expires_at;
    const expired = await runInDurableObject(f.stub, (_instance, state) =>
      expireDuePromptDeliveries(state.storage.sql, config, expiry)
    );
    expect(expired.expired).toBeGreaterThan(0);
    expect(await inbox(f)).toMatchObject({ delivery_state: 'expired', expires_at: expiry });
    expect(await runDueDelivery(f, expiry + 1)).toBeNull();
  });

  it.each(['in_progress', 'awaiting_followup', 'completed', 'failed', 'cancelled', 'sleeping'])(
    'keeps missing-runtime diagnostics for %s',
    async (status) => {
      const f = await startingConversation(status);
      expect(await resolve(f)).toMatchObject({
        kind: 'failed',
        reason: 'wake_refused',
        error: expect.stringContaining('sleeping_snapshot_missing'),
      });
    }
  );

  it("does not treat another project or another chat's queued task as startup", async () => {
    const f = await startingConversation();
    expect(await resolve({ ...f, projectId: `other-${f.id}` })).toMatchObject({
      kind: 'failed',
      reason: 'wake_refused',
    });
    expect(await resolve({ ...f, chatSessionId: `other-${f.id}` })).toMatchObject({
      kind: 'failed',
      reason: 'wake_refused',
    });
    expect(await resolve(f)).toMatchObject({ kind: 'retry' });
  });

  it.each([null, '2026-11-01T00:00:00Z'])(
    'distinguishes a checkpoint from retained sleep history (%s)',
    async (sleepingAt) => {
      const f = await startingConversation();
      await env.DATABASE.prepare(
        `INSERT INTO session_snapshots
      (id, project_id, user_id, chat_session_id, runtime, status, degradation, manifest_r2_key, expires_at, sleeping_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'vm', 'available', 'none', 'manifest', '2099-01-01T00:00:00Z', ?, datetime('now'), datetime('now'))`
      )
        .bind(`snapshot-${f.id}`, f.projectId, f.userId, f.chatSessionId, sleepingAt)
        .run();
      // Recovery is a separate lifecycle owner; this routing control stubs only its result.
      // Existing session-recovery-handoff and wake-handoff suites exercise the real owner.
      const wake = vi
        .spyOn(recovery, 'ensureSessionRecovery')
        .mockResolvedValue({ status: 'waking', taskId: f.taskId });
      if (sleepingAt) {
        expect(await resolve(f)).toEqual({
          kind: 'retry',
          reason: `Session is waking (${f.taskId})`,
        });
        expect(wake).toHaveBeenCalledOnce();
      } else {
        expect(await resolve(f)).toEqual({
          kind: 'retry',
          reason: 'Task is still starting; no workspace yet',
        });
        expect(wake).not.toHaveBeenCalled();
      }
    }
  );

  it('continues a real retained VM wake whose recovery task is queued with no linked workspace', async () => {
    const f = await startingConversation();
    const oldWorkspace = `retired-${f.id}`;
    await seedNode(`old-node-${f.id}`, f.userId);
    await seedWorkspace(oldWorkspace, `old-node-${f.id}`, f.userId, {
      projectId: f.projectId,
      status: 'deleted',
    });
    await env.DATABASE.prepare(
      `INSERT INTO session_snapshots
      (id, project_id, workspace_id, user_id, chat_session_id, runtime, status, degradation,
       manifest_r2_key, expires_at, sleeping_at, sleep_status, recovery_status, recovery_task_id,
       recovery_attempt_id, recovery_claimed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'vm', 'available', 'none', 'manifest', '2099-01-01T00:00:00Z',
        ?, 'sleeping', 'waking', ?, 'wake-attempt', ?, datetime('now'), datetime('now'))`
    )
      .bind(
        `snapshot-${f.id}`,
        f.projectId,
        oldWorkspace,
        f.userId,
        f.chatSessionId,
        new Date().toISOString(),
        f.taskId,
        new Date().toISOString()
      )
      .run();
    // Only cloud placement/credential discovery is substituted. The resolver, recovery
    // context, deletion fence and snapshot claim all execute against real D1.
    vi.spyOn(
      placement,
      'resolveTaskStartPlacementCredentialAttributionFromPlacement'
    ).mockImplementation(async (_db, plan) => ({
      placement: plan,
      effectiveProvider: 'hetzner',
      credential: { credentialSource: 'user', providerName: 'hetzner' },
      capacityPoolSelection: null,
      quotaCredentialSource: 'user',
      capacityPlacementSnapshot: null,
      credentialAttributionUserId: f.userId,
      credentialAttributionProjectId: null,
      credentialAttributionSource: 'user',
      credentialAttribution: { userId: f.userId, projectId: null, source: 'user' },
    }));
    expect(await resolve(f)).toEqual({ kind: 'retry', reason: `Session is waking (${f.taskId})` });
    expect(
      await env.DATABASE.prepare(
        'SELECT recovery_status, recovery_task_id FROM session_snapshots WHERE chat_session_id = ?'
      )
        .bind(f.chatSessionId)
        .first()
    ).toMatchObject({ recovery_status: 'waking', recovery_task_id: f.taskId });
  });

  it('preserves allowWake=false and skips recovery for a missing runtime', async () => {
    const f = await startingConversation();
    const wake = vi.spyOn(recovery, 'ensureSessionRecovery');
    expect(await resolve(f, false)).toEqual({ kind: 'retry', reason: 'session_not_awake' });
    expect(wake).not.toHaveBeenCalled();
  });
});
