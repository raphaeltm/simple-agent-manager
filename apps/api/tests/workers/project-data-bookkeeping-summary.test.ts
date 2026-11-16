import { enqueueBookkeepingSummary } from '@simple-agent-manager/project-data/internal/do/message-bookkeeping-summary-queue';
import type { MessageMergeConfig } from '@simple-agent-manager/project-data/internal/do/message-stream-ingest';
import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectDataStub } from './helpers/archive-fixtures';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

afterEach(() => vi.restoreAllMocks());
const source = {
  workspaceId: 'summary-workspace',
  callbackGeneration: 'summary-generation',
  outboxIncarnation: 'summary-outbox',
};
function batch(id: string) {
  return [
    {
      messageId: id,
      role: 'assistant',
      content: 'synthetic summary chunk',
      toolMetadata: null,
      timestamp: new Date().toISOString(),
    },
  ];
}
async function fixture(size = 1, config: Partial<MessageMergeConfig> = {}) {
  const projectId = 'bookkeeping-summary-' + crypto.randomUUID(),
    owner = 'summary-owner';
  await seedUser(owner);
  await seedInstallation('summary-installation', owner);
  await seedProject(projectId, owner, 'summary-installation');
  vi.spyOn(projectDataPorts().operations, 'messageMergeConfig').mockResolvedValue({
    enabled: true,
    maxRowBytes: 65536,
    recentIds: 200,
    bookkeepingIntervalMs: 15000,
    bookkeepingFlushBatchSize: 2,
    ...config,
  });
  const stub = projectDataStub(projectId);
  await stub.ensureProjectId(projectId);
  const sessions = [];
  for (let n = 0; n < size; n++) {
    const session = await stub.createSession(source.workspaceId, 'Synthetic summary');
    sessions.push(session);
    await stub.persistMessageBatch(session, batch('first-' + n), source);
    await stub.markAgentCompleted(session);
  }
  return { stub, projectId, sessions };
}
async function interceptPublication(
  instance: unknown,
  beforeRun: (values: unknown[]) => Promise<void>
) {
  const holder = instance as { env: { DATABASE: D1Database } };
  const prior = holder.env;
  const wrap = (statement: D1PreparedStatement, bound: unknown[] = []): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), values);
        if (key === 'run')
          return async () => {
            await beforeRun(bound);
            return target.run();
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  holder.env = {
    ...prior,
    DATABASE: new Proxy(prior.DATABASE, {
      get(target, key) {
        if (key === 'prepare')
          return (query: string) => {
            const statement = target.prepare(query);
            return query.includes('INSERT INTO session_summaries') ? wrap(statement) : statement;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
  return () => {
    holder.env = prior;
  };
}
async function markerCount(stub: ReturnType<typeof projectDataStub>) {
  return runInDurableObject(stub, (_instance, state) =>
    Number(
      state.storage.sql
        .exec('SELECT COUNT(*) AS n FROM message_bookkeeping_summary_queue')
        .toArray()[0]?.n
    )
  );
}

describe('durable bookkeeping summary publication through real ingest', () => {
  it('reaches valid work behind a failing page, quarantines bounded failures and never renews them on ingest', async () => {
    const { stub, sessions } = await fixture(5, {
      bookkeepingSummaryRetryMs: 1000,
      bookkeepingSummaryMaxAttempts: 2,
      bookkeepingSummaryMaxResidenceMs: 3600000,
    });
    const base = Date.now();
    const ordered = [...sessions].sort();
    const failed = new Set(ordered.slice(0, 3));
    const attempts = new Map<string, number>();
    const alerts = vi
      .spyOn(projectDataPorts().observability, 'persistPlatformError')
      .mockResolvedValue();
    await runInDurableObject(stub, async (instance, state) => {
      for (const session of sessions) {
        state.storage.sql.exec(
          'UPDATE chat_sessions SET message_bookkeeping_due_at=NULL WHERE id=?',
          session
        );
        enqueueBookkeepingSummary(state.storage.sql, session, base);
      }
      await interceptPublication(instance, async (values) => {
        const id = String(values[0]);
        attempts.set(id, (attempts.get(id) ?? 0) + 1);
        if (failed.has(id)) throw new Error('synthetic poison summary');
      });
    });
    const clock = vi.spyOn(Date, 'now');
    for (let n = 0; n < 7; n++) {
      clock.mockReturnValue(base + n * 60000);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
    }
    for (const id of ordered.slice(3)) {
      expect(
        await env.DATABASE.prepare('SELECT message_count FROM session_summaries WHERE id=?')
          .bind(id)
          .first()
      ).toMatchObject({ message_count: 1 });
      expect(attempts.get(id)).toBeGreaterThan(0);
    }
    for (const id of failed) expect(attempts.get(id)).toBe(2);
    expect(
      alerts.mock.calls.filter(
        ([, record]) => record.message === 'Chat summary publication exhausted its retry budget'
      )
    ).toHaveLength(3);
    const quarantined = await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec(
          'SELECT session_id,first_queued_at,attempts,terminal_at FROM message_bookkeeping_summary_queue ORDER BY session_id'
        )
        .toArray();
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => Number(row.terminal_at) > 0 && row.attempts === 2)).toBe(true);
      expect(
        state.storage.sql
          .exec(
            'SELECT MIN(next_attempt_at) AS due FROM message_bookkeeping_summary_queue WHERE terminal_at IS NULL'
          )
          .one().due
      ).toBeNull();
      return rows;
    });
    await stub.persistMessageBatch(ordered[0]!, batch('after-quarantine'), source);
    await stub.markAgentCompleted(ordered[0]!);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            'SELECT session_id,first_queued_at,attempts,terminal_at FROM message_bookkeeping_summary_queue ORDER BY session_id'
          )
          .toArray()
      ).toEqual(quarantined);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    for (const id of failed) expect(attempts.get(id)).toBe(2);
  });

  it('reaches old queued sessions beyond a summary page among 10000 clean sessions', async () => {
    const { stub, projectId, sessions } = await fixture(5);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql
        .exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
    INSERT INTO chat_sessions(id,topic,status,message_count,created_at,updated_at,started_at)
    SELECT 'clean-'||x,'synthetic','stopped',0,1,1,1 FROM n`);
    });
    const queuedAt = Date.now();
    await runInDurableObject(stub, (_instance, state) => {
      // Requeue already-published receipts together to exercise a controlled multi-page
      // retry load; the fixture's real ingest can legitimately trigger immediate alarms.
      for (const session of sessions) {
        state.storage.sql.exec(
          'UPDATE chat_sessions SET message_bookkeeping_due_at=NULL WHERE id=?',
          session
        );
        enqueueBookkeepingSummary(state.storage.sql, session, queuedAt);
      }
      state.storage.sql.exec(
        'UPDATE message_bookkeeping_summary_queue SET next_attempt_at=? WHERE terminal_at IS NULL',
        queuedAt + 100000
      );
      expect(
        Number(
          state.storage.sql
            .exec('SELECT COUNT(*) AS n FROM message_bookkeeping_summary_queue')
            .one().n
        )
      ).toBe(5);
    });
    vi.spyOn(Date, 'now').mockReturnValue(queuedAt + 100001);
    for (let n = 0; n < 3; n++)
      await stub.runSummarySyncWithEnvForTest({ SESSION_INDEX_MAX_ROWS: '1' });
    expect(await markerCount(stub)).toBe(0);
    for (const session of sessions) {
      const row = await env.DATABASE.prepare(
        'SELECT message_count FROM session_summaries WHERE project_id=? AND id=?'
      )
        .bind(projectId, session)
        .first<{ message_count: number }>();
      expect(row?.message_count).toBe(1);
    }
  });

  it('retains the queue and cursor on publication failure and retries after actual eviction/alarm', async () => {
    // Native alarms use workerd's wall clock; future fixture dates leave delivery to
    // the explicit alarm calls while exercising the real scheduling implementation.
    const base = Date.now() + 60000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    const {
      stub,
      projectId,
      sessions: [session],
    } = await fixture();
    await stub.runSummarySyncWithEnvForTest({ SESSION_INDEX_MAX_ROWS: '1' });
    expect(await markerCount(stub)).toBe(0);
    const readCoverage = () =>
      env.DATABASE.prepare('SELECT * FROM session_index_coverage WHERE project_id=?')
        .bind(projectId)
        .first();
    const readCursor = () =>
      env.DATABASE.prepare(
        'SELECT * FROM project_data_session_index_cursors WHERE project_id=?'
      )
        .bind(projectId)
        .first();
    const coverageBefore = await readCoverage();
    const cursorBefore = await readCursor();
    expect(coverageBefore).toMatchObject({ complete: 0, backfill_cursor_id: session });
    expect(cursorBefore).toMatchObject({ cursor_id: session });

    let publicationAttempts = 0;
    clock.mockReturnValue(base + 1000);
    await runInDurableObject(stub, async (instance) => {
      // The fresh constructor, rather than a test-side repair, restores real D1.
      await interceptPublication(instance, async () => {
        publicationAttempts++;
        throw new Error('synthetic D1 publication failure');
      });
    });
    await stub.persistMessageBatch(session!, batch('before-failed-alarm'), source);
    await stub.markAgentCompleted(session!);
    expect(await markerCount(stub)).toBe(1);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(publicationAttempts).toBeGreaterThan(0);
    const failed = await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            'SELECT message_bookkeeping_due_at,pending_message_count,message_count FROM chat_sessions WHERE id=?',
            session
          )
          .one()
      ).toMatchObject({
        message_bookkeeping_due_at: null,
        pending_message_count: 0,
        message_count: 2,
      });
      const receipt = state.storage.sql
        .exec(
          'SELECT attempts,next_attempt_at,first_queued_at,terminal_at FROM message_bookkeeping_summary_queue WHERE session_id=?',
          session
        )
        .one();
      expect(receipt.attempts).toBe(1);
      expect(receipt.terminal_at).toBeNull();
      expect(Number(receipt.next_attempt_at)).toBeGreaterThan(base + 1000);
      return { receipt, alarmAt: await state.storage.getAlarm() };
    });
    expect(failed.alarmAt).not.toBeNull();
    expect(await readCoverage()).toMatchObject({
      complete: 0,
      backfill_cursor_id: coverageBefore!.backfill_cursor_id,
      backfill_cursor_updated_at: coverageBefore!.backfill_cursor_updated_at,
    });
    expect(await readCursor()).toMatchObject({
      complete: 0,
      cursor_id: cursorBefore!.cursor_id,
      cursor_updated_at: cursorBefore!.cursor_updated_at,
    });
    expect(
      await env.DATABASE.prepare('SELECT message_count FROM session_summaries WHERE id=?')
        .bind(session!)
        .first()
    ).toMatchObject({ message_count: 1 });

    await evictDurableObject(stub);
    const resumed = projectDataStub(projectId);
    await runInDurableObject(resumed, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            'SELECT attempts,next_attempt_at,first_queued_at,terminal_at FROM message_bookkeeping_summary_queue WHERE session_id=?',
            session
          )
          .one()
      ).toEqual(failed.receipt);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    // Failed sections have a minute retry floor, beyond the queue retry delay.
    clock.mockReturnValue(base + 61001);
    expect(await runDurableObjectAlarm(resumed)).toBe(true);
    expect(await markerCount(resumed)).toBe(0);
    expect(
      await env.DATABASE.prepare(
        'SELECT message_count FROM session_summaries WHERE project_id=? AND id=?'
      )
        .bind(projectId, session!)
        .first()
    ).toMatchObject({ message_count: 2 });
  });

  it('publishes an older folded episode when real ingest is already pending before sampling', async () => {
    const {
      stub,
      sessions: [session],
    } = await fixture(1, {
      bookkeepingIntervalMs: 120000,
      bookkeepingSummaryRetryMs: 1000,
      bookkeepingSummaryMaxAttempts: 2,
    });
    const base = Date.now();
    await runInDurableObject(stub, (_instance, state) => {
      enqueueBookkeepingSummary(state.storage.sql, session!, base);
      state.storage.sql.exec(
        'UPDATE message_bookkeeping_summary_queue SET next_attempt_at=? WHERE session_id=?',
        base + 5000,
        session
      );
    });
    await stub.persistMessageBatch(session!, batch('pending-before-sample'), source);
    vi.spyOn(Date, 'now').mockReturnValue(base + 5001);
    await stub.runSummarySyncForTest();
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql.exec('SELECT session_id FROM message_bookkeeping_summary_queue').toArray()
      ).toEqual([]);
      expect(
        state.storage.sql
          .exec('SELECT pending_message_count,message_count FROM chat_sessions WHERE id=?', session)
          .one()
      ).toMatchObject({ pending_message_count: 1, message_count: 1 });
    });
    expect((await stub.getSession(session!))?.messageCount).toBe(2);
  });

  it('does not acknowledge a receipt ingested while its older snapshot is publishing', async () => {
    const {
      stub,
      projectId,
      sessions: [session],
    } = await fixture(1, {
      bookkeepingIntervalMs: 120000,
      bookkeepingSummaryRetryMs: 1000,
      bookkeepingSummaryMaxAttempts: 2,
    });
    await runInDurableObject(stub, async (instance) => {
      let injected = false;
      const restore = await interceptPublication(instance, async () => {
        if (!injected) {
          injected = true;
          await instance.persistMessageBatch(session!, batch('during-publication'), source);
        }
      });
      try {
        await instance.runSummarySyncForTest();
        expect(injected).toBe(true);
      } finally {
        restore();
      }
    });
    await runInDurableObject(stub, (_instance, state) => {
      // Successful old publication ends its episode while the new receipt remains protected
      // by its own finite flush deadline, even when that interval exceeds the retry budget.
      expect(
        state.storage.sql.exec('SELECT session_id FROM message_bookkeeping_summary_queue').toArray()
      ).toEqual([]);
      expect(
        state.storage.sql
          .exec('SELECT pending_message_count FROM chat_sessions WHERE id=?', session)
          .one().pending_message_count
      ).toBe(1);
    });
    const pendingAt = Date.now();
    const clock = vi.spyOn(Date, 'now');
    for (const delay of [10000, 20000]) {
      clock.mockReturnValue(pendingAt + delay);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
    }
    expect((await stub.getSession(session!))?.messageCount).toBe(2);
    expect(
      (
        await env.DATABASE.prepare(
          'SELECT message_count FROM session_summaries WHERE project_id=? AND id=?'
        )
          .bind(projectId, session!)
          .first<{ message_count: number }>()
      )?.message_count
    ).toBe(1);
    await stub.markAgentCompleted(session!);
    expect(await markerCount(stub)).toBe(1);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5001);
    await stub.runSummarySyncForTest();
    expect(await markerCount(stub)).toBe(0);
    expect(
      (
        await env.DATABASE.prepare(
          'SELECT message_count FROM session_summaries WHERE project_id=? AND id=?'
        )
          .bind(projectId, session!)
          .first<{ message_count: number }>()
      )?.message_count
    ).toBe(2);
  });
});
