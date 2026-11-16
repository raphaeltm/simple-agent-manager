import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import mixedReporter from './fixtures/archive-reporter-messages.json';
import thinkingReporter from './fixtures/thinking-tool-reporter-messages.json';
import { projectDataStub } from './helpers/archive-fixtures';
import { profileObject, type WriteSample } from './helpers/archive-write-profile';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

afterEach(() => vi.restoreAllMocks());
const config = { maxRowBytes: 65536, recentIds: 200, bookkeepingIntervalMs: 30000 };
const BATCHES = 120;
const source = {
  workspaceId: 'traffic-cost-workspace',
  callbackGeneration: 'traffic-cost-generation',
  outboxIncarnation: 'traffic-cost-outbox',
};
// Fill only from the identical Part1-only workerd run, never an unmatched sample.
const beforeDoWrites: Record<string, { off: number; on: number }> = {
  steady: { off: 1205, on: 965 },
  mixed: { off: 2309, on: 1253 },
  'thinking-tool': { off: 2309, on: 1901 },
};
function totals(samples: WriteSample[]) {
  const sql = samples.filter(
    (row) =>
      row.owner === 'traffic' &&
      !row.statement.startsWith('storage.') &&
      !row.statement.startsWith('KV.')
  );
  const native = samples.filter(
    (row) =>
      row.owner === 'traffic' &&
      (row.statement.startsWith('storage.') || row.statement.startsWith('KV.'))
  );
  const statements = new Map<
    string,
    { calls: number; reads: number | null; writes: number }
  >();
  for (const row of samples) {
    const key = row.owner + ':' + row.phase + ':' + row.statement;
    const prior = statements.get(key) ?? { calls: 0, reads: 0, writes: 0 };
    prior.calls++;
    prior.reads =
      typeof row.rowsRead === 'number' && prior.reads !== null
        ? prior.reads + row.rowsRead
        : null;
    prior.writes += row.rowsWritten;
    statements.set(key, prior);
  }
  const sqlWrites = sql.reduce((n, row) => n + row.rowsWritten, 0),
    nativeWrites = native.reduce((n, row) => n + row.rowsWritten, 0);
  return {
    sqlWrites,
    nativeWrites,
    totalDoWrites: sqlWrites + nativeWrites,
    sqlReads: sql.every((row) => typeof row.rowsRead === 'number')
      ? sql.reduce((n, row) => n + (row.rowsRead ?? 0), 0)
      : null,
    d1Writes: samples.some((row) => row.owner === 'D1')
      ? samples
          .filter((row) => row.owner === 'D1')
          .reduce((n, row) => n + row.rowsWritten, 0)
      : null,
    statements: [...statements]
      .map(([statement, value]) => ({ statement, ...value }))
      .sort((a, b) => a.statement.localeCompare(b.statement)),
  };
}

describe('matched real-reporter ingest traffic row cost in workerd', () => {
  it('measures steady, mixed and thinking/tool windows including due alarms and end-turn', async () => {
    const reports = [];
    for (const shape of ['steady', 'mixed', 'thinking-tool'] as const) {
      for (const enabled of [false, true]) {
        vi.restoreAllMocks();
        const base = Date.now() + 3600000;
        const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
        vi.spyOn(projectDataPorts().operations, 'messageMergeConfig').mockResolvedValue({
          ...config,
          enabled,
        });
        const projectId = 'traffic-' + crypto.randomUUID(),
          owner = 'traffic-owner';
        await seedUser(owner);
        await seedInstallation('traffic-installation', owner);
        await seedProject(projectId, owner, 'traffic-installation');
        const stub = projectDataStub(projectId);
        await stub.ensureProjectId(projectId);
        const session = await stub.createSession(
          source.workspaceId,
          'Existing traffic topic'
        );
        const variant = await runInDurableObject(stub, (_instance, state) => {
          state.storage.sql.exec(
            `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
          INSERT INTO chat_messages(id,session_id,role,content,created_at,sequence)
          SELECT 'history-'||x,?,'assistant','synthetic history',?-10000000+x,x FROM n`,
            session,
            base
          );
          state.storage.sql.exec(
            'UPDATE chat_sessions SET message_count=10000,last_message_sequence=10000,last_message_sequence_count=10000 WHERE id=?',
            session
          );
          state.storage.sql.exec(
            `INSERT INTO acp_sessions(id,chat_session_id,node_id,status,created_at,updated_at) VALUES ('traffic-acp',?,'traffic-node','running',?,?)`,
            session,
            base,
            base
          );
          return state.storage.sql
            .exec('PRAGMA table_info(chat_sessions)')
            .toArray()
            .some((row) => row.name === 'pending_message_count')
            ? 'bookkeeping'
            : 'part1';
        });
        await stub.reportActivity('traffic-acp', 'prompting', {
          observedAt: base,
          promptStartedAt: base,
        });
        await stub.persistMessageBatch(
          session,
          [
            {
              messageId: 'warmup',
              role: 'assistant',
              content: 'synthetic warmup',
              toolMetadata: null,
              timestamp: new Date(base).toISOString(),
              sequence: 10001,
            },
          ],
          source
        );
        await stub.markAgentCompleted(session);
        await stub.runSummarySyncForTest();
        await runDurableObjectAlarm(stub);
        const samples: WriteSample[] = [];
        const collect = await profileObject(stub, 'traffic', samples, true);
        const roles: Record<string, number> = {};
        let dueAlarms = 0;
        for (let tick = 0; tick < BATCHES; tick++) {
          const now = base + (tick + 1) * 2000;
          clock.mockReturnValue(now);
          const fixture = shape === 'mixed' ? mixedReporter : thinkingReporter;
          const batch =
            shape === 'steady'
              ? [
                  {
                    messageId: 'steady-' + tick,
                    role: 'assistant',
                    content: 'synthetic steady chunk',
                    toolMetadata: null,
                    timestamp: new Date(now).toISOString(),
                    sequence: 10002 + tick,
                  },
                ]
              : fixture.slice(tick * 4, tick * 4 + 4).map((row, index) => ({
                  ...row,
                  sequence: 10002 + tick * 4 + index,
                  timestamp: new Date(now - 1500 + index * 500).toISOString(),
                  toolMetadata: row.toolMetadata ?? null,
                }));
          for (const row of batch) roles[row.role] = (roles[row.role] ?? 0) + 1;
          await stub.persistMessageBatch(session, batch, source);
          const alarm = await runInDurableObject(stub, (_instance, state) =>
            state.storage.getAlarm()
          );
          if (alarm !== null && alarm <= now) {
            if (await runDurableObjectAlarm(stub)) dueAlarms++;
          }
        }
        expect(
          await stub.recordSessionTurnEnd('traffic-acp', {
            reason: 'completed',
            observedAt: Date.now(),
          })
        ).toBe(true);
        await stub.runSummarySyncForTest();
        collect();
        const report = {
          shape,
          enabled,
          variant,
          batches: BATCHES,
          seconds: BATCHES * 2,
          roles,
          dueAlarms,
          ...totals(samples),
        };
        reports.push(report);
        await runInDurableObject(stub, async (_instance, state) => {
          await state.storage.deleteAlarm();
        });
        await evictDurableObject(stub);
      }
    }
    console.info('INGEST_TRAFFIC_COST_NUMERIC', JSON.stringify(reports));
    for (const report of reports) {
      expect(report.totalDoWrites).toBeGreaterThan(0);
      const before = beforeDoWrites[report.shape];
      if (report.variant === 'bookkeeping' && before)
        expect(report.totalDoWrites).toBeLessThanOrEqual(
          report.enabled ? before.on : before.off
        );
    }
  }, 120000);

  it('attributes the original complete 2100-row/50-per-batch mixed fixture without lifecycle extras', async () => {
    const reports = [];
    for (const enabled of [false, true]) {
      vi.restoreAllMocks();
      const base = Date.now() + 3600000;
      vi.spyOn(Date, 'now').mockReturnValue(base);
      vi.spyOn(projectDataPorts().operations, 'messageMergeConfig').mockResolvedValue({
        ...config,
        enabled,
      });
      const stub = projectDataStub('mixed50-' + crypto.randomUUID());
      await stub.ensureProjectId('merge-test');
      const session = await stub.createSession('merge-workspace', 'Merge test');
      const end = Date.parse(mixedReporter.at(-1)!.timestamp);
      const samples: WriteSample[] = [];
      const collect = await profileObject(stub, 'traffic', samples, true);
      const rows = mixedReporter.map((row) => ({
        ...row,
        timestamp: new Date(base - end + Date.parse(row.timestamp)).toISOString(),
        toolMetadata: row.toolMetadata ?? null,
      }));
      for (let offset = 0; offset < rows.length; offset += 50)
        await stub.persistMessageBatch(session, rows.slice(offset, offset + 50), {
          workspaceId: 'merge-workspace',
          callbackGeneration: 'generation-a',
          outboxIncarnation: '7aba0c09-bbf4-4d84-8a0a-4fcab3bdce50',
        });
      collect();
      const report = {
        shape: 'original-mixed50',
        enabled,
        batches: 42,
        messages: rows.length,
        ...totals(samples),
      };
      reports.push(report);
      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.deleteAlarm();
      });
      await evictDurableObject(stub);
    }
    console.info('INGEST_ORIGINAL_MIXED50_NUMERIC', JSON.stringify(reports));
    for (const report of reports) {
      expect(report.totalDoWrites).toBeGreaterThan(0);
      expect(report.totalDoWrites).toBeLessThanOrEqual(report.enabled ? 1596 : 6615);
    }
  }, 120000);
});
