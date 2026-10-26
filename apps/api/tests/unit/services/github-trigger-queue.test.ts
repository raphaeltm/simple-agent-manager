import type { AgentMailboxMessage } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  acceptGitHubTriggerExecution,
  drainGitHubTriggerQueue,
} from '../../../src/services/github-trigger-queue';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const databases: Database.Database[] = [];
afterEach(() => {
  vi.useRealTimers();
  databases.splice(0).forEach((db) => db.close());
});
function setup() {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  createAllSchemaTables(sqlite, schema);
  sqlite.exec(
    'CREATE UNIQUE INDEX github_delivery ON trigger_executions(github_delivery_id, trigger_id)'
  );
  sqlite
    .prepare(
      `INSERT INTO triggers (id,project_id,user_id,name,status,source_type,skip_if_running,max_concurrent,next_execution_sequence,prompt_template,trigger_count) VALUES ('tr','p','u','Test','active','github',1,1,1,'hello',0)`
    )
    .run();
  const trigger = {
    id: 'tr',
    projectId: 'p',
    userId: 'u',
    name: 'Test',
    status: 'active',
    sourceType: 'github',
    skipIfRunning: true,
    maxConcurrent: 1,
    nextExecutionSequence: 1,
    promptTemplate: 'hello',
    description: null,
    triggerCount: 0,
    agentProfileId: null,
    skillId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    resourceRequirementsJson: null,
  } as schema.TriggerRow;
  const mailbox = new Map<string, AgentMailboxMessage>();
  let loseAcceptResponse = false;
  const stub = {
    ensureProjectId: vi.fn(async () => undefined),
    getSession: vi.fn(async (id: string) => ({
      id,
      projectId: 'p',
      status: 'active',
      taskId: 'task',
    })),
    getMailboxMessage: vi.fn(async (id: string) => mailbox.get(id) ?? null),
    acceptPromptDelivery: vi.fn(
      async (input: {
        deliveryId: string;
        targetSessionId: string;
        displayContent: string;
        sourceKind: string;
        sourceTaskId: string;
        metadata: Record<string, unknown>;
      }) => {
        if (!mailbox.has(input.deliveryId))
          mailbox.set(input.deliveryId, {
            id: input.deliveryId,
            targetSessionId: input.targetSessionId,
            sourceTaskId: input.sourceTaskId,
            senderType: 'system',
            senderId: null,
            messageClass: 'deliver',
            deliveryState: 'acked',
            content: input.displayContent,
            metadata: input.metadata,
            sourceKind: input.sourceKind,
            promptMessageId: input.deliveryId,
            createdAt: Date.now(),
            deliveryAttempts: 0,
            ackRequired: false,
            ackTimeoutMs: null,
            expiresAt: null,
            lastDeliveryAt: null,
            deliveredAt: null,
            ackedAt: null,
            nextAttemptAt: null,
            lastError: null,
            terminalReason: null,
            attemptId: null,
            attemptStartedAt: null,
            runtimeIdentity: null,
            receiptState: null,
            receiptRuntimeIdentity: null,
            receiptCheckedAt: null,
            acceptedAt: null,
            adapterProtocolVersion: null,
            receiptSupported: null,
          } as AgentMailboxMessage);
        if (loseAcceptResponse) {
          loseAcceptResponse = false;
          throw new Error('response lost after durable acceptance');
        }
        return {
          message: mailbox.get(input.deliveryId),
          transcriptMessageId: input.deliveryId,
          transcriptInserted: true,
          transcriptCreatedAt: Date.now(),
          transcriptSequence: 1,
          workspaceId: null,
        };
      }
    ),
  };
  const env = {
    DATABASE: createSqliteD1(sqlite),
    PROJECT_DATA: { idFromName: () => ({ toString: () => 'queue-project' }), get: () => stub },
  } as unknown as Env;
  const submit = vi.fn(async (_env, input) => {
    const taskId = `task-${input.triggerExecutionId}`;
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO tasks (id,project_id,user_id,status,chat_session_id,trigger_execution_id) VALUES (?,'p','u','in_progress',?,?)`
      )
      .run(taskId, `session-${taskId}`, input.triggerExecutionId);
    return { taskId, sessionId: `session-${taskId}`, branchName: 'branch' };
  });
  const input = (delivery: string, subject: string, options = {}) => ({
    trigger,
    githubDeliveryId: delivery,
    eventType: 'github.issue_comment.created',
    triggeredBy: 'github' as const,
    subjectKey: subject,
    subjectAffinity: false,
    queueMaxPending: 50,
    queueTtlSeconds: 86400,
    renderPrompt: () => `comment ${delivery}`,
    ...options,
  });
  return {
    sqlite,
    env,
    submit,
    input,
    mailbox,
    stub,
    loseNextAcceptResponse: () => {
      loseAcceptResponse = true;
    },
  };
}

describe('durable GitHub trigger queue', () => {
  it('executes two different issues sequentially at concurrency one, without duplicate agents', async () => {
    const { sqlite, env, submit, input } = setup();
    const first = await acceptGitHubTriggerExecution(env, input('one', 'repo:1'), submit);
    expect(first.outcome).toBe('submitted');
    expect((await acceptGitHubTriggerExecution(env, input('two', 'repo:2'), submit)).outcome).toBe(
      'waiting'
    );
    await acceptGitHubTriggerExecution(env, input('two', 'repo:2'), submit);
    expect(submit).toHaveBeenCalledTimes(1);
    sqlite.prepare("UPDATE tasks SET status='completed'").run();
    sqlite
      .prepare("UPDATE trigger_executions SET status='completed' WHERE task_id IS NOT NULL")
      .run();
    await drainGitHubTriggerQueue(env, submit);
    expect(submit).toHaveBeenCalledTimes(2);
    await drainGitHubTriggerQueue(env, submit);
    expect(submit).toHaveBeenCalledTimes(2);
  });
  it('expires waiting events visibly without starting an agent', async () => {
    vi.useFakeTimers();
    const { sqlite, env, submit, input } = setup();
    await acceptGitHubTriggerExecution(env, input('one', 'repo:1'), submit);
    await acceptGitHubTriggerExecution(env, input('two', 'repo:2', { queueTtlSeconds: 1 }), submit);
    vi.advanceTimersByTime(1001);
    await drainGitHubTriggerQueue(env, submit);
    expect(
      sqlite
        .prepare("SELECT status,skip_reason FROM trigger_executions WHERE github_delivery_id='two'")
        .get()
    ).toEqual({ status: 'dropped', skip_reason: 'queue_expired' });
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it('atomically bounds pending events and audits overflow', async () => {
    const { sqlite, env, submit, input } = setup();
    await acceptGitHubTriggerExecution(env, input('one', 'repo:1'), submit);
    await Promise.all(
      ['two', 'three', 'four'].map((id) =>
        acceptGitHubTriggerExecution(env, input(id, `repo:${id}`, { queueMaxPending: 1 }), submit)
      )
    );
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM trigger_executions WHERE status='waiting'").get()
    ).toEqual({ n: 1 });
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM trigger_executions WHERE status='dropped' AND skip_reason='queue_full'"
        )
        .get()
    ).toEqual({ n: 2 });
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it('routes same-PR comments to one run, preserving the target after a lost accept response', async () => {
    const { env, submit, input, mailbox, loseNextAcceptResponse } = setup();
    const first = await acceptGitHubTriggerExecution(
      env,
      input('one', 'github:42:7', { subjectAffinity: true }),
      submit
    );
    loseNextAcceptResponse();
    await expect(
      acceptGitHubTriggerExecution(
        env,
        input('two', 'github:42:7', { subjectAffinity: true }),
        submit
      )
    ).rejects.toThrow('response lost');
    const second = await acceptGitHubTriggerExecution(
      env,
      input('two', 'github:42:7', { subjectAffinity: true }),
      submit
    );
    expect(second).toMatchObject({ outcome: 'routed', taskId: first.taskId });
    expect(submit).toHaveBeenCalledTimes(1);
    expect([...mailbox.values()]).toHaveLength(1);
    expect([...mailbox.values()][0]).toMatchObject({
      content: 'comment two',
      targetSessionId: first.sessionId,
      sourceTaskId: first.taskId,
      sourceKind: 'github_trigger',
    });
  });
  it('routes to a sleeping run through the durable queue, without starting another agent', async () => {
    const { sqlite, env, submit, input, mailbox } = setup();
    await acceptGitHubTriggerExecution(
      env,
      input('one', 'github:42:7', { subjectAffinity: true }),
      submit
    );
    sqlite.prepare("UPDATE tasks SET status='sleeping'").run();
    expect(
      (
        await acceptGitHubTriggerExecution(
          env,
          input('two', 'github:42:7', { subjectAffinity: true }),
          submit
        )
      ).outcome
    ).toBe('routed');
    expect(submit).toHaveBeenCalledTimes(1);
    expect([...mailbox.values()][0]).toMatchObject({
      sourceKind: 'github_trigger',
      deliveryState: 'acked',
    });
  });
  it('starts a fresh run when the same subject has already finished', async () => {
    const { sqlite, env, submit, input, mailbox } = setup();
    await acceptGitHubTriggerExecution(
      env,
      input('one', 'github:42:7', { subjectAffinity: true }),
      submit
    );
    sqlite.prepare("UPDATE tasks SET status='completed'").run();
    sqlite.prepare("UPDATE trigger_executions SET status='completed'").run();
    expect(
      (
        await acceptGitHubTriggerExecution(
          env,
          input('two', 'github:42:7', { subjectAffinity: true }),
          submit
        )
      ).outcome
    ).toBe('submitted');
    expect(submit).toHaveBeenCalledTimes(2);
    expect(mailbox.size).toBe(0);
  });
  it('fences concurrent reservations while the first task is still being submitted', async () => {
    const { env, submit, input, mailbox } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blockedSubmit = vi.fn(async (...args: Parameters<typeof submit>) => {
      await gate;
      return submit(...args);
    });
    const first = acceptGitHubTriggerExecution(
      env,
      input('one', 'github:42:7', { subjectAffinity: true }),
      blockedSubmit
    );
    await vi.waitFor(() => expect(blockedSubmit).toHaveBeenCalledTimes(1));
    const second = await acceptGitHubTriggerExecution(
      env,
      input('two', 'github:42:7', { subjectAffinity: true }),
      blockedSubmit
    );
    expect(second.outcome).toBe('waiting');
    release();
    await first;
    await drainGitHubTriggerQueue(env, submit);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(mailbox.size).toBe(1);
  });
  it('expires a permanently failing pre-task reservation and then drains the next event', async () => {
    vi.useFakeTimers();
    const { sqlite, env, submit, input } = setup();
    const failing = vi.fn(async () => {
      throw new Error('No task was created');
    });
    await expect(
      acceptGitHubTriggerExecution(env, input('one', 'repo:1', { queueTtlSeconds: 1 }), failing)
    ).rejects.toThrow('pending');
    await acceptGitHubTriggerExecution(env, input('two', 'repo:2'), submit);
    vi.advanceTimersByTime(1001);
    await drainGitHubTriggerQueue(env, submit);
    expect(
      sqlite
        .prepare("SELECT status,skip_reason FROM trigger_executions WHERE github_delivery_id='one'")
        .get()
    ).toEqual({ status: 'dropped', skip_reason: 'queue_expired' });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(
      sqlite.prepare("SELECT status FROM trigger_executions WHERE github_delivery_id='two'").get()
    ).toEqual({ status: 'running' });
  });
  it.each(['getMailboxMessage', 'getSession', 'acceptPromptDelivery'] as const)(
    'bounds persistent %s failures at the absolute routing deadline',
    async (failure) => {
      vi.useFakeTimers();
      const { sqlite, env, submit, input, stub } = setup();
      await acceptGitHubTriggerExecution(
        env,
        input('one', 'github:42:7', { subjectAffinity: true }),
        submit
      );
      stub.acceptPromptDelivery.mockRejectedValue(new Error('ProjectData unavailable'));
      if (failure === 'getMailboxMessage')
        stub.getMailboxMessage.mockRejectedValue(new Error('Receipt unavailable'));
      await expect(
        acceptGitHubTriggerExecution(
          env,
          input('two', 'github:42:7', { subjectAffinity: true, queueTtlSeconds: 1 }),
          submit
        )
      ).rejects.toThrow();
      const read = () =>
        sqlite
          .prepare(
            "SELECT status,skip_reason,routed_execution_id,routed_task_id,routed_session_id FROM trigger_executions WHERE github_delivery_id='two'"
          )
          .get();
      const target = read() as Record<string, unknown>;
      await drainGitHubTriggerQueue(env, submit);
      expect(read()).toEqual(target);
      expect(target.status).toBe('routing');
      if (failure === 'getSession')
        stub.getSession.mockRejectedValue(new Error('Session unavailable'));
      vi.advanceTimersByTime(1001);
      await drainGitHubTriggerQueue(env, submit);
      expect(read()).toEqual({ ...target, status: 'dropped', skip_reason: 'delivery_uncertain' });
      const attempts = stub.getMailboxMessage.mock.calls.length;
      await drainGitHubTriggerQueue(env, submit);
      expect(stub.getMailboxMessage).toHaveBeenCalledTimes(attempts);
      expect(submit).toHaveBeenCalledTimes(1);
    }
  );

  it('reconciles an existing receipt principal after the target task is deleted', async () => {
    const { sqlite, env, submit, input, loseNextAcceptResponse } = setup();
    await acceptGitHubTriggerExecution(
      env,
      input('one', 'github:42:7', { subjectAffinity: true }),
      submit
    );
    loseNextAcceptResponse();
    await expect(
      acceptGitHubTriggerExecution(
        env,
        input('two', 'github:42:7', { subjectAffinity: true }),
        submit
      )
    ).rejects.toThrow();
    sqlite.prepare('DELETE FROM tasks').run();
    await drainGitHubTriggerQueue(env, submit);
    expect(
      sqlite.prepare("SELECT status FROM trigger_executions WHERE github_delivery_id='two'").get()
    ).toEqual({ status: 'routed' });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('bounds a missing task principal without retargeting an in-flight acceptance', async () => {
    vi.useFakeTimers();
    const { sqlite, env, submit, input, stub } = setup();
    await acceptGitHubTriggerExecution(
      env,
      input('one', 'github:42:7', { subjectAffinity: true }),
      submit
    );
    const original = stub.acceptPromptDelivery.getMockImplementation()!;
    let lateAccept: (() => Promise<void>) | undefined;
    let started!: () => void;
    const accepting = new Promise<void>((resolve) => {
      started = resolve;
    });
    stub.acceptPromptDelivery.mockImplementation(
      (...args) =>
        new Promise((resolve) => {
          lateAccept = async () => {
            resolve(await original(...args));
          };
          started();
        })
    );
    const pending = acceptGitHubTriggerExecution(
      env,
      input('two', 'github:42:7', { subjectAffinity: true, queueTtlSeconds: 1 }),
      submit
    );
    await accepting;
    const before = sqlite
      .prepare(
        "SELECT routed_execution_id,routed_task_id,routed_session_id FROM trigger_executions WHERE github_delivery_id='two'"
      )
      .get();
    sqlite.prepare('DELETE FROM tasks').run();
    vi.setSystemTime(Date.now() + 2000);
    await drainGitHubTriggerQueue(env, submit);
    expect(
      sqlite
        .prepare("SELECT status,skip_reason FROM trigger_executions WHERE github_delivery_id='two'")
        .get()
    ).toEqual({ status: 'dropped', skip_reason: 'delivery_uncertain' });
    expect(stub.acceptPromptDelivery).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    if (!lateAccept) throw new Error('Acceptance never started');
    await lateAccept();
    await pending;
    await drainGitHubTriggerQueue(env, submit);
    expect(
      sqlite
        .prepare(
          "SELECT status,skip_reason,routed_execution_id,routed_task_id,routed_session_id FROM trigger_executions WHERE github_delivery_id='two'"
        )
        .get()
    ).toEqual({ ...before, status: 'dropped', skip_reason: 'delivery_uncertain' });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it.each(['failed', 'ambiguous'] as const)(
    'keeps routing pending and preserves uncertainty after %s with possible submission',
    async (state) => {
      const { sqlite, env, submit, input, stub, mailbox } = setup();
      await acceptGitHubTriggerExecution(
        env,
        input('one', 'github:42:7', { subjectAffinity: true }),
        submit
      );
      const original = stub.acceptPromptDelivery.getMockImplementation()!;
      stub.acceptPromptDelivery.mockImplementation(async (...args) => {
        const accepted = await original(...args);
        if (accepted.message && accepted.message.deliveryState === 'acked')
          accepted.message.deliveryState = 'queued';
        return accepted;
      });
      expect(
        (
          await acceptGitHubTriggerExecution(
            env,
            input('two', 'github:42:7', { subjectAffinity: true }),
            submit
          )
        ).outcome
      ).toBe('routing');
      const message = [...mailbox.values()][0];
      message.deliveryState = state;
      message.terminalReason = state === 'failed' ? 'terminal_target' : 'lost_response';
      message.runtimeIdentity = state === 'failed' ? 'possibly-submitted-runtime' : null;
      await drainGitHubTriggerQueue(env, submit);
      expect(
        sqlite
          .prepare(
            "SELECT status,skip_reason FROM trigger_executions WHERE github_delivery_id='two'"
          )
          .get()
      ).toEqual({ status: 'dropped', skip_reason: 'delivery_uncertain' });
      expect(submit).toHaveBeenCalledTimes(1);
    }
  );

  it('safely requeues a terminal target only when its receipt proves no prompt was submitted', async () => {
    const { sqlite, env, submit, input, stub, mailbox } = setup();
    await acceptGitHubTriggerExecution(
      env,
      input('one', 'github:42:7', { subjectAffinity: true }),
      submit
    );
    const original = stub.acceptPromptDelivery.getMockImplementation()!;
    stub.acceptPromptDelivery.mockImplementation(async (...args) => {
      const accepted = await original(...args);
      if (accepted.message && accepted.message.deliveryState === 'acked')
        accepted.message.deliveryState = 'queued';
      return accepted;
    });
    await acceptGitHubTriggerExecution(
      env,
      input('two', 'github:42:7', { subjectAffinity: true }),
      submit
    );
    const message = [...mailbox.values()][0];
    message.deliveryState = 'failed';
    message.terminalReason = 'terminal_target';
    sqlite.prepare("UPDATE tasks SET status='completed'").run();
    sqlite
      .prepare("UPDATE trigger_executions SET status='completed' WHERE task_id IS NOT NULL")
      .run();
    await drainGitHubTriggerQueue(env, submit);
    expect(
      sqlite.prepare("SELECT status FROM trigger_executions WHERE github_delivery_id='two'").get()
    ).toEqual({ status: 'waiting' });
    await drainGitHubTriggerQueue(env, submit);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(
      sqlite.prepare("SELECT status FROM trigger_executions WHERE github_delivery_id='two'").get()
    ).toEqual({ status: 'running' });
  });
  it('keeps subject ownership and capacity through repeated VM recovery handoffs', async () => {
    const { sqlite, env, submit, input, mailbox } = setup();
    const first = await acceptGitHubTriggerExecution(
      env,
      input('one', 'github:42:7', { subjectAffinity: true }),
      submit
    );
    sqlite.prepare("UPDATE trigger_executions SET status='failed' WHERE task_id IS NOT NULL").run();
    sqlite
      .prepare(
        "UPDATE tasks SET status='cancelled',chat_session_id=NULL,superseded_by_task_id='recovery-one'"
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO tasks(id,project_id,user_id,status,chat_session_id,recovery_source_task_id,triggered_by) VALUES('recovery-one','p','u','in_progress',?,?,'session-recovery')"
      )
      .run(first.sessionId, first.taskId);
    expect(
      (
        await acceptGitHubTriggerExecution(
          env,
          input('two', 'github:42:7', { subjectAffinity: true }),
          submit
        )
      ).taskId
    ).toBe('recovery-one');
    expect(
      (
        await acceptGitHubTriggerExecution(
          env,
          input('other', 'github:42:8', { subjectAffinity: true }),
          submit
        )
      ).outcome
    ).toBe('waiting');
    sqlite
      .prepare(
        "UPDATE tasks SET status='cancelled',chat_session_id=NULL,superseded_by_task_id='recovery-two' WHERE id='recovery-one'"
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO tasks(id,project_id,user_id,status,chat_session_id,recovery_source_task_id,triggered_by) VALUES('recovery-two','p','u','in_progress',?,'recovery-one','session-recovery')"
      )
      .run(first.sessionId);
    expect(
      (
        await acceptGitHubTriggerExecution(
          env,
          input('three', 'github:42:7', { subjectAffinity: true }),
          submit
        )
      ).taskId
    ).toBe('recovery-two');
    expect(submit).toHaveBeenCalledTimes(1);
    expect([...mailbox.values()].map((message) => message.sourceTaskId)).toEqual([
      'recovery-one',
      'recovery-two',
    ]);
  });
});
