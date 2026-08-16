import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import type { DurableExecutionConfig } from '../../../src/durable-objects/project-data/durable-execution-config';
import * as mailbox from '../../../src/durable-objects/project-data/mailbox';
import {
  acceptPromptDelivery,
  applyPromptDeliveryResult,
  claimDuePromptDeliveries,
  expireDuePromptDeliveries,
  nudgePromptDeliveriesForTarget,
} from '../../../src/durable-objects/project-data/prompt-delivery';
import { runPromptDeliveryClaim } from '../../../src/durable-objects/project-data/prompt-delivery-runner';
import type { VmPromptDeliveryAdapter } from '../../../src/services/vm-prompt-delivery-adapter';
import { createSqlStorage } from './sql-storage-test-utils';

const config: DurableExecutionConfig = {
  deliveryEnabled: true,
  legacyVmCompatEnabled: false,
  supervisorEnabled: false,
  checkpointThresholdMs: 18_000_000,
  preemptGraceMs: 30_000,
  maxCandidatesPerAlarm: 5,
  maxAttempts: 3,
  retryBaseMs: 5_000,
  retryMaxMs: 20_000,
  ttlMs: 60_000,
  receiptTimeoutMs: 10_000,
  backgroundTimeoutMs: 5_000,
  minAlarmDelayMs: 1_000,
};

const capabilities = {
  protocolVersion: 1,
  runtimeIdentity: 'runtime-1',
  promptReceipts: {
    supported: true,
    lookup: true,
    states: ['accepted', 'in_flight', 'completed', 'not_found', 'ambiguous'] as const,
  },
  checkpointRollover: {
    supported: true,
    automatic: true,
    states: ['requested', 'stopping', 'resuming', 'completed', 'failed'] as const,
    defaultGraceMs: 30_000,
    maxGraceMs: 120_000,
    operationTimeoutMs: 300_000,
  },
};

describe('ProjectData durable prompt delivery', () => {
  let db: Database.Database;
  let sql: SqlStorage;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
    sql.exec(
      `INSERT INTO chat_sessions
       (id, workspace_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES ('chat-1', 'workspace-1', 'Test', 'active', 0, 10000, 10000, 10000)`
    );
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  function accept(
    deliveryId = 'delivery-1',
    ttlMs = config.ttlMs,
    sourceKind: 'user_followup' | 'agent_mailbox' = 'user_followup'
  ) {
    return acceptPromptDelivery(
      sql,
      {},
      {
        deliveryId,
        targetSessionId: 'chat-1',
        displayContent: 'Visible follow-up',
        deliveryContent: 'Enriched follow-up',
        senderType: 'human',
        senderId: 'user-1',
        messageClass: 'deliver',
        sourceKind,
        ttlMs,
      },
      Date.now()
    );
  }

  const hooks = {
    projectId: 'project-1',
    recalculateAlarm: vi.fn(async () => {}),
    broadcastEvent: vi.fn(),
  };

  it('persists one transcript message and one queue record idempotently', () => {
    const first = accept();
    const second = accept();

    expect(first.transcriptInserted).toBe(true);
    expect(second.transcriptInserted).toBe(false);
    expect(second.message.id).toBe(first.message.id);
    expect(db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_inbox').get()).toEqual({ count: 1 });
    expect(first.message.promptMessageId).toBe(first.transcriptMessageId);
  });

  it('rejects reuse of a stable delivery identity for different prompt intent', () => {
    accept();
    expect(() =>
      acceptPromptDelivery(
        sql,
        {},
        {
          deliveryId: 'delivery-1',
          targetSessionId: 'chat-1',
          displayContent: 'different',
          deliveryContent: 'different',
          senderType: 'human',
          sourceKind: 'user_followup',
        },
        Date.now()
      )
    ).toThrow('different prompt intent');
  });

  it('retries busy delivery on readiness and accepts it exactly once despite duplicate alarms', async () => {
    accept();
    const submit = vi
      .fn<VmPromptDeliveryAdapter['submit']>()
      .mockResolvedValueOnce({
        kind: 'retry',
        reason: 'busy',
        error: 'prompt in flight',
        runtimeIdentity: 'runtime-1',
        capabilities,
      })
      .mockResolvedValueOnce({
        kind: 'accepted',
        acpSessionId: 'acp-1',
        promptEpoch: 12_000,
        runtimeIdentity: 'runtime-1',
        capabilities,
        receipt: {
          deliveryId: 'delivery-1',
          state: 'accepted',
          runtimeIdentity: 'runtime-1',
          acceptedAt: 12_000,
          completedAt: null,
        },
      });
    const adapter: VmPromptDeliveryAdapter = {
      submit,
      reconcile: vi.fn(),
    };

    const firstClaim = claimDuePromptDeliveries(sql, config, 10_000);
    expect(firstClaim).toHaveLength(1);
    expect(claimDuePromptDeliveries(sql, config, 10_000)).toHaveLength(0);
    await runPromptDeliveryClaim(sql, {}, config, firstClaim[0]!, adapter, hooks);
    expect(mailbox.getMessage(sql, 'delivery-1')?.deliveryState).toBe('retry_wait');
    expect(mailbox.getMessage(sql, 'delivery-1')?.nextAttemptAt).toBe(15_000);
    expect(claimDuePromptDeliveries(sql, config, 14_999)).toHaveLength(0);

    expect(nudgePromptDeliveriesForTarget(sql, 'chat-1', 12_000)).toBe(1);
    vi.setSystemTime(12_000);
    const readyClaim = claimDuePromptDeliveries(sql, config, 12_000);
    expect(readyClaim).toHaveLength(1);
    expect(claimDuePromptDeliveries(sql, config, 12_000)).toHaveLength(0);
    await runPromptDeliveryClaim(sql, {}, config, readyClaim[0]!, adapter, hooks);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(mailbox.getMessage(sql, 'delivery-1')?.deliveryState).toBe('acked');
    expect(mailbox.getMessage(sql, 'delivery-1')?.acceptedAt).toBe(12_000);
    expect(claimDuePromptDeliveries(sql, config, 40_000)).toHaveLength(0);
  });

  it('fails a parent wake claim before adapter recovery when the parent is terminal', async () => {
    acceptPromptDelivery(
      sql,
      {},
      {
        deliveryId: 'parent-wake-1',
        targetSessionId: 'chat-1',
        displayContent: 'trusted wake',
        deliveryContent: 'trusted wake',
        sourceTaskId: 'parent-task-1',
        senderType: 'system',
        sourceKind: 'parent_wakeup',
        metadata: { waitId: 'wait-1', childTaskIds: ['child-task-1'] },
      },
      Date.now()
    );
    const [claim] = claimDuePromptDeliveries(sql, config, Date.now());
    const submit = vi.fn<VmPromptDeliveryAdapter['submit']>();
    const adapter: VmPromptDeliveryAdapter = { submit, reconcile: vi.fn() };
    const env = {
      DATABASE: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({
            all: vi.fn().mockResolvedValue({
              results: [
                {
                  id: 'parent-task-1',
                  status: 'completed',
                  chat_session_id: 'chat-1',
                  parent_task_id: null,
                },
                {
                  id: 'child-task-1',
                  status: 'completed',
                  chat_session_id: 'child-chat-1',
                  parent_task_id: 'parent-task-1',
                },
              ],
            }),
          })),
        })),
      },
    } as never;

    await expect(
      runPromptDeliveryClaim(sql, env, config, claim!, adapter, hooks)
    ).resolves.toMatchObject({ kind: 'failed', reason: 'terminal_target' });
    expect(submit).not.toHaveBeenCalled();
    expect(mailbox.getMessage(sql, 'parent-wake-1')).toMatchObject({
      deliveryState: 'failed',
      terminalReason: 'terminal_target',
    });
  });

  it('accepts the recovery task as session owner while preserving the live source parent', async () => {
    acceptPromptDelivery(
      sql,
      {},
      {
        deliveryId: 'parent-wake-recovery-owner',
        targetSessionId: 'chat-1',
        displayContent: 'trusted wake',
        sourceTaskId: 'parent-task-1',
        senderType: 'system',
        sourceKind: 'parent_wakeup',
        metadata: { waitId: 'wait-1', childTaskIds: ['child-task-1'] },
      },
      Date.now()
    );
    const [claim] = claimDuePromptDeliveries(sql, config, Date.now());
    const submit = vi.fn<VmPromptDeliveryAdapter['submit']>().mockResolvedValue({
      kind: 'retry',
      reason: 'not_ready',
      error: 'replacement runtime is starting',
      runtimeIdentity: null,
      capabilities: null,
    });
    const env = {
      DATABASE: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({
            all: vi.fn().mockResolvedValue({
              results: [
                {
                  id: 'parent-task-1',
                  status: 'awaiting_followup',
                  chat_session_id: null,
                  parent_task_id: null,
                  recovery_source_task_id: null,
                  triggered_by: 'mcp',
                },
                {
                  id: 'child-task-1',
                  status: 'completed',
                  chat_session_id: 'child-chat-1',
                  parent_task_id: 'parent-task-1',
                  recovery_source_task_id: null,
                  triggered_by: 'mcp',
                },
                {
                  id: 'recovery-task-1',
                  status: 'queued',
                  chat_session_id: 'chat-1',
                  parent_task_id: null,
                  recovery_source_task_id: 'parent-task-1',
                  triggered_by: 'session-recovery',
                },
              ],
            }),
          })),
        })),
      },
    } as never;

    await expect(
      runPromptDeliveryClaim(sql, env, config, claim!, { submit, reconcile: vi.fn() }, hooks)
    ).resolves.toMatchObject({ kind: 'retry', reason: 'not_ready' });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('retries a parent wake when target validation storage is temporarily unavailable', async () => {
    acceptPromptDelivery(
      sql,
      {},
      {
        deliveryId: 'parent-wake-read-retry',
        targetSessionId: 'chat-1',
        displayContent: 'trusted wake',
        sourceTaskId: 'parent-task-1',
        senderType: 'system',
        sourceKind: 'parent_wakeup',
        metadata: { waitId: 'wait-1', childTaskIds: ['child-task-1'] },
      },
      Date.now()
    );
    const [claim] = claimDuePromptDeliveries(sql, config, Date.now());
    const submit = vi.fn<VmPromptDeliveryAdapter['submit']>();
    const env = {
      DATABASE: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({ all: vi.fn().mockRejectedValue(new Error('D1 unavailable')) })),
        })),
      },
    } as never;

    await expect(
      runPromptDeliveryClaim(sql, env, config, claim!, { submit, reconcile: vi.fn() }, hooks)
    ).resolves.toMatchObject({ kind: 'retry', reason: 'not_ready' });
    expect(submit).not.toHaveBeenCalled();
    expect(mailbox.getMessage(sql, 'parent-wake-read-retry')).toMatchObject({
      deliveryState: 'retry_wait',
      terminalReason: null,
    });
  });

  it('revalidates parent state inside the adapter boundary before side effects', async () => {
    acceptPromptDelivery(
      sql,
      {},
      {
        deliveryId: 'parent-wake-race',
        targetSessionId: 'chat-1',
        displayContent: 'trusted wake',
        sourceTaskId: 'parent-task-1',
        senderType: 'system',
        sourceKind: 'parent_wakeup',
        metadata: { waitId: 'wait-1', childTaskIds: ['child-task-1'] },
      },
      Date.now()
    );
    const [claim] = claimDuePromptDeliveries(sql, config, Date.now());
    let validationCount = 0;
    const all = vi.fn(async () => {
      validationCount++;
      return {
        results: [
          {
            id: 'parent-task-1',
            status: validationCount === 1 ? 'in_progress' : 'completed',
            chat_session_id: 'chat-1',
            parent_task_id: null,
          },
          {
            id: 'child-task-1',
            status: 'completed',
            chat_session_id: 'child-chat-1',
            parent_task_id: 'parent-task-1',
          },
        ],
      };
    });
    const env = {
      DATABASE: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ all })) })) },
    } as never;
    const sideEffect = vi.fn();
    const submit = vi.fn<VmPromptDeliveryAdapter['submit']>(async (input) => {
      const guarded = await input.beforeSideEffect?.();
      if (guarded) return guarded;
      sideEffect();
      throw new Error('guard unexpectedly allowed side effect');
    });

    await expect(
      runPromptDeliveryClaim(sql, env, config, claim!, { submit, reconcile: vi.fn() }, hooks)
    ).resolves.toMatchObject({ kind: 'failed', reason: 'terminal_target' });
    expect(validationCount).toBe(2);
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('fails a queued parent wake when a child was reparented after enqueue', async () => {
    acceptPromptDelivery(
      sql,
      {},
      {
        deliveryId: 'parent-wake-reparented',
        targetSessionId: 'chat-1',
        displayContent: 'trusted wake',
        sourceTaskId: 'parent-task-1',
        senderType: 'system',
        sourceKind: 'parent_wakeup',
        metadata: { waitId: 'wait-1', childTaskIds: ['child-task-1'] },
      },
      Date.now()
    );
    const [claim] = claimDuePromptDeliveries(sql, config, Date.now());
    const env = {
      DATABASE: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({
            all: vi.fn().mockResolvedValue({
              results: [
                {
                  id: 'parent-task-1',
                  status: 'in_progress',
                  chat_session_id: 'chat-1',
                  parent_task_id: null,
                },
                {
                  id: 'child-task-1',
                  status: 'completed',
                  chat_session_id: 'child-chat-1',
                  parent_task_id: 'other-parent',
                },
              ],
            }),
          })),
        })),
      },
    } as never;
    const submit = vi.fn<VmPromptDeliveryAdapter['submit']>();

    await expect(
      runPromptDeliveryClaim(sql, env, config, claim!, { submit, reconcile: vi.fn() }, hooks)
    ).resolves.toMatchObject({ kind: 'failed', reason: 'terminal_target' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps a cold-start busy delivery retryable at the attempt cap until TTL', () => {
    accept();
    let now = 10_000;

    for (let attempt = 0; attempt < config.maxAttempts + 2; attempt += 1) {
      const [claim] = claimDuePromptDeliveries(sql, config, now);
      expect(claim?.mode).toBe('submit');
      expect(
        applyPromptDeliveryResult(
          sql,
          claim!,
          {
            kind: 'retry',
            reason: 'not_ready',
            error: 'replacement agent is still starting',
            runtimeIdentity: 'runtime-1',
            capabilities,
          },
          config,
          now
        )
      ).toBe(true);

      const pending = mailbox.getMessage(sql, 'delivery-1');
      expect(pending?.deliveryState).toBe('retry_wait');
      expect(pending?.terminalReason).toBeNull();
      expect(pending?.deliveryAttempts).toBeLessThan(config.maxAttempts);
      now = pending!.nextAttemptAt!;
    }

    expect(expireDuePromptDeliveries(sql, config, 69_999)).toEqual({ expired: 0, failed: 0 });
    expect(mailbox.getMessage(sql, 'delivery-1')?.deliveryState).toBe('retry_wait');
    expect(expireDuePromptDeliveries(sql, config, 70_000)).toEqual({ expired: 1, failed: 0 });
    expect(mailbox.getMessage(sql, 'delivery-1')?.terminalReason).toBe('ttl_expired');
  });

  it('reconciles a stale in-flight attempt without replaying it', () => {
    accept();
    const [claim] = claimDuePromptDeliveries(sql, config, 10_000);
    expect(claim?.mode).toBe('submit');

    const [reconciliation] = claimDuePromptDeliveries(sql, config, 20_000);
    expect(reconciliation?.mode).toBe('reconcile');
    expect(reconciliation?.message.deliveryAttempts).toBe(1);
    expect(claimDuePromptDeliveries(sql, config, 20_000)).toHaveLength(0);
  });

  it.each([
    ['terminal_target', 'Target session completed'],
    ['dead_target', 'Target node is unavailable'],
  ] as const)('fails %s targets explicitly', (reason, error) => {
    accept();
    const [claim] = claimDuePromptDeliveries(sql, config, 10_000);
    expect(
      applyPromptDeliveryResult(
        sql,
        claim!,
        {
          kind: 'failed',
          reason,
          error,
          runtimeIdentity: null,
          capabilities: null,
        },
        config,
        10_100
      )
    ).toBe(true);

    const message = mailbox.getMessage(sql, 'delivery-1');
    expect(message?.deliveryState).toBe('failed');
    expect(message?.terminalReason).toBe(reason);
    expect(message?.lastError).toBe(error);
  });

  it('marks cross-runtime uncertainty ambiguous and never requeues it', () => {
    accept();
    const [claim] = claimDuePromptDeliveries(sql, config, 10_000);
    expect(
      applyPromptDeliveryResult(
        sql,
        claim!,
        {
          kind: 'ambiguous',
          reason: 'runtime_changed',
          error: 'runtime identity changed',
          runtimeIdentity: 'runtime-2',
          capabilities,
          receipt: null,
        },
        config,
        10_100
      )
    ).toBe(true);

    const message = mailbox.getMessage(sql, 'delivery-1');
    expect(message?.deliveryState).toBe('ambiguous');
    expect(message?.terminalReason).toBe('runtime_changed');
    expect(claimDuePromptDeliveries(sql, config, 100_000)).toHaveLength(0);
  });

  it('expires by TTL and fails exhausted attempts without claiming either row', () => {
    accept('ttl-delivery', 100);
    accept('attempt-delivery');
    sql.exec(
      `UPDATE session_inbox SET delivery_attempts = ? WHERE id = 'attempt-delivery'`,
      config.maxAttempts
    );

    expect(expireDuePromptDeliveries(sql, config, 10_100)).toEqual({ expired: 1, failed: 1 });
    expect(mailbox.getMessage(sql, 'ttl-delivery')?.deliveryState).toBe('expired');
    expect(mailbox.getMessage(sql, 'attempt-delivery')?.deliveryState).toBe('failed');
    expect(claimDuePromptDeliveries(sql, config, 10_100)).toHaveLength(0);
  });

  it('keeps durable delivery states out of the legacy mailbox expiry sweep', () => {
    accept('durable-expired', 100, 'agent_mailbox');
    accept('durable-exhausted', config.ttlMs, 'agent_mailbox');
    mailbox.enqueueMessage(sql, {
      id: 'legacy-expired',
      targetSessionId: 'chat-1',
      sourceTaskId: null,
      senderType: 'system',
      senderId: null,
      messageClass: 'deliver',
      content: 'legacy mailbox delivery',
      sourceKind: 'agent_mailbox',
      ttlMs: 100,
      now: 10_000,
    });
    sql.exec(
      `UPDATE session_inbox SET delivery_attempts = ? WHERE id = 'durable-exhausted'`,
      config.maxAttempts
    );

    vi.setSystemTime(10_100);
    expect(mailbox.expireStaleMessages(sql, config.maxAttempts)).toBe(1);
    expect(mailbox.getMessage(sql, 'durable-expired')?.deliveryState).toBe('queued');
    expect(mailbox.getMessage(sql, 'durable-exhausted')?.deliveryState).toBe('queued');
    expect(mailbox.getMessage(sql, 'legacy-expired')?.deliveryState).toBe('expired');

    expect(expireDuePromptDeliveries(sql, config, 10_100)).toEqual({ expired: 1, failed: 1 });
    expect(mailbox.getMessage(sql, 'durable-expired')?.terminalReason).toBe('ttl_expired');
    expect(mailbox.getMessage(sql, 'durable-exhausted')?.terminalReason).toBe(
      'max_attempts_exceeded'
    );
  });
});
