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
       VALUES ('chat-1', 'workspace-1', 'Test', 'active', 0, 10000, 10000, 10000)`,
    );
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  function accept(deliveryId = 'delivery-1', ttlMs = config.ttlMs) {
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
        sourceKind: 'user_followup',
        ttlMs,
      },
      Date.now(),
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
        Date.now(),
      ),
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
        10_100,
      ),
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
        10_100,
      ),
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
      config.maxAttempts,
    );

    expect(expireDuePromptDeliveries(sql, config, 10_100)).toEqual({ expired: 1, failed: 1 });
    expect(mailbox.getMessage(sql, 'ttl-delivery')?.deliveryState).toBe('expired');
    expect(mailbox.getMessage(sql, 'attempt-delivery')?.deliveryState).toBe('failed');
    expect(claimDuePromptDeliveries(sql, config, 10_100)).toHaveLength(0);
  });

  it('keeps durable delivery states out of the legacy mailbox expiry sweep', () => {
    accept('durable-expired', 100);
    accept('durable-exhausted');
    sql.exec(
      `UPDATE session_inbox SET delivery_attempts = ? WHERE id = 'durable-exhausted'`,
      config.maxAttempts,
    );

    vi.setSystemTime(10_100);
    expect(mailbox.expireStaleMessages(sql, config.maxAttempts)).toBe(0);
    expect(mailbox.getMessage(sql, 'durable-expired')?.deliveryState).toBe('queued');
    expect(mailbox.getMessage(sql, 'durable-exhausted')?.deliveryState).toBe('queued');

    expect(expireDuePromptDeliveries(sql, config, 10_100)).toEqual({ expired: 1, failed: 1 });
    expect(mailbox.getMessage(sql, 'durable-expired')?.terminalReason).toBe('ttl_expired');
    expect(mailbox.getMessage(sql, 'durable-exhausted')?.terminalReason).toBe(
      'max_attempts_exceeded',
    );
  });
});
