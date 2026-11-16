// FILE SIZE EXCEPTION: Shared real D1/DO fixture covers handoff authority and captured-runtime races. See .claude/rules/18-file-size-limits.md
/**
 * The delivery target's wake-handoff gate, against real D1 rows (rule 28: a guard that is a
 * SQL read is tested on a real SQL engine). Each conjunct of `isVmWakeHandoffPending` has a
 * case that discriminates it: the claim status, the recovery workspace, the claiming task's
 * status and the runtime. The claiming task is joined inside the workspace's project, so a
 * claim naming another project's task reads as no claiming task (rule 11). The real-ordering
 * wake test is `vm-wake-event-delivery-handoff.test.ts`.
 */
import { resolveDurableExecutionConfig } from '@simple-agent-manager/project-data/internal/do/durable-execution-config';
import type { ProjectData } from '@simple-agent-manager/project-data/internal/do/index';
import {
  acceptPromptDelivery,
  claimDuePromptDeliveries,
} from '@simple-agent-manager/project-data/internal/do/prompt-delivery';
import { runPromptDeliveryClaim } from '@simple-agent-manager/project-data/internal/do/prompt-delivery-runner';
import type { SessionWakeReadyInput } from '@simple-agent-manager/project-data/internal/do/session-wake-ready';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { resolveVmPromptDeliveryTarget } from '../../src/services/vm-prompt-delivery-target';
import {
  seedAgentSession,
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

interface GateCase {
  name: string;
  runtime: 'vm' | 'cf-container';
  /** Null means the conversation has never slept, so it has no snapshot row. */
  recoveryStatus: 'waking' | 'restored' | 'failed' | null;
  recoveryWorkspace: 'target' | 'older' | null;
  taskStatus: string;
  /**
   * Status of a task in another project that the claim names instead of this conversation's
   * task. Unset means the claim names this conversation's task.
   */
  foreignClaimTaskStatus?: string;
  /** The restore belongs to a distinct earlier task, not a rebound current wake. */
  historicalClaimTask?: boolean;
  held: boolean;
}

const CASES: GateCase[] = [
  {
    name: 'claimed wake whose task is queued',
    runtime: 'vm',
    recoveryStatus: 'waking',
    recoveryWorkspace: null,
    taskStatus: 'queued',
    held: true,
  },
  {
    name: 'claimed wake delegated to this workspace',
    runtime: 'vm',
    recoveryStatus: 'waking',
    recoveryWorkspace: 'target',
    taskStatus: 'delegated',
    held: true,
  },
  {
    name: 'restored snapshot before the handoff commits',
    runtime: 'vm',
    recoveryStatus: 'restored',
    recoveryWorkspace: 'target',
    taskStatus: 'delegated',
    held: true,
  },
  {
    name: 'committed handoff',
    runtime: 'vm',
    recoveryStatus: 'restored',
    recoveryWorkspace: 'target',
    taskStatus: 'in_progress',
    held: false,
  },
  {
    name: 'restore left by an older wake on another workspace',
    runtime: 'vm',
    recoveryStatus: 'restored',
    recoveryWorkspace: 'older',
    taskStatus: 'in_progress',
    historicalClaimTask: true,
    held: false,
  },
  {
    name: 'current claiming task rebound away from its restored workspace',
    runtime: 'vm',
    recoveryStatus: 'restored',
    recoveryWorkspace: 'older',
    taskStatus: 'in_progress',
    held: false,
  },
  {
    name: 'delegated current task rebound away from its restored workspace',
    runtime: 'vm',
    recoveryStatus: 'restored',
    recoveryWorkspace: 'older',
    taskStatus: 'delegated',
    held: false,
  },
  {
    name: 'claim whose task already returned to sleep',
    runtime: 'vm',
    recoveryStatus: 'waking',
    recoveryWorkspace: 'target',
    taskStatus: 'sleeping',
    held: false,
  },
  {
    name: 'failed wake claim',
    runtime: 'vm',
    recoveryStatus: 'failed',
    recoveryWorkspace: 'target',
    taskStatus: 'delegated',
    held: false,
  },
  {
    name: 'conversation that never slept',
    runtime: 'vm',
    recoveryStatus: null,
    recoveryWorkspace: null,
    taskStatus: 'delegated',
    held: false,
  },
  {
    name: 'Instant runtime woken in place',
    runtime: 'cf-container',
    recoveryStatus: 'restored',
    recoveryWorkspace: 'target',
    taskStatus: 'queued',
    held: false,
  },
  {
    name: "claim naming another project's in-flight task",
    runtime: 'vm',
    recoveryStatus: 'waking',
    recoveryWorkspace: 'target',
    taskStatus: 'in_progress',
    foreignClaimTaskStatus: 'delegated',
    held: false,
  },
];

async function seedDeliveryTarget(testCase: GateCase) {
  const prefix = crypto.randomUUID();
  const userId = `${prefix}-user`;
  const projectId = `${prefix}-project`;
  const nodeId = `${prefix}-node`;
  const workspaceId = `${prefix}-workspace`;
  const olderWorkspaceId = `${prefix}-older-workspace`;
  const taskId = `${prefix}-task`;
  const agentSessionId = `${prefix}-agent`;
  const chatSessionId = `${prefix}-chat`;
  await seedUser(userId);
  await seedInstallation(`${prefix}-installation`, userId);
  await seedProject(projectId, userId, `${prefix}-installation`);
  const stub = env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectData>;
  await stub.ensureProjectId(projectId);
  const publicTaskId = taskId;
  expect(
    await stub.createSession(workspaceId, 'Wake handoff', publicTaskId, userId, chatSessionId)
  ).toBe(chatSessionId);
  if (testCase.held) await stub.sleepSession(chatSessionId);
  await seedNode(nodeId, userId);
  await env.DATABASE.prepare('UPDATE nodes SET runtime = ? WHERE id = ?')
    .bind(testCase.runtime, nodeId)
    .run();
  await seedWorkspace(olderWorkspaceId, nodeId, userId, {
    projectId,
    status: 'deleted',
    updatedAt: '2026-01-01T00:00:00Z',
  });
  await env.DATABASE.prepare(
    "UPDATE workspaces SET runtime_deletion_confirmed_at = '2026-01-01T00:00:00Z' WHERE id = ?"
  )
    .bind(olderWorkspaceId)
    .run();
  await seedWorkspace(workspaceId, nodeId, userId, {
    projectId,
    chatSessionId,
    status: 'running',
  });
  await seedAgentSession(agentSessionId, workspaceId, userId);
  await seedTask(taskId, projectId, userId, {
    status: testCase.taskStatus,
    chatSessionId,
    workspaceId,
  });
  let claimTaskId = taskId;
  if (testCase.historicalClaimTask) {
    claimTaskId = `${prefix}-historical-task`;
    await seedTask(claimTaskId, projectId, userId, {
      status: 'delegated',
      workspaceId: olderWorkspaceId,
    });
  }
  if (testCase.foreignClaimTaskStatus) {
    const foreignProjectId = `${prefix}-foreign-project`;
    claimTaskId = `${prefix}-foreign-task`;
    await seedProject(foreignProjectId, userId, `${prefix}-installation`);
    await seedTask(claimTaskId, foreignProjectId, userId, {
      status: testCase.foreignClaimTaskStatus,
    });
  }
  if (testCase.recoveryStatus) {
    const recoveryWorkspaceId =
      testCase.recoveryWorkspace === 'target'
        ? workspaceId
        : testCase.recoveryWorkspace === 'older'
          ? olderWorkspaceId
          : null;
    await env.DATABASE.prepare(
      `INSERT INTO session_snapshots
         (id, project_id, workspace_id, user_id, chat_session_id, runtime, status, degradation,
          manifest_r2_key, expires_at, recovery_status, recovery_task_id, recovery_attempt_id,
          recovery_workspace_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'available', 'none', 'manifest', '2099-01-01T00:00:00Z',
               ?, ?, 'wake-1', ?, datetime('now'), datetime('now'))`
    )
      .bind(
        `${prefix}-snapshot`,
        projectId,
        olderWorkspaceId,
        userId,
        chatSessionId,
        testCase.runtime,
        testCase.recoveryStatus,
        claimTaskId,
        recoveryWorkspaceId
      )
      .run();
  }
  return {
    projectId,
    chatSessionId,
    workspaceId,
    olderWorkspaceId,
    nodeId,
    agentSessionId,
    userId,
    taskId,
    claimTaskId,
    publicTaskId,
    stub,
  };
}

describe('real delivery runner during a VM wake handoff', () => {
  it.each(CASES)('$name: held=$held', async (testCase) => {
    const target = await seedDeliveryTarget(testCase);
    await runInDurableObject(target.stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
      acceptPromptDelivery(
        state.storage.sql,
        {},
        {
          deliveryId: 'handoff',
          targetSessionId: target.chatSessionId,
          displayContent: 'Preserve accepted handoff intent',
          senderType: 'human',
          senderId: target.userId,
          sourceKind: 'user_followup',
        }
      );
      const config = resolveDurableExecutionConfig({});
      const [claim] = claimDuePromptDeliveries(state.storage.sql, config);
      expect(claim).toBeDefined();
      // Drive the production runner's local-active predicate into the real target resolver.
      // Transport is outside this SQL gate test; the accepted HTTP path is covered in session-wake-ready.
      let resolution: Awaited<ReturnType<typeof resolveVmPromptDeliveryTarget>> | undefined;
      const submit = async (
        input: import('@simple-agent-manager/project-data').VmPromptDeliveryAdapterInput
      ) => {
        resolution = await resolveVmPromptDeliveryTarget(
          env as unknown as Env,
          input.projectId,
          input.claim.message.targetSessionId,
          input.sourceTaskGuard,
          input.beforeSideEffect,
          { isSessionActive: input.isSessionActive }
        );
        return {
          kind: 'retry' as const,
          reason: 'not_ready' as const,
          error: 'Transport deliberately outside gate fixture',
          runtimeIdentity: null,
          capabilities: null,
        };
      };
      await runPromptDeliveryClaim(
        state.storage.sql,
        env as unknown as Env,
        config,
        claim!,
        { submit, reconcile: submit },
        {
          projectId: target.projectId,
          recalculateAlarm: async () => {},
          broadcastEvent: () => {},
          armIdleCleanup: () => {},
          nudgeDeliveries: () => 0,
          scheduleSummarySync: () => {},
        }
      );
      expect(resolution).toMatchObject(
        testCase.held
          ? {
              kind: 'retry',
              reason: `Session is waking (${target.taskId}); agent handoff not committed`,
            }
          : {
              kind: 'ready',
              target: { workspaceId: target.workspaceId, runtime: testCase.runtime },
            }
      );
      expect(
        state.storage.sql
          .exec('SELECT status,workspace_id FROM chat_sessions WHERE id=?', target.chatSessionId)
          .toArray()
      ).toEqual([
        { status: testCase.held ? 'sleeping' : 'active', workspace_id: target.workspaceId },
      ]);
      if (testCase.historicalClaimTask)
        expect(state.storage.sql.exec('SELECT * FROM session_wake_readiness').toArray()).toEqual(
          []
        );
      await state.storage.deleteAlarm();
    });
  });
});

const COMMITTED_CASE: GateCase = {
  name: 'committed restore awaiting activation',
  runtime: 'vm',
  recoveryStatus: 'restored',
  recoveryWorkspace: 'older',
  taskStatus: 'in_progress',
  historicalClaimTask: true,
  held: false,
};

/** Suspend only after real SQL captured the target; every subsequent read stays real. */
async function resolveAfterTargetLookup(
  target: Awaited<ReturnType<typeof seedDeliveryTarget>>,
  allowWake: boolean,
  mutate: () => Promise<void>
) {
  let captured = false;
  let sideEffectGuards = 0;
  const bindings = {
    ...env,
    DATABASE: {
      prepare(query: string) {
        const prepared = env.DATABASE.prepare(query);
        if (!query.startsWith('SELECT w.id AS workspace_id')) return prepared;
        return {
          bind(...values: unknown[]) {
            const bound = prepared.bind(...values);
            return {
              async first() {
                const row = await bound.first();
                expect(row).toMatchObject({ workspace_id: target.workspaceId });
                expect(captured).toBe(false);
                captured = true;
                await mutate();
                return row;
              },
            };
          },
        };
      },
    } as unknown as D1Database,
  } as unknown as Env;
  try {
    const resolution = await resolveVmPromptDeliveryTarget(
      bindings,
      target.projectId,
      target.chatSessionId,
      undefined,
      async () => {
        sideEffectGuards++;
        return null;
      },
      { allowWake }
    );
    expect(captured).toBe(true);
    // A stale primary capture fails before activation.
    expect(sideEffectGuards).toBe(0);
    // Rejected captures never certify a wake as current.
    await runInDurableObject(target.stub, (_instance, state) => {
      expect(state.storage.sql.exec('SELECT * FROM session_wake_readiness').toArray()).toEqual([]);
    });
    return resolution;
  } finally {
    await runInDurableObject(target.stub, (_instance, state) => state.storage.deleteAlarm());
  }
}

describe('committed current restore authority after optimistic target lookup', () => {
  it.each([
    { name: 'node assignment', allowWake: true, changeNode: true },
    { name: 'node assignment', allowWake: false, changeNode: true },
    { name: 'workspace generation', allowWake: true, changeNode: false },
    { name: 'workspace generation', allowWake: false, changeNode: false },
  ])(
    'rejects a changed $name before activating the chat, allowWake=$allowWake',
    async ({ allowWake, changeNode }) => {
      const target = await seedDeliveryTarget({
        ...COMMITTED_CASE,
        historicalClaimTask: false,
        recoveryWorkspace: 'target',
        held: true,
      });
      const replacementNodeId = `${target.nodeId}-replacement`;
      await seedNode(replacementNodeId, target.userId);
      await env.DATABASE.prepare('UPDATE workspaces SET callback_generation = ? WHERE id = ?')
        .bind('generation-1', target.workspaceId)
        .run();
      const resolution = await resolveAfterTargetLookup(target, allowWake, async () => {
        await env.DATABASE.prepare(
          changeNode
            ? 'UPDATE workspaces SET node_id = ? WHERE id = ?'
            : 'UPDATE workspaces SET callback_generation = ? WHERE id = ?'
        )
          .bind(changeNode ? replacementNodeId : 'generation-2', target.workspaceId)
          .run();
      });
      expect(resolution).toMatchObject({ kind: 'retry' });
      expect(await target.stub.getSession(target.chatSessionId)).toMatchObject({
        status: 'sleeping',
        workspaceId: target.workspaceId,
        taskId: target.taskId,
      });
    }
  );
});

describe('captured runtime authority inside the real readiness DO', () => {
  it.each([
    { name: 'node assignment', mutation: 'node' },
    { name: 'workspace generation', mutation: 'generation' },
    { name: 'node owner', mutation: 'owner' },
  ])(
    'rejects changed $name during its authority read without activation or inbox nudge',
    async ({ mutation }) => {
      const target = await seedDeliveryTarget({
        ...COMMITTED_CASE,
        historicalClaimTask: false,
        recoveryWorkspace: 'target',
        held: true,
      });
      const replacementNodeId = `${target.nodeId}-replacement`;
      await seedNode(replacementNodeId, target.userId);
      const foreignUserId = `${target.userId}-foreign`;
      await seedUser(foreignUserId);
      await env.DATABASE.prepare('UPDATE workspaces SET callback_generation = ? WHERE id = ?')
        .bind('generation-1', target.workspaceId)
        .run();
      const input: SessionWakeReadyInput = {
        projectId: target.projectId,
        chatSessionId: target.chatSessionId,
        workspaceId: target.workspaceId,
        agentSessionId: target.agentSessionId,
        expectedRuntime: { nodeId: target.nodeId, workspaceCallbackGeneration: 'generation-1' },
        fence: { runtime: 'vm', taskId: target.taskId, recoveryAttemptId: 'wake-1' },
      };
      await runInDurableObject(target.stub, async (instance, state) => {
        await state.storage.deleteAlarm();
        acceptPromptDelivery(
          state.storage.sql,
          {},
          {
            deliveryId: 'pending-captured-runtime',
            targetSessionId: target.chatSessionId,
            displayContent: 'Preserve this accepted intent',
            senderType: 'human',
            senderId: target.userId,
            sourceKind: 'user_followup',
          }
        );
        const nextAttemptAt = Date.now() + 60_000;
        state.storage.sql.exec(
          "UPDATE session_inbox SET delivery_state = 'retry_wait', next_attempt_at = ? WHERE id = ?",
          nextAttemptAt,
          'pending-captured-runtime'
        );
        const internal = instance as unknown as { env: Env };
        const original = internal.env.DATABASE;
        let mutated = false;
        internal.env.DATABASE = {
          prepare(query: string) {
            const prepared = original.prepare(query);
            if (!query.startsWith('SELECT 1 AS ready')) return prepared;
            return {
              bind(...values: unknown[]) {
                const bound = prepared.bind(...values);
                return {
                  async first() {
                    expect(mutated).toBe(false);
                    mutated = true;
                    // The local activation capture has already run; D1 has not certified it yet.
                    await original
                      .prepare(
                        mutation === 'owner'
                          ? 'UPDATE nodes SET user_id = ? WHERE id = ?'
                          : mutation === 'node'
                            ? 'UPDATE workspaces SET node_id = ? WHERE id = ?'
                            : 'UPDATE workspaces SET callback_generation = ? WHERE id = ?'
                      )
                      .bind(
                        mutation === 'owner'
                          ? foreignUserId
                          : mutation === 'node'
                            ? replacementNodeId
                            : 'generation-2',
                        mutation === 'owner' ? target.nodeId : target.workspaceId
                      )
                      .run();
                    return bound.first();
                  },
                };
              },
            };
          },
        } as unknown as D1Database;
        try {
          expect(await instance.signalSessionWakeReady(input)).toBeNull();
          expect(mutated).toBe(true);
          expect(await instance.getSession(target.chatSessionId)).toMatchObject({
            status: 'sleeping',
            workspaceId: target.workspaceId,
            taskId: target.taskId,
          });
          expect(state.storage.sql.exec('SELECT * FROM session_wake_readiness').toArray()).toEqual(
            []
          );
          expect(
            state.storage.sql
              .exec(
                'SELECT delivery_state, next_attempt_at, delivery_attempts FROM session_inbox WHERE id = ?',
                'pending-captured-runtime'
              )
              .toArray()
          ).toEqual([
            { delivery_state: 'retry_wait', next_attempt_at: nextAttemptAt, delivery_attempts: 0 },
          ]);
        } finally {
          internal.env.DATABASE = original;
          await state.storage.deleteAlarm();
        }
      });
    }
  );
});
