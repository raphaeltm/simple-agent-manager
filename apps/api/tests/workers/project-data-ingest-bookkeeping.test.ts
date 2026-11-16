import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectDataStub } from './helpers/archive-fixtures';
import { profileObject, type WriteSample } from './helpers/archive-write-profile';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

afterEach(() => vi.restoreAllMocks());

const source = {
  workspaceId: 'bookkeeping-workspace',
  callbackGeneration: 'bookkeeping-generation',
  outboxIncarnation: 'bookkeeping-outbox',
};

async function fixture(enabled: boolean) {
  vi.spyOn(projectDataPorts().operations, 'messageMergeConfig').mockResolvedValue({
    enabled,
    maxRowBytes: 65536,
    recentIds: 200,
  });
  const stub = projectDataStub(`bookkeeping-${crypto.randomUUID()}`);
  const session = await stub.createSession(source.workspaceId, 'Existing topic');
  const base = Date.now();
  await runInDurableObject(stub, (instance, state) => {
    const holder = instance as unknown as { env: Record<string, unknown> };
    holder.env = { ...holder.env, SESSION_IDLE_TIMEOUT_MINUTES: '1' };
    state.storage.sql.exec(
      `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
       INSERT INTO chat_messages (id,session_id,role,content,created_at,sequence)
       SELECT 'history-'||x,?,'assistant','synthetic',?-10001+x,x FROM n`,
      session,
      base
    );
    state.storage.sql.exec(
      'UPDATE chat_sessions SET message_count=10000,last_message_sequence=NULL WHERE id=?',
      session
    );
    state.storage.sql.exec(
      `INSERT INTO acp_sessions (id,chat_session_id,node_id,status,created_at,updated_at)
       VALUES ('bookkeeping-acp',?,'bookkeeping-node','running',?,?)`,
      session,
      base,
      base
    );
  });
  await stub.reportActivity('bookkeeping-acp', 'prompting', {
    observedAt: base,
    promptStartedAt: base,
  });
  await stub.scheduleIdleCleanup(session, source.workspaceId, null);
  const batch = (position: number) => [
    {
      messageId: `chunk-${position}`,
      role: 'assistant',
      content: 'synthetic chunk',
      toolMetadata: null,
      timestamp: new Date(base + position).toISOString(),
      sequence: position,
    },
  ];
  await stub.persistMessageBatch(session, batch(10001), source);
  return { stub, session, batch, base };
}

describe('ingest bookkeeping in real workerd', () => {
  it.each(
    [false, true].flatMap((enabled) =>
      ['batch', 'browser'].map((writer) => [enabled, writer] as const)
    )
  )(
    'preserves the task when real ingest lands during the cleanup liveness await (merging=%s, writer=%s)',
    async (enabled, writer) => {
      // Keep every fixture-created storage alarm ahead of workerd's native clock.
      // Otherwise an immediately eligible background alarm can consume delivery
      // while D1 relationships are still being seeded, before the race is armed.
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3600000);
      const { stub, session, batch, base } = await fixture(enabled);
      const projectId = `receipt-project-${crypto.randomUUID()}`;
      const userId = `receipt-user-${crypto.randomUUID()}`;
      const nodeId = `receipt-node-${crypto.randomUUID()}`;
      const taskId = `receipt-task-${crypto.randomUUID()}`;
      await seedUser(userId);
      await seedInstallation(projectId, userId);
      await seedProject(projectId, userId, projectId);
      await seedNode(nodeId, userId);
      await seedWorkspace(source.workspaceId, nodeId, userId, {
        projectId,
        chatSessionId: session,
        status: 'running',
      });
      await seedTask(taskId, projectId, userId, {
        workspaceId: source.workspaceId,
        chatSessionId: session,
        status: 'in_progress',
      });
      await stub.ensureProjectId(projectId);
      await stub.scheduleIdleCleanup(session, source.workspaceId, taskId);
      vi.spyOn(projectDataPorts().sessions, 'stoppingTaskSleepOwnsCleanup').mockResolvedValue(
        false
      );
      let ingestDuringProbe!: () => Promise<unknown>;
      await runInDurableObject(stub, (instance) => {
        ingestDuringProbe = () =>
          writer === 'batch'
            ? instance.persistMessageBatch(session, batch(10002), source)
            : instance.persistMessage(
                session,
                'user',
                'synthetic browser turn',
                null,
                'browser-probe-race'
              );
      });
      const liveness = vi
        .spyOn(projectDataPorts().taskLiveness, 'getLocalTaskRuntimeVerdict')
        .mockImplementation(async () => {
          await Promise.resolve();
          // Use the actual production ingest method in this DO's I/O context during the probe await.
          await ingestDuringProbe();
          return {
            live: false,
            conclusive: true,
            reason: 'synthetic_dead',
            supersededTermination: false,
            evidenceLogFields: {},
            delivery: { kind: 'terminal', reason: 'synthetic_dead', nodeId },
          };
        });
      clock.mockReturnValue(base + 61000);
      const alarm = runDurableObjectAlarm(stub);
      expect(await alarm).toBe(true);
      expect(liveness).toHaveBeenCalled();
      expect((await stub.getSession(session))?.status).toBe('active');
      expect(
        await env.DATABASE.prepare('SELECT status FROM tasks WHERE id=?').bind(taskId).first()
      ).toMatchObject({ status: 'in_progress' });
      expect(
        await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id=?')
          .bind(source.workspaceId)
          .first()
      ).toMatchObject({ status: 'running' });
    }
  );

  it.each([false, true])(
    'recovers pending activity after eviction before a stale idle cleanup (merging=%s)',
    async (enabled) => {
      const { stub, session, batch, base } = await fixture(enabled);
      await stub.persistMessageBatch(session, batch(10002), source);
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          'UPDATE idle_cleanup_schedule SET cleanup_at=? WHERE session_id=?',
          base + 1000,
          session
        );
      });
      await evictDurableObject(stub);
      vi.spyOn(Date, 'now').mockReturnValue(base + 2000);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect((await stub.getSession(session))?.status).toBe('active');
      await runInDurableObject(stub, (_instance, state) => {
        const row = state.storage.sql
          .exec('SELECT cleanup_at FROM idle_cleanup_schedule WHERE session_id=?', session)
          .toArray()[0];
        expect(Number(row?.cleanup_at)).toBeGreaterThan(base + 2000);
        expect(
          state.storage.sql
            .exec('SELECT pending_message_count FROM chat_sessions WHERE id=?', session)
            .toArray()[0]?.pending_message_count
        ).toBe(0);
      });
    }
  );

  it.each([false, true])(
    'keeps cleanup and work clocks extended across an entire idle window of real batches (merging=%s)',
    async (enabled) => {
      const { stub, session, batch, base } = await fixture(enabled);
      const clock = vi.spyOn(Date, 'now');
      for (let n = 1; n <= 5; n++) {
        const now = base + n * 20000;
        clock.mockReturnValue(now);
        await stub.persistMessageBatch(session, batch(10001 + n), source);
        expect((await stub.getSessionState('bookkeeping-acp'))?.workAt).toBeGreaterThanOrEqual(now);
        expect(await runDurableObjectAlarm(stub)).toBe(true);
        expect((await stub.getSession(session))?.status).toBe('active');
        await runInDurableObject(stub, (_instance, state) => {
          expect(
            Number(
              state.storage.sql
                .exec('SELECT cleanup_at FROM idle_cleanup_schedule WHERE session_id=?', session)
                .toArray()[0]?.cleanup_at
            )
          ).toBeGreaterThan(now);
        });
      }
    }
  );

  it.each([false, true])(
    'exposes pending counts immediately and flushes them at the real turn-end boundary (merging=%s)',
    async (enabled) => {
      const { stub, session, batch, base } = await fixture(enabled);
      await stub.persistMessageBatch(session, batch(10002), source);
      expect((await stub.getSessionState('bookkeeping-acp'))?.activityAt).toBeGreaterThanOrEqual(
        base + 10002
      );
      expect((await stub.getSession(session))?.messageCount).toBe(10002);
      expect(
        (await stub.listSessions()).sessions.find((row) => row.id === session)?.messageCount
      ).toBe(10002);
      expect(
        await stub.recordSessionTurnEnd('bookkeeping-acp', {
          reason: 'completed',
          observedAt: Date.now(),
        })
      ).toBe(true);
      await runInDurableObject(stub, (_instance, state) => {
        const row = state.storage.sql
          .exec(
            'SELECT message_count,pending_message_count,last_message_sequence_count FROM chat_sessions WHERE id=?',
            session
          )
          .toArray()[0];
        expect(row).toMatchObject({
          message_count: 10002,
          pending_message_count: 0,
          last_message_sequence_count: 10002,
        });
      });
    }
  );

  it.each([false, true])(
    'folds pending chunks when the browser writes the next message (merging=%s)',
    async (enabled) => {
      const { stub, session, batch } = await fixture(enabled);
      await stub.persistMessageBatch(session, batch(10002), source);
      await stub.persistMessage(session, 'user', 'next synthetic turn', null, 'browser-next');
      await runInDurableObject(stub, (_instance, state) => {
        const row = state.storage.sql
          .exec(
            'SELECT message_count,pending_message_count,last_message_sequence_count FROM chat_sessions WHERE id=?',
            session
          )
          .toArray()[0];
        expect(row).toMatchObject({
          message_count: 10003,
          pending_message_count: 0,
          last_message_sequence_count: 10003,
        });
      });
    }
  );

  it.each([false, true])(
    'does not certify a stale watermark when folding older-build writes (merging=%s)',
    async (enabled) => {
      const { stub, session, batch } = await fixture(enabled);
      await stub.persistMessageBatch(session, batch(10002), source);
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO chat_messages(id,session_id,role,content,created_at,sequence)
        VALUES('older-build-write',?,'assistant','synthetic legacy',?,10003)`,
          session,
          Date.now()
        );
        // Before migration079, writers incremented count without knowing its version tag.
        state.storage.sql.exec(
          'UPDATE chat_sessions SET message_count=message_count+1 WHERE id=?',
          session
        );
      });
      await stub.persistMessage(
        session,
        'user',
        'synthetic browser after old writer',
        null,
        'after-older-build'
      );
      await runInDurableObject(stub, (_instance, state) => {
        const row = state.storage.sql
          .exec('SELECT sequence FROM chat_messages WHERE id=?', 'after-older-build')
          .toArray()[0];
        expect(row?.sequence).toBe(10004);
      });
    }
  );

  it('measures interval amortization including real due alarms in both modes', async () => {
    const reports = [];
    for (const intervalMs of [15000, 30000, 60000, 120000])
      for (const enabled of [false, true]) {
        vi.restoreAllMocks();
        const { stub, session, batch } = await fixture(enabled);
        const projectId = 'cost-project-' + crypto.randomUUID();
        const userId = 'cost-user-' + crypto.randomUUID();
        await seedUser(userId);
        await seedInstallation(projectId, userId);
        await seedProject(projectId, userId, projectId);
        await stub.ensureProjectId(projectId);
        vi.spyOn(projectDataPorts().operations, 'messageMergeConfig').mockResolvedValue({
          enabled,
          maxRowBytes: 65536,
          recentIds: 200,
          bookkeepingIntervalMs: intervalMs,
        });
        await runInDurableObject(stub, (instance) => {
          const holder = instance as unknown as { env: Record<string, unknown> };
          holder.env = { ...holder.env, SESSION_IDLE_TIMEOUT_MINUTES: '30' };
        });
        await stub.markAgentCompleted(session);
        await stub.runSummarySyncForTest();
        await runDurableObjectAlarm(stub);
        const samples: WriteSample[] = [];
        const collect = await profileObject(stub, 'root', samples, true);
        const base = Date.now();
        const clock = vi.spyOn(Date, 'now');
        const batches = 120;
        const batchWrites = [];
        for (let n = 1; n <= batches; n++) {
          clock.mockReturnValue(base + n * 2000);
          collect();
          const start = samples.length;
          await stub.persistMessageBatch(session, batch(10001 + n), source);
          collect();
          batchWrites.push(
            samples
              .slice(start)
              .filter(
                (row) =>
                  row.owner === 'root' &&
                  row.phase === 'persistMessageBatch' &&
                  !row.statement.startsWith('storage.')
              )
              .reduce((sum, row) => sum + row.rowsWritten, 0)
          );
          const alarmAt = await runInDurableObject(stub, (_instance, state) =>
            state.storage.getAlarm()
          );
          if (alarmAt !== null && alarmAt <= Date.now()) await runDurableObjectAlarm(stub);
        }
        // Include the exact lifecycle flush and its required summary publication at window end.
        await stub.recordSessionTurnEnd('bookkeeping-acp', {
          reason: 'completed',
          observedAt: Date.now(),
        });
        await stub.runSummarySyncForTest();
        collect();
        const sql = samples.filter(
          (row) =>
            row.owner === 'root' &&
            !row.statement.startsWith('storage.') &&
            !row.statement.startsWith('KV.')
        );
        const writes = sql.reduce((sum, row) => sum + row.rowsWritten, 0);
        const reads = sql.reduce((sum, row) => sum + (row.rowsRead ?? 0), 0);
        const steadyWrites = Math.min(...batchWrites);
        const report = {
          intervalMs,
          enabled,
          batches,
          steadyWrites,
          amortizedSqlWrites: writes / batches,
          amortizedSqlReads: reads / batches,
          nativeWrites: samples
            .filter((row) => row.owner === 'root' && row.statement.startsWith('storage.'))
            .reduce((sum, row) => sum + row.rowsWritten, 0),
        };
        const grouped = new Map<string, { calls: number; writes: number }>();
        for (const row of samples.filter((row) => row.owner === 'root' && row.rowsWritten > 0)) {
          const boundary =
            row.phase === 'persistMessageBatch'
              ? 'ingest'
              : row.phase === 'recordSessionTurnEnd'
                ? 'turn-end'
                : row.phase;
          const table = row.statement.startsWith('storage.')
            ? row.statement
            : (row.statement.match(/(?:UPDATE|INTO|FROM) ([a-z_]+)/)?.[1] ?? 'other');
          const key = boundary + ':' + table;
          const count = grouped.get(key) ?? { calls: 0, writes: 0 };
          count.calls++;
          count.writes += row.rowsWritten;
          grouped.set(key, count);
        }
        reports.push({
          ...report,
          amortizedTotalWrites: (writes + report.nativeWrites) / batches,
          attribution: Object.fromEntries([...grouped].sort(([a], [b]) => a.localeCompare(b))),
        });
        expect(steadyWrites).toBeGreaterThan(0);
        expect(steadyWrites).toBeLessThanOrEqual(enabled ? 2 : 4);
        expect(report.amortizedSqlWrites).toBeLessThan(enabled ? 6 : 8);
        clock.mockRestore();
      }
    // Alarm section consumption may fall on either adjacent tick.
    // Gate cost bounds above; retain exact samples as diagnostic evidence.
    console.info('LOCAL_BOOKKEEPING_COST_SAMPLE', JSON.stringify(reports));
  }, 120000);

  it('keeps a sparse deadline index out of the steady update write cost', async () => {
    const { stub, session } = await fixture(true);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec('ALTER TABLE chat_sessions ADD COLUMN experiment_due_at INTEGER');
      sql.exec(
        'ALTER TABLE chat_sessions ADD COLUMN experiment_pending INTEGER NOT NULL DEFAULT 0'
      );
      sql.exec(
        'CREATE INDEX experiment_pending ON chat_sessions(experiment_due_at) WHERE experiment_due_at IS NOT NULL'
      );
      const first = sql.exec(
        'UPDATE chat_sessions SET experiment_due_at = ?, experiment_pending = experiment_pending + 1 WHERE id = ?',
        Date.now(),
        session
      );
      expect(first.rowsWritten).toBe(2);
      const steady = sql.exec(
        'UPDATE chat_sessions SET experiment_pending = experiment_pending + 1 WHERE id = ?',
        session
      );
      expect(steady.rowsWritten).toBe(1);
      const selection = sql.exec(
        'SELECT id FROM chat_sessions WHERE experiment_due_at IS NOT NULL AND experiment_due_at <= ? ORDER BY experiment_due_at LIMIT 1',
        Date.now()
      );
      expect(selection.toArray()).toHaveLength(1);
      expect(selection.rowsRead).toBeLessThanOrEqual(2);
      const plan = sql
        .exec(
          'EXPLAIN QUERY PLAN SELECT id FROM chat_sessions WHERE experiment_due_at IS NOT NULL AND experiment_due_at <= ? ORDER BY experiment_due_at LIMIT 1',
          Date.now()
        )
        .toArray();
      expect(JSON.stringify(plan)).toContain('experiment_pending');
    });
  });

  it('attributes the steady-state writes including scheduled idle cleanup in both modes', async () => {
    const reports: unknown[] = [];
    for (const enabled of [false, true]) {
      const { stub, session, batch } = await fixture(enabled);
      const samples: WriteSample[] = [];
      const collect = await profileObject(stub, 'root', samples);
      expect(await stub.persistMessageBatch(session, batch(10002), source)).toMatchObject({
        persisted: 1,
      });
      collect();
      const writes = samples.filter((sample) => sample.rowsWritten > 0);
      reports.push({ enabled, writes });
      await runInDurableObject(stub, async (_instance, state) => state.storage.deleteAlarm());
    }
    expect(reports).toMatchSnapshot();
  });
});
