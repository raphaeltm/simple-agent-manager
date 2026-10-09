import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import {
  acceptPromptDelivery,
  type DurabilityFoundationHooks,
  processPromptDeliveryAlarm,
  reportActivity,
} from '../../../src/durable-objects/project-data/durability-foundation';
import { resolveDurableExecutionConfig } from '../../../src/durable-objects/project-data/durable-execution-config';
import {
  computePromptDeliveryAlarmTime,
  nudgePromptDeliveriesForTarget,
  type PromptDeliveryResult,
} from '../../../src/durable-objects/project-data/prompt-delivery';
import { DefaultVmPromptDeliveryAdapter } from '../../../src/services/vm-prompt-delivery-adapter';
import { versionedPromptCapabilities } from '../../helpers/vm-prompt-delivery-fixtures';
import { createSqlStorage } from './sql-storage-test-utils';

const config = resolveDurableExecutionConfig({});
const capabilities = versionedPromptCapabilities('runtime');
const busy: PromptDeliveryResult = {
  kind: 'retry',
  reason: 'busy',
  error: 'turn in progress',
  runtimeIdentity: 'runtime',
  capabilities,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('busy target through the delivery alarm', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  let pending: Promise<unknown>[];
  let hooks: DurabilityFoundationHooks;
  let due: number | null;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
    for (const id of ['busy', 'other']) {
      sql.exec(
        `INSERT INTO chat_sessions
        (id, workspace_id, topic, status, message_count, started_at, created_at, updated_at)
        VALUES (?, ?, 'test', 'active', 0, ?, ?, ?)`,
        id,
        `workspace-${id}`,
        Date.now(),
        Date.now(),
        Date.now()
      );
    }
    pending = [];
    due = null;
    hooks = {
      getProjectId: () => 'project',
      transactionSync: (fn) => db.transaction(fn)(),
      waitUntil: (promise) => {
        pending.push(promise);
      },
      recalculateAlarm: async () => {
        due = computePromptDeliveryAlarmTime(sql, config);
      },
      scheduleSummarySync: vi.fn(),
      broadcastEvent: vi.fn(),
      armIdleCleanup: vi.fn(),
      nudgeDeliveries: (id) => nudgePromptDeliveriesForTarget(sql, id),
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    db.close();
  });

  async function enqueue(
    id: string,
    targetSessionId = 'busy',
    messageClass: 'notify' | 'deliver' | 'interrupt' = 'notify',
    ttlMs = config.ttlMs
  ) {
    await acceptPromptDelivery(sql, {}, hooks, {
      deliveryId: id,
      targetSessionId,
      displayContent: id,
      senderType: 'agent',
      sourceKind: 'agent_mailbox',
      messageClass,
      ttlMs,
    });
  }
  async function drain() {
    const work = pending.splice(0);
    await Promise.all(work);
    await hooks.recalculateAlarm();
  }
  async function tick() {
    expect(due).not.toBeNull();
    vi.setSystemTime(due!);
    processPromptDeliveryAlarm(sql, {}, hooks);
    await drain();
  }
  function rows() {
    return db
      .prepare('SELECT id, delivery_state, delivery_attempts FROM session_inbox ORDER BY rowid')
      .all() as Array<{ id: string; delivery_state: string; delivery_attempts: number }>;
  }
  function acceptAtRuntime(
    input: Parameters<DefaultVmPromptDeliveryAdapter['submit']>[0]
  ): PromptDeliveryResult {
    expect(input.beforeSubmit?.(capabilities)).toBe(true);
    return {
      kind: 'accepted',
      acpSessionId: input.claim.message.targetSessionId,
      promptEpoch: Date.now(),
      runtimeIdentity: 'runtime',
      capabilities,
      receipt: null,
    };
  }

  it('uses one capped exponential retry stream for 76 messages, then delivers all in FIFO order', async () => {
    let isBusy = true;
    const accepted: string[] = [];
    const submit = vi
      .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit')
      .mockImplementation(async (input) => {
        if (input.claim.message.targetSessionId === 'busy' && isBusy) return busy;
        accepted.push(input.claim.message.id);
        return acceptAtRuntime(input);
      });
    for (let i = 0; i < 76; i++) await enqueue(`message-${i}`);
    const start = Date.now();
    let alarms = 0;
    while (due! < start + 600_000) {
      await tick();
      alarms++;
      // Adding messages during the blocked interval must not reset target backoff.
      if (alarms === 4) await enqueue('late-arrival');
      expect(accepted).toEqual([]);
    }
    expect(alarms).toBeLessThanOrEqual(8);
    expect(submit).toHaveBeenCalledTimes(alarms);
    expect(db.prepare('SELECT busy_attempts FROM prompt_delivery_target_backoff').get()).toEqual({
      busy_attempts: alarms,
    });
    expect(due! - Date.now()).toBe(config.retryMaxMs);
    expect(rows()).toHaveLength(77);
    expect(rows().filter((row) => row.delivery_attempts > 0)).toHaveLength(1);

    // Another target must make progress before the busy recipient is released.
    await enqueue('independent', 'other');
    await tick();
    expect(accepted).toEqual(['independent']);
    isBusy = false;
    await reportActivity(sql, hooks, 'busy', 'idle', { observedAt: Date.now() });
    expect(due).toBe(Date.now() + config.minAlarmDelayMs);
    while (due !== null) await tick();
    expect(accepted).toEqual([
      'independent',
      ...Array.from({ length: 76 }, (_, i) => `message-${i}`),
      'late-arrival',
    ]);
    expect(rows().every((row) => row.delivery_state === 'acked')).toBe(true);
    processPromptDeliveryAlarm(sql, {}, hooks);
    await drain();
    expect(new Set(accepted).size).toBe(78);
    expect(db.prepare('SELECT * FROM prompt_delivery_target_backoff').all()).toEqual([]);
  });

  it('latches a real idle report at the busy-response midpoint without duplicating the in-flight claim', async () => {
    const entered = deferred<void>();
    const response = deferred<PromptDeliveryResult>();
    const accepted: string[] = [];
    const submit = vi
      .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit')
      .mockImplementationOnce(async () => {
        entered.resolve();
        return response.promise;
      })
      .mockImplementation(async (input) => {
        accepted.push(input.claim.message.id);
        return acceptAtRuntime(input);
      });
    await enqueue('first');
    processPromptDeliveryAlarm(sql, {}, hooks);
    await entered.promise;
    for (let i = 0; i < 20; i++) await enqueue(`behind-${i}`);
    await reportActivity(sql, hooks, 'busy', 'idle', { observedAt: Date.now() });
    processPromptDeliveryAlarm(sql, {}, hooks);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(rows().filter((row) => row.delivery_state === 'delivering')).toHaveLength(1);
    response.resolve(busy);
    await drain();
    expect(due).toBe(Date.now() + config.minAlarmDelayMs);
    while (due !== null) await tick();
    expect(accepted).toEqual(['first', ...Array.from({ length: 20 }, (_, i) => `behind-${i}`)]);
    expect(submit).toHaveBeenCalledTimes(22);
  });

  it('retains the target deadline when a new informational head arrives or an older head expires', async () => {
    const submit = vi
      .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit')
      .mockResolvedValue(busy);
    await enqueue('short-lived', 'busy', 'notify', 3000);
    await tick();
    const retryAt = Date.now() + config.retryBaseMs;
    await enqueue('higher-information', 'busy', 'deliver');
    await tick(); // TTL wake expires the old head, not permission to retry the target.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(due).toBe(retryAt);
    await tick();
    expect(submit.mock.calls.map(([input]) => input.claim.message.id)).toEqual([
      'short-lived',
      'higher-information',
    ]);
    expect(due).toBe(Date.now() + config.retryBaseMs * 2);
  });

  it('does not let a late reclaimed attempt overwrite the newer target backoff', async () => {
    const entered = deferred<void>();
    const response = deferred<PromptDeliveryResult>();
    const submit = vi
      .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit')
      .mockImplementationOnce(async () => {
        entered.resolve();
        return response.promise;
      })
      .mockResolvedValue(busy);
    await enqueue('first');
    processPromptDeliveryAlarm(sql, {}, hooks);
    await entered.promise;
    vi.setSystemTime(Date.now() + config.receiptTimeoutMs);
    processPromptDeliveryAlarm(sql, {}, hooks);
    await pending[1];
    expect(submit).toHaveBeenCalledTimes(2);
    const before = db.prepare('SELECT * FROM prompt_delivery_target_backoff').get();
    expect(before).toMatchObject({ busy_attempts: 1 });
    response.resolve(busy);
    await drain();
    expect(db.prepare('SELECT * FROM prompt_delivery_target_backoff').get()).toEqual(before);
    expect(rows()).toEqual([{ id: 'first', delivery_state: 'retry_wait', delivery_attempts: 1 }]);
  });

  it('limits each alarm batch and reaches recipients beyond a full busy batch', async () => {
    const submit = vi
      .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit')
      .mockResolvedValue(busy);
    const targetCount = config.maxCandidatesPerAlarm + 2;
    for (let i = 0; i < targetCount; i++) {
      const target = `recipient-${i}`;
      sql.exec(
        `INSERT INTO chat_sessions
        (id, status, message_count, started_at, created_at, updated_at)
        VALUES (?, 'active', 0, ?, ?, ?)`,
        target,
        Date.now(),
        Date.now(),
        Date.now()
      );
      await enqueue(`for-${target}`, target);
    }
    await tick();
    expect(submit).toHaveBeenCalledTimes(config.maxCandidatesPerAlarm);
    expect(due).toBe(Date.now() + config.minAlarmDelayMs);
    await tick();
    expect(submit).toHaveBeenCalledTimes(targetCount);
    expect(
      new Set(submit.mock.calls.map(([input]) => input.claim.message.targetSessionId)).size
    ).toBe(targetCount);
    expect(rows().every((row) => row.delivery_state === 'retry_wait')).toBe(true);
  });

  it('allows higher-priority control to run during informational backoff', async () => {
    const submit = vi
      .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit')
      .mockResolvedValue(busy);
    await enqueue('information');
    await tick();
    expect(due).toBe(Date.now() + config.retryBaseMs);
    await enqueue('urgent', 'busy', 'interrupt');
    expect(due).toBe(Date.now() + config.minAlarmDelayMs);
    await tick();
    expect(submit.mock.calls.map(([input]) => input.claim.message.id)).toEqual([
      'information',
      'urgent',
    ]);
  });
});
