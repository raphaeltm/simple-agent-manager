/**
 * A slept VM task is woken by its own scheduled message and by an event it subscribed to.
 * Each case starts awake, sleeps through the real VM teardown (D1) and the real ProjectData
 * session transition, then fires through the production schedule or event-wake code and the
 * durable prompt-delivery alarm into the real VM delivery adapter. Only the wake itself
 * (`ensureSessionRecovery`) is a boundary: delivery must ask it to wake this chat with the
 * authority the wake carries. `eviction-recovery-prompt.test.ts` runs the real wake from a
 * queued-message delivery down to the TaskRunner start it requests.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ProjectScheduledAction } from '@simple-agent-manager/shared';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import {
  type DurabilityFoundationHooks,
  processPromptDeliveryAlarm,
} from '../../src/durable-objects/project-data/durability-foundation';
import { resolveDurableExecutionConfig } from '../../src/durable-objects/project-data/durable-execution-config';
import { persistMessage } from '../../src/durable-objects/project-data/messages';
import { requireScheduleAction } from '../../src/durable-objects/project-data/project-event-schedules-authority';
import { runScheduleAlarm } from '../../src/durable-objects/project-data/project-event-schedules-runner';
import {
  cancelSchedule,
  createSchedule,
  getSchedule,
} from '../../src/durable-objects/project-data/project-event-schedules-storage';
import { admitProjectEvent } from '../../src/durable-objects/project-data/project-events';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { taskCallbackRoute } from '../../src/routes/tasks/callback';
import { runSessionSleepSweep } from '../../src/scheduled/session-sleep';
import { preserveProviderLimitWait } from '../../src/services/provider-limit-reconciliation';
import {
  queueWorkspaceSessionSleep,
  sleepWorkspaceSession,
} from '../../src/services/session-sleep';
import { createSleepProjectDataFixture } from '../helpers/session-sleep-project-data-fixture';
import { createSchemaTables } from '../helpers/sqlite-d1';

vi.mock('../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(async () => ({ workspace: 'workspace-1', scope: 'workspace' })),
}));

const recovery = vi.hoisted(() => ({ ensure: vi.fn(), report: vi.fn() }));
vi.mock('../../src/services/session-recovery', () => ({
  ensureSessionRecovery: recovery.ensure,
  reportSessionRecoveryRefusal: recovery.report,
}));

const {
  sleepBoundaryMocks: mocks,
  createSessionSleepFixture,
  SLEEP_START: START,
} = await vi.hoisted(() => import('../helpers/session-sleep-fixture'));

const PROJECT = 'project-1';
const USER = 'user-1';
const CHAT = 'chat-1';
const TASK = 'task-1';
const MINUTE = 60_000;
const recorded = JSON.parse(
  readFileSync(
    resolve(process.cwd(), '../../tests/fixtures/provider-limit-rejections.json'),
    'utf8'
  )
) as { cases: Array<{ name: string; callback: Record<string, unknown> }> };
const producedCallbacks: Array<{ name: string; callback: Record<string, unknown> }> = process.env
  .TEST_PROVIDER_LIMIT_CALLBACK_OUTPUT
  ? JSON.parse(readFileSync(process.env.TEST_PROVIDER_LIMIT_CALLBACK_OUTPUT, 'utf8'))
  : recorded.cases;

describe('provider-limit callback reaches the durable scheduled VM wake', () => {
  let fixture: ReturnType<typeof createSessionSleepFixture>;
  let d1: Database.Database;
  let env: Env;
  let doDb: Database.Database;
  let sql: SqlStorage;
  let hooks: DurabilityFoundationHooks;
  let deliveries: Promise<unknown>[];
  let assertSleeping: () => void;

  beforeEach(() => {
    fixture = createSessionSleepFixture('in_progress', () => ({
      activity: 'idle',
      activityAt: START.getTime(),
    }));
    ({ sqlite: d1, env } = fixture);
    Object.assign(env, {
      DURABLE_PROMPT_DELIVERY_ENABLED: 'true',
      PROJECT_EVENT_WAKE_ENABLED: 'true',
    });
    createSchemaTables(d1, [
      schema.users,
      schema.taskDependencies,
      schema.credentialLimitWindows,
      schema.projectEventSourceOutbox,
    ]);
    d1.exec(
      'CREATE UNIQUE INDEX quota_key ON credential_limit_windows(project_id,credential_reference,window_type)'
    );
    ({ doDb, sql, hooks, deliveries, assertSleeping } = createSleepProjectDataFixture(d1, mocks, {
      projectId: PROJECT,
      userId: USER,
      chatId: CHAT,
      taskId: TASK,
      startedAt: START,
    }));
    recovery.ensure.mockResolvedValue({ status: 'waking', taskId: TASK });

    d1.prepare(
      "UPDATE agent_sessions SET agent_credential_generation=1,agent_credential_source='user',agent_provider_mode='subscription',agent_credential_reference = ? WHERE id = ?"
    ).run('cc_credentials:provider-1', 'agent-1');
    mocks.persistMessage.mockImplementation(
      (
        _env: Env,
        _project: string,
        chat: string,
        role: string,
        content: string,
        meta: null,
        id: string
      ) => Promise.resolve(persistMessage(sql, env as never, chat, role, content, meta, id).id)
    );
    mocks.createProjectSchedule.mockImplementation(
      async (
        _env: Env,
        _project: string,
        input: { userId: string; creatorChatSessionId: string; request: unknown }
      ) => {
        const request = input.request as { action: ProjectScheduledAction };
        await requireScheduleAction(sql, env as never, PROJECT, input.userId, request.action);
        return createSchedule(
          sql,
          env as never,
          PROJECT,
          { userId: input.userId, chatSessionId: input.creatorChatSessionId },
          input.request,
          Date.now()
        );
      }
    );
    mocks.getProjectSchedule.mockImplementation(
      async (_env: Env, _project: string, input: { id: string }) =>
        getSchedule(sql, PROJECT, input.id)
    );
    mocks.mutateProjectSchedule.mockImplementation(
      async (_env: Env, _project: string, input: { id: string; request: unknown }) =>
        cancelSchedule(sql, env as never, PROJECT, input.id, input.request, Date.now())
    );
    mocks.admitProjectEvent.mockImplementation(
      async (_env: Env, _project: string, input: Parameters<typeof admitProjectEvent>[3]) =>
        admitProjectEvent(sql, env as never, PROJECT, { ...input, projectId: PROJECT })
    );
  });

  afterEach(() => {
    doDb.close();
    fixture.dispose();
  });

  async function callback(body: Record<string, unknown>) {
    const app = new Hono<{ Bindings: Env }>();
    app.onError((error, c) =>
      error instanceof AppError
        ? c.json(error.toJSON(), error.statusCode)
        : c.json({ error: String(error) }, 500)
    );
    app.route('/api/projects', taskCallbackRoute);
    return app.request(
      `/api/projects/${PROJECT}/tasks/${TASK}/status/callback`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-workspace-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      env,
      { waitUntil: (p) => deliveries.push(p), passThroughOnException: () => {} }
    );
  }

  async function sleepTheTask() {
    const sweep = await runSessionSleepSweep(env);
    expect(sweep.slept).toBe(1);
    assertSleeping();
  }

  async function runDeliveryAlarm() {
    processPromptDeliveryAlarm(sql, env as never, hooks);
    await Promise.all(deliveries.splice(0));
  }

  function inbox(sourceKind: string) {
    return doDb
      .prepare(
        `SELECT target_session_id AS target, source_task_id AS sourceTask, delivery_state AS state
           FROM session_inbox WHERE source_kind = ?`
      )
      .all(sourceKind);
  }

  it.each(producedCallbacks)(
    '$name callback parks, sleeps, schedules and resumes the retained task',
    async (provider) => {
      const response = await callback(provider.callback);
      expect(response.status).toBe(200);
      const task = await response.json();
      expect(task.status).toBe('in_progress');
      expect(task.admissionState).toBe('provider_limit_waiting');
      expect(task.admissionReason).toContain('UTC');
      expect(
        d1
          .prepare(
            "SELECT status FROM credential_limit_windows WHERE window_type='provider.prompt_rejection'"
          )
          .get()
      ).toEqual({ status: 'rejected' });
      expect(mocks.cleanupTaskRun).not.toHaveBeenCalled();
      expect(
        sql.exec('SELECT content FROM chat_messages WHERE role = ?', 'system').toArray()[0]
      ).toMatchObject({ content: task.admissionReason });
      expect(
        d1.prepare('SELECT sleep_status FROM session_snapshots WHERE chat_session_id = ?').get(CHAT)
      ).toEqual({ sleep_status: 'scheduled' });
      const persisted = d1
        .prepare('SELECT provider_limit_wait_json AS value FROM tasks WHERE id = ?')
        .get(TASK) as { value: string };
      const wait = JSON.parse(persisted.value);
      // Duplicate provider callbacks repair intent but never spend another attempt.
      expect((await callback(provider.callback)).status).toBe(200);
      expect(
        JSON.parse(
          (
            d1
              .prepare('SELECT provider_limit_wait_json AS value FROM tasks WHERE id = ?')
              .get(TASK) as { value: string }
          ).value
        ).attempts
      ).toBe(1);
      await sleepTheTask();
      vi.setSystemTime(wait.nextRetryAt);
      await runScheduleAlarm(sql, env as never, hooks);
      expect(inbox('scheduled_action')).toEqual([
        { target: CHAT, sourceTask: TASK, state: 'queued' },
      ]);
      await runDeliveryAlarm();
      expect(recovery.ensure).toHaveBeenCalledOnce();
      expect(recovery.ensure).toHaveBeenCalledWith(
        env,
        PROJECT,
        CHAT,
        expect.objectContaining({ taskId: TASK })
      );
      const prompt = sql
        .exec('SELECT content FROM session_inbox WHERE source_kind = ?', 'scheduled_action')
        .toArray()[0];
      expect(prompt).toMatchObject({
        content: expect.stringContaining('Continue the assigned task'),
      });
      expect(prompt).toMatchObject({
        content: expect.stringContaining('Do not blindly replay'),
      });
      expect(provider).toBeTruthy();
    }
  );

  it.each([
    { interval: 180_000, delay: 120_000, immediate: false },
    { interval: 60_000, delay: 120_000, immediate: true },
    { interval: 120_000, delay: 120_000, immediate: false },
    { interval: 180_000, delay: 120_000, immediate: false, checkpointFault: true },
    { interval: 180_000, delay: 120_000, immediate: false, ambiguousReceipt: true },
    { interval: 180_000, delay: 120_000, immediate: false, missingReceipt: true },
    { interval: 180_000, delay: 120_000, immediate: false, blockedAtCommit: true },
    { interval: 180_000, delay: 120_000, immediate: false, staleGeneration: true },
  ])(
    'provider reset $delay with configured idle interval $interval uses immediate=$immediate',
    async ({
      interval,
      delay,
      immediate,
      checkpointFault,
      ambiguousReceipt,
      missingReceipt,
      blockedAtCommit,
      staleGeneration,
    }) => {
      env.SESSION_SLEEP_AFTER_MS = String(interval);
      expect(
        (
          await callback({
            ...producedCallbacks[0].callback,
            providerLimitResetsAt: Date.now() + delay,
          })
        ).status
      ).toBe(200);
      const snapshot = d1
        .prepare('SELECT sleep_after AS due FROM session_snapshots WHERE chat_session_id=?')
        .get(CHAT) as { due: string };
      expect(Date.parse(snapshot.due) - Date.now()).toBe(immediate ? 0 : interval);
      // Force the scheduling receipt due; the authoritative policy must still retain a short wait.
      d1.prepare('UPDATE session_snapshots SET sleep_after=? WHERE chat_session_id=?').run(
        START.toISOString(),
        CHAT
      );
      const sweep = await runSessionSleepSweep(env);
      expect(sweep.slept).toBe(immediate ? 1 : 0);
      if (!immediate) {
        expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
        const stored = d1
          .prepare('SELECT provider_limit_wait_json AS value FROM tasks WHERE id=?')
          .get(TASK) as { value: string };
        const wait = JSON.parse(stored.value);
        const capabilities = {
          protocolVersion: 1,
          runtimeIdentity: 'fixture-runtime',
          promptReceipts: {
            supported: true,
            lookup: true,
            states: ['accepted', 'in_flight', 'completed', 'not_found', 'ambiguous'],
          },
          checkpointRollover: {
            supported: false,
            automatic: false,
            states: [],
            defaultGraceMs: 0,
            maxGraceMs: 0,
            operationTimeoutMs: 0,
          },
        };
        let acceptedReceipt: object | null = null;
        mocks.nodeAgentRequest.mockImplementation(async (_node, _env, path: string) =>
          path.includes('capabilities') ? capabilities : acceptedReceipt
        );
        mocks.sendPrompt.mockImplementation(async (...args: unknown[]) => {
          if (missingReceipt) return { status: 'accepted', sessionId: 'agent-1' };
          const opts = args[7] as { deliveryId: string };
          if (staleGeneration)
            d1.prepare(
              "UPDATE agent_sessions SET agent_credential_generation=2 WHERE id='agent-1'"
            ).run();
          acceptedReceipt = {
            deliveryId: opts.deliveryId,
            state: ambiguousReceipt ? 'ambiguous' : 'accepted',
            runtimeIdentity: 'fixture-runtime',
            acceptedAt: ambiguousReceipt ? null : Date.now() - 1_000,
            completedAt: null,
          };
          return { status: 'accepted', sessionId: 'agent-1', receipt: acceptedReceipt };
        });
        vi.setSystemTime(wait.nextRetryAt);
        await runScheduleAlarm(sql, env as never, hooks);
        const originalPrepare = env.DATABASE.prepare.bind(env.DATABASE);
        let failCheckpoint = !!checkpointFault;
        const prepareSpy = vi.spyOn(env.DATABASE, 'prepare').mockImplementation((query: string) => {
          const statement = originalPrepare(query);
          if (!query.includes("json_set(provider_limit_wait_json,'$.phase','released')"))
            return statement;
          const originalBind = statement.bind.bind(statement);
          statement.bind = (...values: unknown[]) => {
            const bound = originalBind(...values);
            const originalRun = bound.run.bind(bound);
            bound.run = async () => {
              const current = JSON.parse(
                (
                  d1
                    .prepare('SELECT provider_limit_wait_json AS value FROM tasks WHERE id=?')
                    .get(TASK) as { value: string }
                ).value
              );
              d1.prepare(
                "UPDATE tasks SET provider_limit_wait_json=?,admission_state=CASE WHEN ? THEN 'provider_limit_blocked' ELSE admission_state END WHERE id=?"
              ).run(
                JSON.stringify({
                  ...current,
                  scheduleId: current.scheduleId,
                  benignReceiptMetadata: 'retained',
                  ...(blockedAtCommit
                    ? { phase: 'blocked', reason: 'Blocked: synthetic test-only concurrent block' }
                    : {}),
                }),
                blockedAtCommit ? 1 : 0,
                TASK
              );
              if (failCheckpoint) {
                failCheckpoint = false;
                throw new Error('synthetic test-only checkpoint outage');
              }
              return originalRun();
            };
            return bound;
          };
          return statement;
        });
        await runDeliveryAlarm();
        if (checkpointFault) {
          expect(
            JSON.parse(
              (
                d1
                  .prepare('SELECT provider_limit_wait_json AS value FROM tasks WHERE id=?')
                  .get(TASK) as { value: string }
              ).value
            ).phase
          ).toBe('waiting');
          const retry = sql
            .exec(
              "SELECT delivery_state,next_attempt_at FROM session_inbox WHERE source_kind='scheduled_action'"
            )
            .toArray()[0];
          expect(retry?.delivery_state).not.toBe('delivered');
          expect(retry?.delivery_state).toBe('delivering');
          vi.setSystemTime(
            Date.now() + resolveDurableExecutionConfig(env as never).receiptTimeoutMs + 1
          );
          await runDeliveryAlarm();
        }
        prepareSpy.mockRestore();
        if (ambiguousReceipt || missingReceipt || blockedAtCommit || staleGeneration) {
          const unchanged = JSON.parse(
            (
              d1
                .prepare('SELECT provider_limit_wait_json AS value FROM tasks WHERE id=?')
                .get(TASK) as { value: string }
            ).value
          );
          expect(unchanged.phase).toBe(blockedAtCommit ? 'blocked' : 'waiting');
          expect(mocks.sendPrompt).toHaveBeenCalledOnce();
          expect(recovery.ensure).not.toHaveBeenCalled();
          return;
        }
        expect(recovery.ensure).not.toHaveBeenCalled();
        expect(mocks.sendPrompt).toHaveBeenCalledOnce();
        expect(
          JSON.parse(
            (
              d1
                .prepare('SELECT provider_limit_wait_json AS value FROM tasks WHERE id=?')
                .get(TASK) as { value: string }
            ).value
          ).phase
        ).toBe('released');
        const releasedWait = JSON.parse(
          (
            d1
              .prepare('SELECT provider_limit_wait_json AS value FROM tasks WHERE id=?')
              .get(TASK) as { value: string }
          ).value
        );
        expect(releasedWait).toMatchObject({
          benignReceiptMetadata: 'retained',
          attempts: wait.attempts,
          credentialKey: wait.credentialKey,
        });
        vi.setSystemTime(wait.deadlineAt + 1);
        expect(await preserveProviderLimitWait(env, TASK, Date.now())).toBe(false);
        expect(
          d1.prepare('SELECT admission_state AS state FROM tasks WHERE id=?').get(TASK)
        ).toEqual({ state: null });
        expect(
          sql
            .exec("SELECT content FROM session_inbox WHERE source_kind='scheduled_action'")
            .toArray()[0]
        ).toMatchObject({ content: expect.stringContaining('Do not blindly replay') });
        expect(
          (
            await callback({
              executionStep: 'awaiting_followup',
              promptSucceeded: true,
              providerLimitAgentSessionId: 'agent-1',
              providerLimitCredentialGeneration: 1,
              providerLimitPromptAttemptId: 2,
              promptStartedAt: wait.nextRetryAt,
            })
          ).status
        ).toBe(200);
        expect(
          d1.prepare('SELECT provider_limit_wait_json AS value FROM tasks WHERE id=?').get(TASK)
        ).toEqual({ value: null });
      }
    }
  );

  it('a parked task with a tool in flight cannot sleep, then sleeps when canonical activity clears', async () => {
    await callback(producedCallbacks[0].callback);
    const idle = mocks.getSessionState.getMockImplementation();
    mocks.getSessionState.mockResolvedValue({
      activity: 'idle',
      activityAt: START.getTime(),
      runtimeWorkState: 'active',
      runtimeWorkCount: 1,
      runtimeWorkSource: 'claude_background_tasks',
      runtimeWorkUpdatedAt: START.getTime(),
      runtimeWorkProgressAt: START.getTime(),
    });
    const blocked = await runSessionSleepSweep(env);
    expect(blocked.slept).toBe(0);
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    expect(d1.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK)).toEqual({
      status: 'in_progress',
    });
    if (!idle) throw new Error('Missing activity fixture');
    mocks.getSessionState.mockImplementation(idle);
    // The earlier deferral is a scheduling receipt; allow its bounded retry due.
    const due = d1
      .prepare('SELECT sleep_after AS due FROM session_snapshots WHERE chat_session_id = ?')
      .get(CHAT) as { due: string };
    vi.setSystemTime(new Date(Date.parse(due.due) + 1));
    await sleepTheTask();
  });

  it('ordinary idle still waits the full interval, while explicit Sleep remains immediate', async () => {
    await queueWorkspaceSessionSleep(env, {
      workspaceId: 'workspace-1',
      userId: USER,
      reason: 'ordinary idle scheduling',
      sleepAfterMs: 0,
    });
    const before = await runSessionSleepSweep(env);
    expect(before.slept).toBe(0);
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    await sleepWorkspaceSession(env, {
      workspaceId: 'workspace-1',
      userId: USER,
      reason: 'explicit sleep',
    });
    expect(d1.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK)).toEqual({
      status: 'sleeping',
    });
  });

  it('a successful early turn clears the wait and cancels its future continuation, while cancellation does not', async () => {
    expect((await callback(producedCallbacks[0].callback)).status).toBe(200);
    const wait = JSON.parse(
      (
        d1
          .prepare('SELECT provider_limit_wait_json AS value FROM tasks WHERE id = ?')
          .get(TASK) as { value: string }
      ).value
    );
    expect(wait.scheduleId).toBeTruthy();
    // Cancellation/checkpoint callbacks have this step too, but no success signal.
    await callback({ executionStep: 'awaiting_followup' });
    expect(
      d1.prepare('SELECT provider_limit_wait_json AS value FROM tasks WHERE id = ?').get(TASK)
    ).toMatchObject({ value: expect.any(String) });
    await callback({ executionStep: 'awaiting_followup', promptSucceeded: true });
    expect(
      d1.prepare('SELECT provider_limit_wait_json AS value FROM tasks WHERE id = ?').get(TASK)
    ).toMatchObject({ value: expect.any(String) });
    const successful = await callback({
      executionStep: 'awaiting_followup',
      promptSucceeded: true,
      providerLimitAgentSessionId: 'agent-1',
      providerLimitCredentialGeneration: 1,
      providerLimitPromptAttemptId: 2,
      promptStartedAt: wait.observedAt + 1,
    });
    expect(await successful.json()).toMatchObject({ status: 'in_progress' });
    expect(successful.status).toBe(200);
    expect(
      d1.prepare('SELECT provider_limit_wait_json AS value FROM tasks WHERE id = ?').get(TASK)
    ).toEqual({ value: null });
    expect(getSchedule(sql, PROJECT, wait.scheduleId)?.state).toBe('cancelled');
    vi.setSystemTime(wait.nextRetryAt);
    await runScheduleAlarm(sql, env as never, hooks);
    expect(inbox('scheduled_action')).toEqual([]);
  });

  it('a success from before the wait or after pin blocking cannot clear it', async () => {
    await callback(producedCallbacks[0].callback);
    const wait = JSON.parse(
      (
        d1
          .prepare('SELECT provider_limit_wait_json AS value FROM tasks WHERE id = ?')
          .get(TASK) as { value: string }
      ).value
    );
    const success = {
      executionStep: 'awaiting_followup',
      promptSucceeded: true,
      providerLimitAgentSessionId: 'agent-1',
      providerLimitCredentialGeneration: 1,
      providerLimitPromptAttemptId: 2,
      promptStartedAt: wait.observedAt - 1,
    };
    await callback(success);
    expect(
      d1.prepare('SELECT provider_limit_wait_json AS value FROM tasks WHERE id = ?').get(TASK)
    ).toMatchObject({ value: expect.any(String) });
    d1.prepare(
      "UPDATE tasks SET provider_limit_wait_json = ?,admission_state='provider_limit_blocked' WHERE id = ?"
    ).run(JSON.stringify({ ...wait, phase: 'blocked' }), TASK);
    await callback({ ...success, promptStartedAt: wait.observedAt + 1 });
    expect(d1.prepare('SELECT admission_state FROM tasks WHERE id = ?').get(TASK)).toEqual({
      admission_state: 'provider_limit_blocked',
    });
  });

  it('a rejection from a superseded stopped session cannot park current work', async () => {
    d1.prepare("UPDATE agent_sessions SET status='stopped'").run();
    d1.prepare(
      "INSERT INTO agent_sessions(id,user_id,workspace_id,status,agent_credential_generation) SELECT 'new-agent',user_id,workspace_id,'running',1 FROM agent_sessions LIMIT 1"
    ).run();
    await callback({
      ...producedCallbacks[0].callback,
      providerLimitAgentSessionId: 'agent-1',
      providerLimitCredentialGeneration: 1,
    });
    expect(
      d1.prepare('SELECT status,provider_limit_wait_json FROM tasks WHERE id = ?').get(TASK)
    ).toEqual({ status: 'in_progress', provider_limit_wait_json: null });
  });

  it('an obsolete admitted continuation is rejected by the real delivery guard after success', async () => {
    await callback(producedCallbacks[0].callback);
    await sleepTheTask();
    const wait = JSON.parse(
      (
        d1
          .prepare('SELECT provider_limit_wait_json AS value FROM tasks WHERE id = ?')
          .get(TASK) as { value: string }
      ).value
    );
    vi.setSystemTime(wait.nextRetryAt);
    await runScheduleAlarm(sql, env as never, hooks);
    expect(inbox('scheduled_action')).toHaveLength(1);
    d1.prepare('UPDATE tasks SET provider_limit_wait_json = NULL WHERE id = ?').run(TASK);
    await runDeliveryAlarm();
    expect(recovery.ensure).not.toHaveBeenCalled();
    expect(inbox('scheduled_action')[0]).toMatchObject({ state: 'failed' });
  });

  it.each(['agent_prompt_failed', 'model_provider_credential_rejected', 'provider_overloaded'])(
    'an ordinary %s callback still fails the task',
    async (errorMessage) => {
      const response = await callback({ toStatus: 'failed', errorMessage });
      expect(response.status).toBe(200);
      expect(d1.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK)).toEqual({
        status: 'failed',
      });
      expect(
        d1.prepare('SELECT provider_limit_wait_json AS value FROM tasks WHERE id = ?').get(TASK)
      ).toEqual({ value: null });
    }
  );

  it('a stale explicit limit callback cannot fail or rebind a newer credential generation', async () => {
    const response = await callback({
      ...producedCallbacks[0].callback,
      providerLimitAgentSessionId: 'agent-1',
      providerLimitCredentialGeneration: 0,
      providerLimitPromptAttemptId: 1,
    });
    expect(response.status).toBe(200);
    expect(
      d1
        .prepare('SELECT status,provider_limit_wait_json AS value FROM tasks WHERE id = ?')
        .get(TASK)
    ).toEqual({ status: 'in_progress', value: null });
  });

  it('unknown reset retries are bounded across restored runtime generations', async () => {
    for (let i = 0; i < 4; i++) {
      if (i) {
        d1.prepare('UPDATE agent_sessions SET id = ?').run(`agent-${i + 1}`);
      }
      const response = await callback({
        toStatus: 'failed',
        errorMessage: 'provider_limit_reached',
      });
      expect(response.status).toBe(200);
    }
    const task = d1
      .prepare('SELECT status,admission_state,admission_reason FROM tasks WHERE id = ?')
      .get(TASK);
    expect(task).toMatchObject({
      status: 'in_progress',
      admission_state: 'provider_limit_blocked',
      admission_reason: expect.stringContaining('budget exhausted'),
    });
    expect(sql.exec('SELECT count(*) AS count FROM project_schedules').toArray()[0]).toEqual({
      count: 3,
    });
  });

  it('preserves an exhausted unknown-reset block after its runtime was deleted', async () => {
    // Distinct real callback incidents exhaust the existing consecutive budget.
    for (let incident = 0; incident < 4; incident++) {
      if (incident) d1.prepare('UPDATE agent_sessions SET id=?').run(`blocked-agent-${incident}`);
      expect(
        (await callback({ toStatus: 'failed', errorMessage: 'provider_limit_reached' })).status
      ).toBe(200);
    }
    const before = d1
      .prepare(
        'SELECT admission_state,admission_reason,provider_limit_wait_json FROM tasks WHERE id=?'
      )
      .get(TASK) as {
      admission_state: string;
      admission_reason: string;
      provider_limit_wait_json: string;
    };
    const wait = JSON.parse(before.provider_limit_wait_json);
    expect(wait).toMatchObject({ phase: 'blocked', resetsAt: null, attempts: 4 });
    expect(before.admission_state).toBe('provider_limit_blocked');
    expect(before.admission_reason).toContain('budget exhausted');

    // Boundary state left by a completed runtime deletion. Retain workspaceId
    // on the task so preservation reaches the real no-live-generation verdict.
    d1.prepare("UPDATE workspaces SET status='deleted' WHERE id='workspace-1'").run();
    d1.prepare("UPDATE nodes SET status='deleted' WHERE id='node-1'").run();
    d1.prepare("UPDATE agent_sessions SET status='stopped'").run();
    d1.prepare(
      "UPDATE session_snapshots SET sleeping_at=?,sleep_status='sleeping' WHERE chat_session_id=?"
    ).run(new Date().toISOString(), CHAT);
    const schedulesBefore = sql
      .exec('SELECT count(*) AS count FROM project_schedules')
      .toArray()[0];
    mocks.createProjectSchedule.mockClear();
    mocks.sendPrompt.mockClear();
    recovery.ensure.mockClear();
    vi.setSystemTime(wait.nextRetryAt + 1);

    expect(await preserveProviderLimitWait(env, TASK, Date.now())).toBe(true);
    expect(await preserveProviderLimitWait(env, TASK, Date.now())).toBe(true);
    expect(
      d1
        .prepare(
          'SELECT admission_state,admission_reason,provider_limit_wait_json FROM tasks WHERE id=?'
        )
        .get(TASK)
    ).toEqual(before);
    expect(mocks.createProjectSchedule).not.toHaveBeenCalled();
    expect(sql.exec('SELECT count(*) AS count FROM project_schedules').toArray()[0]).toEqual(
      schedulesBefore
    );
    // Existing schedules may be due, but a blocked wait must not deliver work.
    await runScheduleAlarm(sql, env as never, hooks);
    await runDeliveryAlarm();
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
    expect(recovery.ensure).not.toHaveBeenCalled();
    expect(d1.prepare('SELECT status FROM tasks WHERE id=?').get(TASK)).toEqual({
      status: 'in_progress',
    });
  });

  it.each(['stale', 'expired', 'unrelated', 'future', 'ambiguous', 'auth'] as const)(
    'legacy fallback ignores %s rejection evidence',
    async (shape) => {
      const observed =
        Date.now() + (shape === 'future' ? 1 : shape === 'stale' ? -2 * MINUTE - 1 : 0);
      d1.prepare(
        "INSERT INTO credential_limit_windows(project_id,credential_reference,status,resets_at,observed_at,window_type,updated_at) VALUES ('project-1',?,'rejected',?,?,'claude.five_hour',?)"
      ).run(
        shape === 'unrelated' ? 'cc_credentials:other' : 'cc_credentials:provider-1',
        shape === 'expired' ? Date.now() : Date.now() + MINUTE,
        observed,
        observed
      );
      if (shape === 'ambiguous')
        d1.prepare(
          "INSERT INTO agent_sessions(id,user_id,workspace_id,status,agent_credential_generation) SELECT 'new-agent',user_id,workspace_id,'running',1 FROM agent_sessions LIMIT 1"
        ).run();
      await callback({
        toStatus: 'failed',
        errorMessage:
          shape === 'auth' ? 'model_provider_credential_rejected' : 'agent_prompt_failed',
      });
      expect(
        d1.prepare('SELECT status,provider_limit_wait_json FROM tasks WHERE id=?').get(TASK)
      ).toEqual({ status: 'failed', provider_limit_wait_json: null });
    }
  );

  it('a provider wait cannot refresh or bypass an already overrun live runtime ceiling', async () => {
    await callback(producedCallbacks[0].callback);
    d1.prepare('UPDATE workspaces SET created_at=? WHERE id=?').run(
      new Date(Date.now() - 26 * 60 * MINUTE).toISOString(),
      'workspace-1'
    );
    expect(await preserveProviderLimitWait(env, TASK, Date.now())).toBe(false);
    expect(d1.prepare('SELECT status FROM workspaces WHERE id=?').get('workspace-1')).toEqual({
      status: 'running',
    });
  });

  it.each(['agent_prompt_failed', 'model_provider_credential_rejected', 'provider_overloaded'])(
    'current-source %s remains a failure even with a fresh rejected window',
    async (errorMessage) => {
      d1.prepare(
        "INSERT INTO credential_limit_windows(project_id,credential_reference,status,resets_at,observed_at,window_type,updated_at)VALUES('project-1','cc_credentials:provider-1','rejected',?,?,'claude.five_hour',?)"
      ).run(Date.now() + MINUTE, Date.now(), Date.now());
      await callback({
        toStatus: 'failed',
        errorMessage,
        providerLimitAgentSessionId: 'agent-1',
        providerLimitCredentialGeneration: 1,
        providerLimitPromptAttemptId: 1,
      });
      expect(
        d1.prepare('SELECT status,provider_limit_wait_json FROM tasks WHERE id=?').get(TASK)
      ).toEqual({ status: 'failed', provider_limit_wait_json: null });
    }
  );
  it('old agent generic failure parks only for just-observed rejection of the exact credential', async () => {
    d1.prepare(
      "INSERT INTO credential_limit_windows (project_id,credential_reference,status,resets_at,observed_at,window_type,updated_at) VALUES ('project-1','cc_credentials:provider-1','rejected',?,?,'claude.five_hour',?)"
    ).run(Date.now() + 60 * MINUTE, Date.now(), Date.now());
    expect(
      (await callback({ toStatus: 'failed', errorMessage: 'agent_prompt_failed' })).status
    ).toBe(200);
    expect(d1.prepare('SELECT status,admission_state FROM tasks WHERE id = ?').get(TASK)).toEqual({
      status: 'in_progress',
      admission_state: 'provider_limit_waiting',
    });
  });
  it('repairs a reordered persisted wait after an uncertain schedule response', async () => {
    expect((await callback(producedCallbacks[0].callback)).status).toBe(200);
    const row = d1.prepare('SELECT provider_limit_wait_json FROM tasks WHERE id=?').get(TASK) as {
      provider_limit_wait_json: string;
    };
    const saved = JSON.parse(row.provider_limit_wait_json);
    const scheduleId = saved.scheduleId;
    delete saved.scheduleId;
    const reordered = Object.fromEntries(Object.entries(saved).reverse());
    d1.prepare('UPDATE tasks SET provider_limit_wait_json=? WHERE id=?').run(
      JSON.stringify(reordered),
      TASK
    );
    mocks.createProjectSchedule.mockClear();
    expect((await callback(producedCallbacks[0].callback)).status).toBe(200);
    expect(mocks.createProjectSchedule).toHaveBeenCalledOnce();
    const repaired = d1
      .prepare('SELECT provider_limit_wait_json FROM tasks WHERE id=?')
      .get(TASK) as { provider_limit_wait_json: string };
    expect(JSON.parse(repaired.provider_limit_wait_json)).toMatchObject({
      attempts: 1,
      scheduleId,
    });
    expect(sql.exec('SELECT id FROM project_schedules').toArray()).toHaveLength(1);
  });

  it.each(['phase', 'deadlineAt'] as const)(
    'does not attach a stale schedule after concurrent %s change',
    async (field) => {
      const create = mocks.createProjectSchedule.getMockImplementation();
      if (!create) throw new Error('real schedule adapter missing');
      let scheduleId = '';
      mocks.createProjectSchedule.mockImplementation(async (...args) => {
        const result = await create(...args);
        scheduleId = result.schedule.id;
        d1.prepare(
          'UPDATE tasks SET provider_limit_wait_json=json_set(provider_limit_wait_json,?,?) WHERE id=?'
        ).run(`$.${field}`, field === 'phase' ? 'blocked' : Date.now() + 2 * MINUTE, TASK);
        return result;
      });
      expect((await callback(producedCallbacks[0].callback)).status).toBe(200);
      const row = d1.prepare('SELECT provider_limit_wait_json FROM tasks WHERE id=?').get(TASK) as {
        provider_limit_wait_json: string;
      };
      const current = JSON.parse(row.provider_limit_wait_json);
      expect(current.scheduleId).toBeUndefined();
      expect(current[field]).toBe(field === 'phase' ? 'blocked' : Date.now() + 2 * MINUTE);
      expect(getSchedule(sql, PROJECT, scheduleId)?.state).toBe('cancelled');
    }
  );
});
