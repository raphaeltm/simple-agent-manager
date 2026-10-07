import { buildVmPromptDeliveryCapabilitiesPath } from '@simple-agent-manager/shared';
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { getNodeBackendBaseUrl } from '../../src/services/node-agent-readiness';
import { signalSessionWakeReadyBestEffort } from '../../src/services/session-wake-ready';
import { DefaultVmPromptDeliveryAdapter } from '../../src/services/vm-prompt-delivery-adapter';
import {
  acceptedPromptResponse,
  versionedPromptCapabilities,
} from '../helpers/vm-prompt-delivery-fixtures';
import {
  seedAgentSession,
  seedInstallation,
  seedNode,
  seedProject,
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
  const chatSessionId = await stub.createSession(workspaceId, 'Wake ready');
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
  await runInDurableObject(stub, (instance, state) => {
    const internal = instance as unknown as {
      recalculateAlarm(): Promise<void>;
      wakeAlarmAt: number | null;
    };
    const originalRecalculate = internal.recalculateAlarm.bind(instance);
    internal.recalculateAlarm = async () => {
      await originalRecalculate();
      internal.wakeAlarmAt = await state.storage.getAlarm();
      // Capture the real alarm write, then drive its claim runner deterministically below.
      await state.storage.deleteAlarm();
    };
    acceptPromptDelivery(
      state.storage.sql,
      {},
      {
        deliveryId: 'first',
        targetSessionId: chatSessionId,
        displayContent: 'First real prompt',
        senderType: 'human',
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
  return { stub, input, nodeId };
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
      expect(await stub.signalSessionWakeReady(stale)).toBe(0);
      await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
    }
  );
});

describe('readiness RPC interleaving', () => {
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
