// FILE SIZE EXCEPTION: Shared real D1/DO wake fixture covers readiness, crash recovery and concurrency. See .claude/rules/18-file-size-limits.md
import { buildVmPromptDeliveryCapabilitiesPath } from '@simple-agent-manager/shared';
import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { ProjectData } from '../../src/durable-objects/project-data';
import { resolveDurableExecutionConfig } from '../../src/durable-objects/project-data/durable-execution-config';
import {
  acceptPromptDelivery,
  claimDuePromptDeliveries,
} from '../../src/durable-objects/project-data/prompt-delivery';
import { runPromptDeliveryClaim } from '../../src/durable-objects/project-data/prompt-delivery-runner';
import type { SessionWakeReadyInput } from '../../src/durable-objects/project-data/session-wake-ready';
import { notifyWakeSettled } from '../../src/durable-objects/task-runner/wake-progress-notifier';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { requireApproved, requireAuth } from '../../src/middleware/auth';
import { chatRoutes } from '../../src/routes/chat';
import { attachWakeState } from '../../src/routes/chat/wake-state';
import { getNodeBackendBaseUrl } from '../../src/services/node-agent-readiness';
import { wakeSessionForSnapshotRecovery } from '../../src/services/project-data';
import { completeSessionSnapshotRecoveryGeneration } from '../../src/services/session-snapshots';
import { signalSessionWakeReadyBestEffort } from '../../src/services/session-wake-ready';
import { DefaultVmPromptDeliveryAdapter } from '../../src/services/vm-prompt-delivery-adapter';
import { resolveVmPromptDeliveryTarget } from '../../src/services/vm-prompt-delivery-target';
import {
  acceptedPromptResponse,
  versionedPromptCapabilities,
} from '../helpers/vm-prompt-delivery-fixtures';
import {
  seedAgentSession,
  seedInstallation,
  seedNode,
  seedProject,
  seedSignedInUser,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';
import type { VmAgentContainerTestDouble } from './support/vm-agent-container-double';

const bindings = { ...env, CF_CONTAINER_ENABLED: 'true' } as unknown as Env;
const config = resolveDurableExecutionConfig({});
afterEach(() => {
  vi.restoreAllMocks();
});

async function fixture(runtime: 'vm' | 'cf-container') {
  const prefix = crypto.randomUUID();
  const projectId = `${prefix}-project`,
    userId = `${prefix}-user`,
    nodeId = `${prefix}-node`;
  const workspaceId = `${prefix}-workspace`,
    agentSessionId = `${prefix}-agent`,
    taskId = `${prefix}-task`;
  await seedUser(userId);
  await seedInstallation(`${prefix}-installation`, userId);
  await seedProject(projectId, userId, `${prefix}-installation`);
  await seedNode(nodeId, userId);
  await env.DATABASE.prepare(
    'UPDATE nodes SET runtime = ?, runtime_incarnation_id = ? WHERE id = ?'
  )
    .bind(runtime, 'incarnation', nodeId)
    .run();
  const stub = env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectData>;
  await stub.ensureProjectId(projectId);
  // The prompts below come from the person who created the chat, as sendChat's always do.
  const chatSessionId = await stub.createSession(workspaceId, 'Wake ready', taskId, userId);
  await seedWorkspace(workspaceId, nodeId, userId, { projectId, chatSessionId });
  await seedAgentSession(agentSessionId, workspaceId, userId);
  await seedTask(taskId, projectId, userId, { status: 'in_progress', chatSessionId, workspaceId });
  await env.DATABASE.prepare(
    `INSERT INTO session_snapshots
    (id, project_id, workspace_id, user_id, chat_session_id, runtime, status, degradation, manifest_r2_key, expires_at,
     recovery_status, recovery_task_id, recovery_workspace_id, recovery_attempt_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'available', 'none', 'manifest', '2099-01-01T00:00:00Z', 'restored', ?, ?, 'wake-1', datetime('now'), datetime('now'))`
  )
    .bind(
      `${prefix}-snapshot`,
      projectId,
      workspaceId,
      userId,
      chatSessionId,
      runtime,
      taskId,
      workspaceId
    )
    .run();
  const input: SessionWakeReadyInput = {
    projectId,
    chatSessionId,
    workspaceId,
    agentSessionId,
    fence:
      runtime === 'vm'
        ? { runtime, taskId, recoveryAttemptId: 'wake-1' }
        : { runtime, nodeId, runtimeIncarnationId: 'incarnation' },
  };
  await runInDurableObject(stub, async (instance, state) => {
    const internal = instance as unknown as {
      wakeAlarmAt: number | null;
    };
    await state.storage.deleteAlarm();
    // Keep the production scheduler, capture its requested deadline, and drive the claim
    // runner explicitly. Arming "now" and deleting after await races automatic delivery.
    vi.spyOn(state.storage, 'setAlarm').mockImplementation(async (scheduledTime) => {
      internal.wakeAlarmAt =
        scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
    });
    acceptPromptDelivery(
      state.storage.sql,
      {},
      {
        deliveryId: 'first',
        targetSessionId: chatSessionId,
        displayContent: 'First real prompt',
        senderType: 'human',
        senderId: userId,
        sourceKind: 'user_followup',
        ttlMs: config.ttlMs,
      }
    );
    acceptPromptDelivery(
      state.storage.sql,
      {},
      {
        deliveryId: 'second',
        targetSessionId: chatSessionId,
        displayContent: 'Second real prompt',
        senderType: 'human',
        senderId: userId,
        sourceKind: 'user_followup',
        ttlMs: config.ttlMs,
      }
    );
    state.storage.sql.exec(
      "UPDATE session_inbox SET delivery_state = 'retry_wait', delivery_attempts = ?, next_attempt_at = ?",
      config.maxAttempts - 1,
      Date.now() + config.retryMaxMs
    );
  });
  return { stub, input, nodeId, userId };
}

async function addReadinessDistractors(input: SessionWakeReadyInput, userId: string) {
  const foreignUserId = `${input.agentSessionId}-foreign-user`;
  await seedUser(foreignUserId);
  await seedAgentSession(`${input.agentSessionId}-stopped`, input.workspaceId, userId, {
    status: 'stopped',
    createdAt: '2098-01-01T00:00:00Z',
  });
  await seedAgentSession(`${input.agentSessionId}-foreign`, input.workspaceId, foreignUserId, {
    status: 'running',
    createdAt: '2099-01-01T00:00:00Z',
  });
}

describe('wake completion → D1 authority → DO scheduling → HTTP prompt admission', () => {
  it.each(['vm', 'cf-container'] as const)(
    'delivers a saturated %s queue immediately once, in original order',
    async (runtime) => {
      const { stub, input, nodeId } = await fixture(runtime);
      if (runtime === 'vm') {
        const originalFetch = globalThis.fetch;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
          const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
          if (!target.startsWith(getNodeBackendBaseUrl(nodeId, bindings)))
            return originalFetch(url, options);
          if (target.endsWith(buildVmPromptDeliveryCapabilitiesPath(input.workspaceId)))
            return Response.json(versionedPromptCapabilities('test-runtime'));
          expect(target).toContain(`/agent-sessions/${input.agentSessionId}/prompt`);
          const body = JSON.parse(String(options?.body));
          expect(body).toMatchObject({ deliveryId: 'first', prompt: 'First real prompt' });
          return Response.json(
            acceptedPromptResponse(input.agentSessionId, 'first', 'test-runtime', Date.now())
          );
        });
        expect(
          await notifyWakeSettled({
            env: bindings,
            projectId: input.projectId,
            chatSessionId: input.chatSessionId,
            status: 'restored',
            readiness: input,
          })
        ).toBe(true);
      } else {
        expect(await signalSessionWakeReadyBestEffort(bindings, input)).toBe(true);
      }
      await runInDurableObject(stub, async (_instance, state) => {
        // Stop automatic alarm delivery; invoke the production claim runner deterministically.
        expect((_instance as unknown as { wakeAlarmAt: number }).wakeAlarmAt).toBeLessThan(
          Date.now() + config.retryBaseMs
        );
        await state.storage.deleteAlarm();
        const claims = claimDuePromptDeliveries(state.storage.sql, config);
        expect(claims.map((c) => c.message.id)).toEqual(['first']);
        expect(claimDuePromptDeliveries(state.storage.sql, config)).toEqual([]);
        const result = await runPromptDeliveryClaim(
          state.storage.sql,
          bindings,
          config,
          claims[0]!,
          new DefaultVmPromptDeliveryAdapter(bindings),
          {
            projectId: input.projectId,
            recalculateAlarm: async () => {},
            broadcastEvent: () => {},
            armIdleCleanup: () => {},
            nudgeDeliveries: () => 0,
            scheduleSummarySync: () => {},
          }
        );
        expect(result.kind).toBe('accepted');
        expect(
          claimDuePromptDeliveries(state.storage.sql, config).map((c) => c.message.id)
        ).toEqual(['second']);
      });
      expect(await stub.signalSessionWakeReady(input)).toBe(0);
      await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
      if (runtime === 'cf-container') {
        const container = env.VM_AGENT_CONTAINER.get(
          env.VM_AGENT_CONTAINER.idFromName(nodeId.toLowerCase())
        ) as DurableObjectStub<VmAgentContainerTestDouble>;
        expect(await container.__promptSubmissions()).toEqual(['first']);
      }
      const stale = {
        ...input,
        fence:
          runtime === 'vm'
            ? {
                runtime,
                taskId: input.fence.runtime === 'vm' ? input.fence.taskId : '',
                recoveryAttemptId: 'obsolete',
              }
            : { runtime, nodeId, runtimeIncarnationId: 'obsolete' },
      } satisfies SessionWakeReadyInput;
      expect(await stub.signalSessionWakeReady(stale)).toBeNull();
      await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
    }
  );
});

describe('readiness RPC interleaving', () => {
  it('read-only steering never activates or nudges a committed wake and rejects a rebound task', async () => {
    const { stub, input } = await fixture('vm');
    await stub.sleepSession(input.chatSessionId);
    const activation = vi.fn();
    const sideEffectGuard = vi.fn(async () => {
      throw new Error('read-only steering cannot authorize recovery side effects');
    });
    const readOnlyBindings = {
      ...bindings,
      PROJECT_DATA: { idFromName: activation, get: activation },
    } as unknown as Env;
    const resolve = () =>
      resolveVmPromptDeliveryTarget(
        readOnlyBindings,
        input.projectId,
        input.chatSessionId,
        undefined,
        sideEffectGuard,
        { allowWake: false }
      );
    expect(await resolve()).toMatchObject({ kind: 'ready' });
    expect(await stub.getSession(input.chatSessionId)).toMatchObject({ status: 'sleeping' });
    await env.DATABASE.prepare('UPDATE tasks SET workspace_id = NULL WHERE id = ?')
      .bind(input.fence.runtime === 'vm' ? input.fence.taskId : '')
      .run();
    expect(await resolve()).toMatchObject({ kind: 'retry' });
    expect(activation).not.toHaveBeenCalled();
    expect(sideEffectGuard).not.toHaveBeenCalled();
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec('SELECT * FROM session_wake_readiness').toArray()).toEqual([]);
      expect(
        state.storage.sql
          .exec('SELECT next_attempt_at FROM session_inbox WHERE id = ?', 'first')
          .toArray()[0]?.next_attempt_at
      ).toBeGreaterThan(Date.now());
      return state.storage.deleteAlarm();
    });
  });

  it('returns null for rejected local authority while a valid duplicate zero remains accepted', async () => {
    const { stub, input } = await fixture('vm');
    expect(await stub.signalSessionWakeReady(input)).toBeGreaterThan(0);
    expect(await stub.signalSessionWakeReady(input)).toBe(0);
    expect(await signalSessionWakeReadyBestEffort(bindings, input)).toBe(true);
    await stub.stopSession(input.chatSessionId, { deferAlarm: true });
    expect(await stub.signalSessionWakeReady(input)).toBeNull();
    expect(await signalSessionWakeReadyBestEffort(bindings, input)).toBe(false);
    expect(
      await resolveVmPromptDeliveryTarget(
        bindings,
        input.projectId,
        input.chatSessionId,
        undefined,
        async () => null
      )
    ).toMatchObject({ kind: 'retry' });
    expect(await stub.getSession(input.chatSessionId)).toMatchObject({ status: 'stopped' });
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
  });

  it('keeps restored VM chat sleeping until handoff, then repairs a lost notification by hydration', async () => {
    const { stub, input, userId } = await fixture('vm');
    await addReadinessDistractors(input, userId);
    await runInDurableObject(stub, (_instance, state) => {
      // Hydration must converge even when there is no inbox alarm to repair it.
      state.storage.sql.exec('DELETE FROM session_inbox');
    });
    await env.DATABASE.prepare(
      "UPDATE tasks SET status = 'delegated', execution_step = 'agent_session' WHERE id = ?"
    )
      .bind(input.fence.runtime === 'vm' ? input.fence.taskId : '')
      .run();
    await env.DATABASE.prepare(
      `UPDATE session_snapshots SET recovery_status = 'waking',
      sleep_status = 'sleeping', sleeping_at = datetime('now') WHERE chat_session_id = ?`
    )
      .bind(input.chatSessionId)
      .run();
    expect(await stub.sleepSession(input.chatSessionId)).toBe(true);
    // The runner links the workspace, commits the real restore writer, then crashes before handoff.
    const taskId = input.fence.runtime === 'vm' ? input.fence.taskId : '';
    const db = drizzle(env.DATABASE, { schema });
    expect(
      await wakeSessionForSnapshotRecovery(
        bindings,
        input.projectId,
        input.chatSessionId,
        input.workspaceId,
        taskId,
        { deferActivation: true, recoveryAttemptId: 'wake-1' }
      )
    ).toBe(true);
    expect(
      await completeSessionSnapshotRecoveryGeneration(
        db,
        input.chatSessionId,
        taskId,
        input.workspaceId,
        undefined,
        'wake-1'
      )
    ).not.toBeNull();
    expect(
      await env.DATABASE.prepare(
        'SELECT sleeping_at, sleep_status FROM session_snapshots WHERE chat_session_id = ?'
      )
        .bind(input.chatSessionId)
        .first()
    ).toMatchObject({ sleeping_at: null, sleep_status: null });
    // Replay after restart cannot require the sleeping markers that restore just cleared.
    expect(
      await wakeSessionForSnapshotRecovery(
        bindings,
        input.projectId,
        input.chatSessionId,
        input.workspaceId,
        input.fence.runtime === 'vm' ? input.fence.taskId : '',
        { deferActivation: true, recoveryAttemptId: 'wake-1' }
      )
    ).toBe(true);
    expect(await stub.getSession(input.chatSessionId)).toMatchObject({
      status: 'sleeping',
      workspaceId: input.workspaceId,
    });
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.use('/api/projects/*', requireAuth(), requireApproved());
    app.route('/api/projects/:projectId/sessions', chatRoutes);
    const cookie = await seedSignedInUser(userId);
    const readChat = async () => {
      const response = await app.request(
        `/api/projects/${input.projectId}/sessions/${input.chatSessionId}`,
        { headers: { Cookie: cookie } },
        bindings
      );
      expect(response.status).toBe(200);
      return response.json() as Promise<{
        session: { status: string };
        state: { recoveryStatus: string };
      }>;
    };
    const args = {
      projectId: input.projectId,
      sessionId: input.chatSessionId,
      sessionStatus: 'sleeping',
      env: bindings,
    };
    expect(await attachWakeState(db, null, args)).toMatchObject({
      recoveryStatus: 'waking',
      wakePhase: 'agent_session',
    });
    expect(await readChat()).toMatchObject({
      session: { status: 'sleeping' },
      state: { recoveryStatus: 'waking' },
    });
    expect(await stub.signalSessionWakeReady(input)).toBeNull();
    expect(await stub.getSession(input.chatSessionId)).toMatchObject({ status: 'sleeping' });
    await env.DATABASE.prepare(
      "UPDATE tasks SET status = 'in_progress', execution_step = 'running' WHERE id = ?"
    )
      .bind(input.fence.runtime === 'vm' ? input.fence.taskId : '')
      .run();
    // No runner callback is replayed. The persisted committed rows repair visibility.
    expect(await readChat()).toMatchObject({
      session: { status: 'active' },
      state: { recoveryStatus: 'restored' },
    });
    expect(await stub.getSession(input.chatSessionId)).toMatchObject({ status: 'active' });
    expect(await stub.signalSessionWakeReady(input)).toBe(0);
    await stub.sleepSession(input.chatSessionId);
    expect(await stub.signalSessionWakeReady(input)).toBeNull();
    expect(await stub.getSession(input.chatSessionId)).toMatchObject({ status: 'sleeping' });
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
  });

  it('durable target retries repair lost activation without a browser or another accepted message', async () => {
    const { stub, input, userId } = await fixture('vm');
    await addReadinessDistractors(input, userId);
    await stub.sleepSession(input.chatSessionId);
    const target = await resolveVmPromptDeliveryTarget(
      bindings,
      input.projectId,
      input.chatSessionId,
      undefined,
      async () => null
    );
    expect(target).toMatchObject({
      kind: 'ready',
      target: { workspaceId: input.workspaceId, agentSessionId: input.agentSessionId },
    });
    expect(await stub.getSession(input.chatSessionId)).toMatchObject({ status: 'active' });
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec('SELECT id FROM session_inbox ORDER BY id')
          .toArray()
          .map((row) => row.id)
      ).toEqual(['first', 'second']);
      return state.storage.deleteAlarm();
    });
  });

  it('exact restored replay rejects stale attempts and terminal tasks without activating the chat', async () => {
    const { stub, input } = await fixture('vm');
    await stub.sleepSession(input.chatSessionId);
    const taskId = input.fence.runtime === 'vm' ? input.fence.taskId : '';
    for (const recoveryAttemptId of ['stale', undefined]) {
      expect(
        await wakeSessionForSnapshotRecovery(
          bindings,
          input.projectId,
          input.chatSessionId,
          input.workspaceId,
          taskId,
          { deferActivation: true, recoveryAttemptId }
        )
      ).toBe(false);
    }
    await env.DATABASE.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?")
      .bind(taskId)
      .run();
    expect(
      await wakeSessionForSnapshotRecovery(
        bindings,
        input.projectId,
        input.chatSessionId,
        input.workspaceId,
        taskId,
        { deferActivation: true, recoveryAttemptId: 'wake-1' }
      )
    ).toBe(false);
    expect(await stub.signalSessionWakeReady(input)).toBeNull();
    expect(await stub.getSession(input.chatSessionId)).toMatchObject({ status: 'sleeping' });
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
  });

  it.each(['stop', 'relink-and-sleep'] as const)(
    'a concurrent %s wins over a suspended VM readiness read',
    async (action) => {
      const { stub, input } = await fixture('vm');
      await stub.sleepSession(input.chatSessionId);
      await runInDurableObject(stub, async (instance, state) => {
        const internal = instance as unknown as { env: Env };
        const original = internal.env.DATABASE;
        let release!: () => void;
        let readStarted!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started = new Promise<void>((resolve) => {
          readStarted = resolve;
        });
        internal.env.DATABASE = {
          prepare(query: string) {
            const prepared = original.prepare(query);
            if (!query.startsWith('SELECT 1 AS ready')) return prepared;
            return {
              bind(...values: unknown[]) {
                const bound = prepared.bind(...values);
                return {
                  async first() {
                    const result = await bound.first();
                    readStarted();
                    await held;
                    return result;
                  },
                };
              },
            };
          },
        } as unknown as D1Database;
        try {
          const signal = instance.signalSessionWakeReady(input);
          await started;
          if (action === 'stop') {
            expect(await instance.stopSession(input.chatSessionId, { deferAlarm: true })).toBe(
              true
            );
          } else {
            expect(
              await instance.wakeSession(input.chatSessionId, 'new-workspace', 'new-task')
            ).toBe(true);
            expect(await instance.sleepSession(input.chatSessionId)).toBe(true);
          }
          release();
          expect(await signal).toBeNull();
          expect(await instance.getSession(input.chatSessionId)).toMatchObject(
            action === 'stop'
              ? { status: 'stopped' }
              : { status: 'sleeping', workspaceId: 'new-workspace' }
          );
          expect(state.storage.sql.exec('SELECT * FROM session_wake_readiness').toArray()).toEqual(
            []
          );
        } finally {
          release();
          internal.env.DATABASE = original;
          await state.storage.deleteAlarm();
        }
      });
    }
  );

  it('serializes deferred old authority reads with new fence writes and recovers after a failed read', async () => {
    const { stub, input, nodeId } = await fixture('cf-container');
    await runInDurableObject(stub, async (instance, state) => {
      const internal = instance as unknown as { env: Env };
      const original = internal.env.DATABASE;
      let release!: () => void;
      let readStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        readStarted = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reads = 0;
      internal.env.DATABASE = {
        prepare(query: string) {
          const prepared = original.prepare(query);
          if (!query.startsWith('SELECT 1 AS ready')) return prepared;
          return {
            bind(...values: unknown[]) {
              const bound = prepared.bind(...values);
              return {
                async first() {
                  const readIndex = ++reads;
                  const result = await bound.first();
                  if (readIndex === 1) {
                    readStarted();
                    await held;
                  }
                  return result;
                },
              };
            },
          };
        },
      } as unknown as D1Database;
      try {
        const old = instance.signalSessionWakeReady(input);
        await started;
        await original
          .prepare("UPDATE nodes SET runtime_incarnation_id = 'new-incarnation' WHERE id = ?")
          .bind(nodeId)
          .run();
        const newer: SessionWakeReadyInput = {
          ...input,
          fence: { runtime: 'cf-container', nodeId, runtimeIncarnationId: 'new-incarnation' },
        };
        const current = instance.signalSessionWakeReady(newer);
        // A newer read cannot pass the suspended old read and then have its dedup state overwritten.
        await Promise.resolve();
        await Promise.resolve();
        expect(reads).toBe(1);
        release();
        await Promise.all([old, current]);
        expect(
          state.storage.sql
            .exec(
              'SELECT fence FROM session_wake_readiness WHERE session_id = ?',
              input.chatSessionId
            )
            .toArray()[0]?.fence
        ).toBe(JSON.stringify(newer.fence));
        expect(await instance.signalSessionWakeReady(newer)).toBe(0);
        internal.env.DATABASE = {
          prepare() {
            throw new Error('Temporary D1 failure');
          },
        } as unknown as D1Database;
        await expect(instance.signalSessionWakeReady(newer)).rejects.toThrow(
          'Temporary D1 failure'
        );
        internal.env.DATABASE = original;
        expect(await instance.signalSessionWakeReady(newer)).toBe(0);
      } finally {
        release();
        internal.env.DATABASE = original;
        await state.storage.deleteAlarm();
      }
    });
  });
});
