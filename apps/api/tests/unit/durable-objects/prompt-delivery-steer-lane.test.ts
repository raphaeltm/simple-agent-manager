/**
 * Live steering through the real ProjectData delivery alarm (idea 01M2EPH9WGDYFDQBZCP9QY1FDE).
 * The VM adapter is stubbed at its boundary; claim selection, result application, the
 * transcript label and the queue fallback all run for real against SQLite.
 */
import type { VmPromptDeliveryCapabilities } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acceptPromptDelivery,
  type DurabilityFoundationHooks,
  processPromptDeliveryAlarm,
} from '@simple-agent-manager/project-data/internal/do/durability-foundation';
import { resolveDurableExecutionConfig } from '@simple-agent-manager/project-data/internal/do/durable-execution-config';
import { runMigrations } from '@simple-agent-manager/project-data/internal/do/migrations';
import {
  computePromptDeliveryAlarmTime,
  nudgePromptDeliveriesForTarget,
  type PromptDeliveryResult,
} from '@simple-agent-manager/project-data/internal/do/prompt-delivery';
import { DefaultVmPromptDeliveryAdapter } from '../../../src/services/vm-prompt-delivery-adapter';
import { versionedPromptCapabilities } from '../../helpers/vm-prompt-delivery-fixtures';
import { createSqlStorage } from './sql-storage-test-utils';

const config = resolveDurableExecutionConfig({});
const capabilities: VmPromptDeliveryCapabilities = {
  ...versionedPromptCapabilities('runtime'),
  steering: {
    supported: true,
    version: 1,
    lookup: true,
    states: ['accepted', 'in_flight', 'injected', 'not_consumed', 'ambiguous'],
  },
};
const busy: PromptDeliveryResult = {
  kind: 'retry',
  reason: 'busy',
  error: 'turn in progress',
  runtimeIdentity: 'runtime',
  capabilities,
};
const TURN_EPOCH = 900_000;
const steered: PromptDeliveryResult = {
  kind: 'steered',
  promptEpoch: TURN_EPOCH,
  runtimeIdentity: 'runtime',
  capabilities,
  receipt: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('steer lane through the delivery alarm', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  let pending: Promise<unknown>[];
  let hooks: DurabilityFoundationHooks;
  let due: number | null;
  let broadcasts: Array<{ type: string; payload: Record<string, unknown> }>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
    sql.exec(
      `INSERT INTO chat_sessions
       (id, workspace_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES ('busy', 'workspace-busy', 'test', 'active', 0, ?, ?, ?)`,
      Date.now(),
      Date.now(),
      Date.now()
    );
    pending = [];
    due = null;
    broadcasts = [];
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
      broadcastEvent: (type, payload) => {
        broadcasts.push({ type, payload });
      },
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
    deliveryIntent: 'queue' | 'steer',
    messageClass: 'notify' | 'deliver' | 'interrupt' = 'deliver'
  ) {
    await acceptPromptDelivery(sql, {}, hooks, {
      deliveryId: id,
      targetSessionId: 'busy',
      displayContent: id,
      senderType: 'agent',
      sourceKind: 'agent_mailbox',
      messageClass,
      deliveryIntent,
    });
  }
  async function drain() {
    await Promise.all(pending.splice(0));
    await hooks.recalculateAlarm();
  }
  async function tick() {
    expect(due).not.toBeNull();
    vi.setSystemTime(Math.max(due!, Date.now()));
    processPromptDeliveryAlarm(sql, {}, hooks);
    await drain();
  }
  function row(id: string) {
    return db
      .prepare(
        `SELECT delivery_state, delivery_intent, steer_outcome, steer_reason, delivery_attempts
         FROM session_inbox WHERE id = ?`
      )
      .get(id) as {
      delivery_state: string;
      delivery_intent: string;
      steer_outcome: string | null;
      steer_reason: string | null;
      delivery_attempts: number;
    };
  }
  function transcriptMetadata(id: string): Record<string, unknown> {
    const message = db
      .prepare(
        `SELECT tool_metadata FROM chat_messages
         WHERE json_extract(tool_metadata, '$.deliveryId') = ?`
      )
      .get(id) as { tool_metadata: string };
    return JSON.parse(message.tool_metadata) as Record<string, unknown>;
  }
  function promptEpochState() {
    return db.prepare('SELECT * FROM session_state').all();
  }
  function accepted(
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

  it('reaches the running turn while a queued prompt waits behind it, without a new prompt epoch', async () => {
    const submit = vi
      .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit')
      .mockResolvedValue(busy);
    const steer = vi
      .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'steer')
      .mockImplementation(async (input) => {
        expect(input.beforeSubmit?.(capabilities)).toBe(true);
        return steered;
      });
    await enqueue('queued-next', 'queue');
    await tick();
    expect(submit).toHaveBeenCalledTimes(1);
    const backoff = db.prepare('SELECT * FROM prompt_delivery_target_backoff').all();
    expect(backoff).toHaveLength(1);
    const epochBefore = promptEpochState();

    await enqueue('steer-now', 'steer');
    // The steer is due now although the busy backoff holds the queue lane.
    processPromptDeliveryAlarm(sql, {}, hooks);
    await drain();

    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0]![0].claim.message.id).toBe('steer-now');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(row('steer-now')).toMatchObject({
      delivery_state: 'acked',
      delivery_intent: 'steer',
      steer_outcome: 'steered',
    });
    expect(row('queued-next').delivery_state).toBe('retry_wait');
    expect(db.prepare('SELECT * FROM prompt_delivery_target_backoff').all()).toEqual(backoff);
    // Acceptance attaches to the running turn: no prompt epoch, no idle/turn reset.
    expect(promptEpochState()).toEqual(epochBefore);
    expect(transcriptMetadata('steer-now')).toMatchObject({
      deliveryIntent: 'steer',
      steerOutcome: 'steered',
    });
    expect(
      broadcasts.find(
        (b) => b.type === 'mailbox.delivery_updated' && b.payload.messageId === 'steer-now'
      )?.payload
    ).toMatchObject({
      promptMessageId: expect.any(String),
      deliveryIntent: 'steer',
      deliveryState: 'acked',
      steerOutcome: 'steered',
    });
  });

  it('hands a steer the runtime did not take to the queue as the next prompt, visibly', async () => {
    const steer = vi.spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'steer').mockResolvedValue({
      kind: 'steer_fallback',
      reason: 'no_running_turn',
      error: 'idle',
      runtimeIdentity: 'runtime',
      capabilities,
    });
    const submit = vi
      .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit')
      .mockImplementation(async (input) => accepted(input));
    await enqueue('late-steer', 'steer');
    await tick();
    expect(steer).toHaveBeenCalledTimes(1);
    expect(row('late-steer')).toMatchObject({
      delivery_state: 'queued',
      delivery_intent: 'queue',
      steer_outcome: 'queued_fallback',
      steer_reason: 'no_running_turn',
      delivery_attempts: 0,
    });
    expect(transcriptMetadata('late-steer')).toMatchObject({
      steerOutcome: 'queued_fallback',
      steerReason: 'no_running_turn',
    });

    await tick();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]![0].claim.message.id).toBe('late-steer');
    expect(steer).toHaveBeenCalledTimes(1);
    expect(row('late-steer').delivery_state).toBe('acked');
  });

  it('labels a steer that was never delivered, even after it fell back to the queue', async () => {
    vi.spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'steer').mockResolvedValue({
      kind: 'steer_fallback',
      reason: 'no_running_turn',
      error: 'idle',
      runtimeIdentity: 'runtime',
      capabilities,
    });
    const terminal: PromptDeliveryResult = {
      kind: 'failed',
      reason: 'terminal_target',
      error: 'session ended',
      runtimeIdentity: 'runtime',
      capabilities: null,
    };
    vi.spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit').mockResolvedValue(terminal);
    await enqueue('lost-steer', 'steer');
    await enqueue('lost-queued', 'queue');
    // The live row carries the steer intent, like the persisted one.
    expect(
      broadcasts
        .filter((b) => b.type === 'message.new')
        .map((b) => (b.payload.toolMetadata as Record<string, unknown>).deliveryIntent)
    ).toEqual(['steer', undefined]);

    await tick();
    expect(row('lost-steer').steer_outcome).toBe('queued_fallback');
    while (row('lost-steer').delivery_state !== 'failed') await tick();
    while (row('lost-queued').delivery_state !== 'failed') await tick();

    // The fallback reports intent `queue`, yet the row sent as a steer says it failed.
    expect(transcriptMetadata('lost-steer')).toMatchObject({
      deliveryIntent: 'steer',
      steerOutcome: 'failed',
      steerReason: 'terminal_target',
    });
    // A plain queued message gets no steer label.
    expect(transcriptMetadata('lost-queued')).not.toHaveProperty('steerOutcome');
  });

  it('admits steers for one session one at a time, in order', async () => {
    const first = deferred<PromptDeliveryResult>();
    const order: string[] = [];
    const steer = vi
      .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'steer')
      .mockImplementation(async (input) => {
        order.push(input.claim.message.id);
        return order.length === 1 ? first.promise : steered;
      });
    await enqueue('steer-1', 'steer');
    await enqueue('steer-2', 'steer');
    processPromptDeliveryAlarm(sql, {}, hooks);
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    processPromptDeliveryAlarm(sql, {}, hooks);
    expect(steer).toHaveBeenCalledTimes(1);

    first.resolve(steered);
    await drain();
    await tick();
    expect(order).toEqual(['steer-1', 'steer-2']);
    expect(row('steer-2').steer_outcome).toBe('steered');
  });

  it('never lets a pending steer hold back an urgent stop on the queue lane', async () => {
    const held = deferred<PromptDeliveryResult>();
    vi.spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'steer').mockReturnValue(held.promise);
    const submit = vi
      .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit')
      .mockImplementation(async (input) => accepted(input));
    await enqueue('steer-in-flight', 'steer');
    processPromptDeliveryAlarm(sql, {}, hooks);
    await enqueue('stop-now', 'queue', 'interrupt');
    processPromptDeliveryAlarm(sql, {}, hooks);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]![0].claim.message.id).toBe('stop-now');
    held.resolve(steered);
    await drain();
  });

  it('reconciles a lost steer response through the receipt and never sends it twice', async () => {
    // The real adapter records the possible-send boundary before the VM request.
    const steer = vi
      .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'steer')
      .mockImplementation(async (input) => {
        expect(input.beforeSubmit?.(capabilities)).toBe(true);
        return {
          kind: 'steer_pending',
          reason: 'receipt_lookup_failed',
          error: 'response lost',
          runtimeIdentity: 'runtime',
          capabilities,
        };
      });
    const reconcileSteer = vi
      .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'reconcileSteer')
      .mockResolvedValue(steered);
    await enqueue('lost-response', 'steer');
    await tick();
    expect(row('lost-response').delivery_state).toBe('delivering');
    vi.setSystemTime(Date.now() + config.receiptTimeoutMs + 1);
    await tick();
    expect(steer).toHaveBeenCalledTimes(1);
    expect(reconcileSteer).toHaveBeenCalledTimes(1);
    expect(reconcileSteer.mock.calls[0]![0].claim.mode).toBe('reconcile');
    expect(row('lost-response').steer_outcome).toBe('steered');
  });

  it('surfaces an unconfirmed steer and never replays it', async () => {
    vi.spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'steer').mockImplementation(
      async (input) => {
        expect(input.beforeSubmit?.(capabilities)).toBe(true);
        return {
          kind: 'steer_pending',
          reason: 'in_flight',
          error: 'still deciding',
          runtimeIdentity: 'runtime',
          capabilities,
        };
      }
    );
    const reconcileSteer = vi
      .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'reconcileSteer')
      .mockResolvedValue({
        kind: 'ambiguous',
        reason: 'runtime_changed',
        error: 'runtime restarted after claim',
        runtimeIdentity: 'runtime',
        capabilities,
        receipt: null,
      });
    const submit = vi.spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit');
    await enqueue('unconfirmed', 'steer');
    await tick();
    vi.setSystemTime(Date.now() + config.receiptTimeoutMs + 1);
    await tick();
    expect(row('unconfirmed').delivery_state).toBe('ambiguous');
    expect(transcriptMetadata('unconfirmed')).toMatchObject({ steerOutcome: 'unconfirmed' });
    vi.setSystemTime(Date.now() + config.receiptTimeoutMs * 10);
    processPromptDeliveryAlarm(sql, {}, hooks);
    await drain();
    expect(reconcileSteer).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it('refuses a steer with an urgent class and a reused delivery id with another intent', async () => {
    await expect(enqueue('urgent-steer', 'steer', 'interrupt')).rejects.toThrow(
      'steer intent requires a non-urgent message class'
    );
    await enqueue('same-id', 'queue');
    await expect(enqueue('same-id', 'steer')).rejects.toThrow(
      'deliveryId already belongs to a different prompt intent'
    );
  });
});
