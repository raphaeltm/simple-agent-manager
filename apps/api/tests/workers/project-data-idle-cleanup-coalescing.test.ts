/**
 * Chat ingest coalesces the idle-cleanup deadline extension (`resetIdleCleanup` with
 * `extendIntervalMs`): a batch whose activity the stored deadline already covers writes no
 * schedule row and re-arms no alarm. Driven through the real `persistMessageBatch` RPC in
 * workerd, with real time, so the deadline arithmetic is the production arithmetic.
 */
import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import type {
  RowUsage,
  RowUsageTotals,
} from '@simple-agent-manager/project-data/internal/do/row-usage';
import { DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES } from '@simple-agent-manager/shared';
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectDataStub } from './helpers/archive-fixtures';

afterEach(() => vi.restoreAllMocks());

// The same resolution `resetIdleCleanup` performs against the Worker env the DO receives.
const TIMEOUT_MS =
  (Number.parseInt(
    (env as { SESSION_IDLE_TIMEOUT_MINUTES?: string }).SESSION_IDLE_TIMEOUT_MINUTES ?? '',
    10
  ) || DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES) * 60_000;
const source = {
  workspaceId: 'coalesce-workspace',
  callbackGeneration: 'coalesce-generation',
  outboxIncarnation: 'coalesce-outbox',
};

function mockIngestConfig(idleExtendIntervalMs: number | undefined) {
  vi.spyOn(projectDataPorts().operations, 'messageMergeConfig').mockResolvedValue({
    enabled: true,
    maxRowBytes: 65536,
    recentIds: 200,
    ...(idleExtendIntervalMs === undefined ? {} : { idleExtendIntervalMs }),
  });
}

/** A prompting task chat whose idle cleanup is armed: the production shape of a working turn. */
async function armedSession() {
  const stub = projectDataStub(`idle-coalesce-${crypto.randomUUID()}`);
  await stub.ensureProjectId('coalesce-project');
  const session = await stub.createSession('coalesce-workspace', 'Existing topic');
  const now = Date.now();
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(
      `INSERT INTO acp_sessions (id,chat_session_id,node_id,status,created_at,updated_at)
       VALUES ('coalesce-acp',?,'coalesce-node','running',?,?)`,
      session,
      now,
      now
    );
    sql.exec(
      `INSERT INTO session_state (session_id,activity,activity_at,work_at)
       VALUES ('coalesce-acp','prompting',?,?)`,
      now,
      now
    );
    sql.exec(
      `INSERT INTO idle_cleanup_schedule (session_id, workspace_id, task_id, cleanup_at, created_at, retry_count)
       VALUES (?, 'coalesce-workspace', 'coalesce-task', ?, ?, 0)`,
      session,
      now + TIMEOUT_MS,
      now
    );
  });
  let sequence = 0;
  const batch = async (id: string) => {
    const before = Date.now();
    const usageBefore = await meter(stub);
    await stub.persistMessageBatch(
      session,
      [
        {
          messageId: id,
          role: 'assistant',
          content: `synthetic ${id}`,
          toolMetadata: null,
          timestamp: new Date().toISOString(),
          sequence: ++sequence,
        },
      ],
      source
    );
    const usageAfter = await meter(stub);
    return {
      before,
      after: Date.now(),
      rowsWritten: usageAfter.rowsWritten - usageBefore.rowsWritten,
      alarmWrites: usageAfter.alarmWrites - usageBefore.alarmWrites,
    };
  };
  const schedule = () =>
    runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec(
          'SELECT cleanup_at, retry_count, last_error FROM idle_cleanup_schedule WHERE session_id = ?',
          session
        )
        .toArray()[0];
      return {
        cleanupAt: Number(row?.cleanup_at),
        retryCount: Number(row?.retry_count),
        lastError: (row?.last_error as string | null) ?? null,
      };
    });
  const cleanup = () =>
    runInDurableObject(stub, async (_instance, state) => state.storage.deleteAlarm());
  return { stub, session, batch, schedule, cleanup };
}

function meter(stub: ReturnType<typeof projectDataStub>): Promise<RowUsageTotals> {
  return runInDurableObject(stub, (instance) => {
    const usage = (instance as unknown as { rowUsage: RowUsage }).rowUsage;
    usage.fold();
    const totals = (usage as unknown as { totals: Map<string, RowUsageTotals> }).totals.get(
      'persistMessageBatch'
    );
    return { calls: 0, rowsRead: 0, rowsWritten: 0, alarmWrites: 0, ...totals };
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('chat ingest idle-cleanup extension coalescing', () => {
  it('skips the schedule write and the alarm re-arm while the deadline covers the batch', async () => {
    // Control: the same sequence with coalescing off, for the per-batch row cost it replaces.
    mockIngestConfig(0);
    const control = await armedSession();
    await control.batch('first');
    const controlSteady = await control.batch('steady-1');
    expect(controlSteady.alarmWrites).toBe(1);
    await control.cleanup();

    mockIngestConfig(60_000);
    const { batch, schedule, cleanup } = await armedSession();
    const first = await batch('first');
    const extended = await schedule();
    // The extension that ran carries one interval of slack past the batch.
    expect(extended.cleanupAt).toBeGreaterThanOrEqual(first.before + TIMEOUT_MS + 60_000);
    expect(extended.cleanupAt).toBeLessThanOrEqual(first.after + TIMEOUT_MS + 60_000);
    expect(first.alarmWrites).toBe(1);

    const steady = [await batch('steady-1'), await batch('steady-2')];
    for (const result of steady) {
      expect(result.alarmWrites).toBe(0);
      // Liveness: the batch still wrote its message and session bookkeeping.
      expect(result.rowsWritten).toBeGreaterThan(0);
      // 4 fewer rows than the uncoalesced steady batch: idle schedule (3) and native alarm (1).
      expect(result.rowsWritten).toBe(controlSteady.rowsWritten - 4);
    }
    const after = await schedule();
    expect(after.cleanupAt).toBe(extended.cleanupAt);
    // Never early: the deadline still covers the last batch by the full timeout.
    expect(after.cleanupAt).toBeGreaterThanOrEqual(steady[1]!.after + TIMEOUT_MS);
    await cleanup();
  });

  it('extends again once activity passes the covered window', async () => {
    const interval = 300;
    mockIngestConfig(interval);
    const { batch, schedule, cleanup } = await armedSession();
    await batch('first');
    const covered = await schedule();
    const inside = await batch('inside');
    expect(inside.alarmWrites).toBe(0);
    expect((await schedule()).cleanupAt).toBe(covered.cleanupAt);

    await sleep(interval + 100);
    const outside = await batch('outside');
    expect(outside.alarmWrites).toBe(1);
    const moved = await schedule();
    expect(moved.cleanupAt).toBeGreaterThan(covered.cleanupAt);
    expect(moved.cleanupAt).toBeGreaterThanOrEqual(outside.before + TIMEOUT_MS + interval);
    expect(moved.cleanupAt).toBeLessThanOrEqual(outside.after + TIMEOUT_MS + interval);
    await cleanup();
  });

  it('always rewrites a retrying schedule, so activity clears its retry state', async () => {
    mockIngestConfig(60_000);
    const { stub, session, batch, schedule, cleanup } = await armedSession();
    await batch('first');
    const covered = await schedule();
    // Precondition: the idle sweep recorded a failed attempt on a schedule that still covers.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE idle_cleanup_schedule SET retry_count = 2, last_error = 'stop failed'
         WHERE session_id = ?`,
        session
      );
    });
    const result = await batch('after-retry');
    expect(result.alarmWrites).toBe(1);
    const cleared = await schedule();
    expect(cleared).toMatchObject({ retryCount: 0, lastError: null });
    expect(cleared.cleanupAt).toBeGreaterThanOrEqual(covered.cleanupAt);
    await cleanup();
  });

  it.each([
    ['0', 0],
    ['absent', undefined],
  ])('extends on every batch when the interval is %s', async (_label, interval) => {
    mockIngestConfig(interval);
    const { batch, schedule, cleanup } = await armedSession();
    for (const id of ['one', 'two', 'three']) {
      const result = await batch(id);
      expect(result.alarmWrites).toBe(1);
      const { cleanupAt } = await schedule();
      // Exact pre-change arithmetic: now + timeout, no slack.
      expect(cleanupAt).toBeGreaterThanOrEqual(result.before + TIMEOUT_MS);
      expect(cleanupAt).toBeLessThanOrEqual(result.after + TIMEOUT_MS);
    }
    await cleanup();
  });

  it('resolves the default interval through the real admin-settings port', async () => {
    const config = await projectDataPorts().operations.messageMergeConfig?.(env as never);
    expect(config?.idleExtendIntervalMs).toBe(60_000);
  });

  it('keeps the single-message path exact', async () => {
    mockIngestConfig(60_000);
    const { stub, session, schedule, cleanup } = await armedSession();
    const before = Date.now();
    await stub.persistMessage(session, 'user', 'A human message', null);
    const after = Date.now();
    const { cleanupAt } = await schedule();
    expect(cleanupAt).toBeGreaterThanOrEqual(before + TIMEOUT_MS);
    expect(cleanupAt).toBeLessThanOrEqual(after + TIMEOUT_MS);
    await cleanup();
  });
});
