import { readMessageIngestState } from '@simple-agent-manager/project-data/internal/do/message-stream-ingest';
import { persistSystemMessage } from '@simple-agent-manager/project-data/internal/do/messages';
import { nextSequence } from '@simple-agent-manager/project-data/internal/do/messages-persist-helpers';
import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import {
  copyBackProjectDataArchiveMigration,
  runScopedProjectDataArchiveCanary,
} from '@simple-agent-manager/project-data/internal/scheduled/project-data-archive-sharding';
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env as WorkerEnv } from '../../src/env';
import { projectDataStub, readLocation, withArchiveEnv } from './helpers/archive-fixtures';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

afterEach(() => vi.restoreAllMocks());
const source = {
  workspaceId: 'sequence-workspace',
  callbackGeneration: 'generation',
  outboxIncarnation: 'outbox',
};
const message = (id: string, sequence?: number) => ({
  messageId: id,
  role: 'assistant',
  content: 'synthetic chunk',
  toolMetadata: null,
  timestamp: new Date().toISOString(),
  sequence,
});

describe('durable per-session sequence watermark', () => {
  it('restores a genuinely merged transcript and allocates above its absorbed positions', async () => {
    vi.spyOn(projectDataPorts().operations, 'messageMergeConfig').mockResolvedValue({
      enabled: true,
      maxRowBytes: 65536,
      recentIds: 200,
    });
    const projectId = `sequence-copyback-${crypto.randomUUID()}`;
    const owner = `sequence-owner-${crypto.randomUUID()}`;
    const installation = `sequence-install-${crypto.randomUUID()}`;
    await seedUser(owner);
    await seedInstallation(installation, owner);
    await seedProject(projectId, owner, installation);
    const stub = projectDataStub(projectId);
    await stub.ensureProjectId(projectId);
    const session = await stub.createSession(source.workspaceId, 'Merged restore fixture');
    for (let position = 1; position <= 12; position++)
      await stub.persistMessageBatch(session, [message(`merged-${position}`, position)], source);
    await stub.stopSession(session);
    await stub.runSummarySyncForTest();
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            'SELECT COUNT(*) AS n,MAX(sequence) AS last FROM chat_messages WHERE session_id=?',
            session
          )
          .toArray()[0]
      ).toMatchObject({ n: 1, last: 1 });
    });
    await withArchiveEnv(
      {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
        PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'true',
      },
      async () => {
        const workerEnv = env as unknown as WorkerEnv;
        const migrated = await runScopedProjectDataArchiveCanary(workerEnv, {
          projectId,
          sessionId: session,
          dryRun: false,
          reason: 'Synthetic merged watermark restore regression',
          nowDate: new Date(Date.now() + 60000),
        });
        expect(migrated.stats).toMatchObject({ migrated: 1, failed: 0 });
        const location = await readLocation(projectId, session);
        await runInDurableObject(stub, (_instance, state) => {
          // Exercise restore's known-but-behind case; the real ingest built the stream frontier.
          state.storage.sql.exec(
            'UPDATE chat_sessions SET last_message_sequence=0 WHERE id=?',
            session
          );
        });
        await copyBackProjectDataArchiveMigration(workerEnv, {
          projectId,
          migrationId: location!.migration_id!,
          reason: 'Synthetic merged watermark restore regression',
        });
      }
    );
    // A restored terminal transcript is made writable by the existing sleep/wake lifecycle.
    await runInDurableObject(stub, (_instance,state)=>{state.storage.sql.exec("UPDATE chat_sessions SET status='sleeping' WHERE id=?",session);});
    expect(await stub.wakeSession(session, source.workspaceId, 'synthetic-task')).toBe(true);
    await stub.persistMessageBatch(session, [message('after-copyback')]);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec('SELECT sequence FROM chat_messages WHERE id=?', 'after-copyback')
          .toArray()[0]?.sequence
      ).toBe(13);
    });
  });
  it('advances a known watermark during raw archive target import', async () => {
    const projectId = `sequence-archive-${crypto.randomUUID()}`;
    const stub = projectDataStub(projectId);
    await stub.ensureProjectId(projectId);
    const session = await stub.createSession(null, 'Archive sequence fixture');
    await stub.persistMessageBatch(session, [
      message('archive-first', 10),
      message('archive-last', 50),
    ]);
    await stub.stopSession(session);
    const base = {
      projectId,
      sessionId: session,
      migrationId: crypto.randomUUID(),
      sourceOwnerName: projectId,
      targetOwnerName: `${projectId}:archive:g1:s0`,
      targetGeneration: 1,
      sourceIntentToken: crypto.randomUUID(),
      now: Date.now() + 60000,
      minTerminalAgeMs: 0,
    };
    const prepared = await stub.archiveSourcePrepareIntent(base);
    if ('refused' in prepared) throw new Error('Synthetic terminal archive fixture refused');
    const target = projectDataStub(base.targetOwnerName);
    await target.archiveTargetPrepare({
      ...base,
      terminalVersionSha256: prepared.terminalVersionSha256,
      expectedMessageCount: prepared.messageCount,
      sessionRow: prepared.sessionRow,
    });
    // New archive anchors omit derived cache columns and start unknown.
    await runInDurableObject(target, (_instance, state) => {
      expect(
        state.storage.sql
          .exec('SELECT last_message_sequence FROM chat_sessions WHERE id=?', session)
          .toArray()[0]?.last_message_sequence
      ).toBeNull();
      state.storage.sql.exec(
        'UPDATE chat_sessions SET last_message_sequence=0 WHERE id=?',
        session
      );
    });
    const chunk = await stub.archiveSourceExportChunk({
      ...base,
      tableName: 'chat_messages',
      ordinal: 0,
      maxRows: 100,
    });
    await target.archiveTargetCommitChunk({ ...chunk, now: base.now });
    await runInDurableObject(target, (_instance, state) => {
      expect(
        state.storage.sql
          .exec('SELECT last_message_sequence FROM chat_sessions WHERE id=?', session)
          .toArray()[0]?.last_message_sequence
      ).toBe(50);
      expect(nextSequence(state.storage.sql, session)).toBe(51);
    });
    expect((await target.archiveTargetCommitChunk({ ...chunk, now: base.now })).idempotent).toBe(
      true
    );
  });
  for (const enabled of [false, true]) {
    it(`serializes mixed writers and outbox resets with merging ${enabled}`, async () => {
      vi.spyOn(projectDataPorts().operations, 'messageMergeConfig').mockResolvedValue({
        enabled,
        maxRowBytes: 65536,
        recentIds: 200,
      });
      const stub = projectDataStub(`sequence-${crypto.randomUUID()}`);
      const session = await stub.createSession(source.workspaceId, 'Existing topic');
      await stub.persistMessage(session, 'user', 'synthetic prompt', null, 'browser');
      await stub.persistMessageBatch(
        session,
        [message('chunk-1', 1), message('chunk-2', 2)],
        source
      );
      expect(
        (
          await stub.persistMessageBatch(
            session,
            [message('chunk-1', 1), message('chunk-2', 2)],
            source
          )
        ).persisted
      ).toBe(0);
      await Promise.all([
        stub.persistMessage(session, 'user', 'second synthetic prompt', null, 'browser-2'),
        stub.persistMessageBatch(session, [message('chunk-3', 3)], source),
      ]);
      await runInDurableObject(stub, (_instance, state) => {
        const system = persistSystemMessage(state.storage.sql, session, 'synthetic system notice');
        expect(system?.sequence).toBe(4);
      });
      await stub.persistMessageBatch(session, [message('reset-chunk', 1)], {
        ...source,
        outboxIncarnation: 'new-outbox',
      });
      const rows = (await stub.getMessages(session, 100, null, null, undefined, false, 'asc'))
        .messages;
      // Reporter positions retain the existing semantics, including an outbox reset.
      expect(rows.find((row) => row.id === 'reset-chunk')?.sequence).toBe(1);
      await runInDurableObject(stub, async (_instance, state) => {
        expect(
          state.storage.sql
            .exec('SELECT last_message_sequence FROM chat_sessions WHERE id=?', session)
            .toArray()[0]?.last_message_sequence
        ).toBe(4);
        // No instance-local cache participates: a fresh allocator sees SQL state.
        expect(nextSequence(state.storage.sql, session)).toBe(5);
        await state.storage.deleteAlarm();
      });
    });
  }

  it('recovers a stale watermark after an older build writes messages', async () => {
    const stub = projectDataStub(`rolling-sequence-${crypto.randomUUID()}`);
    const session = await stub.createSession(null, 'Rolling build fixture');
    await stub.persistMessage(session, 'user', 'synthetic first', null, 'before-old-build');
    // Old code knows neither derived column but updates the existing logical count.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO chat_messages (id,session_id,role,content,created_at,sequence)
        VALUES ('old-build-message',?,'assistant','synthetic older build',?,10)`,
        session,
        Date.now()
      );
      state.storage.sql.exec(
        'UPDATE chat_sessions SET message_count=message_count+1 WHERE id=?',
        session
      );
    });
    await stub.persistMessageBatch(session, [message('after-old-build')]);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec('SELECT sequence FROM chat_messages WHERE id=?', 'after-old-build')
          .toArray()[0]?.sequence
      ).toBe(11);
      expect(nextSequence(state.storage.sql, session)).toBe(12);
    });
  });

  for (const enabled of [false, true]) {
    it(`matches the old MAX allocator for every stored position with merging ${enabled}`, async () => {
      vi.spyOn(projectDataPorts().operations, 'messageMergeConfig').mockResolvedValue({
        enabled, maxRowBytes: 65536, recentIds: 200,
      });
      const subjects = await Promise.all(['watermark', 'legacy-max'].map(async (kind) => {
        const stub = projectDataStub(`${kind}-${crypto.randomUUID()}`);
        return { stub, session: await stub.createSession(source.workspaceId, 'Differential fixture') };
      }));
      const expectedPositions = new Map<string, number>();
      const inspect = async (index: number) => {
        const subject = subjects[index]!;
        return runInDurableObject(subject.stub, (_instance, state) => {
          const sql = state.storage.sql;
          const rows = sql.exec("SELECT CASE WHEN role='system' THEN 'system' ELSE id END AS id,sequence FROM chat_messages WHERE session_id=? ORDER BY 1", subject.session).toArray();
          // Independent model of the original assignment expression, including positions
          // that merging keeps as a canonical row. This catches normalization even if
          // both real-ingest subjects accidentally share that behavior in a future edit.
          for (const row of rows) expect(row.sequence).toBe(expectedPositions.get(String(row.id)));
          const maximum = Number(sql.exec('SELECT COALESCE(MAX(sequence),0) AS n FROM chat_messages WHERE session_id=?', subject.session).toArray()[0]!.n);
          const session = sql.exec('SELECT stream_ingest_state FROM chat_sessions WHERE id=?', subject.session).toArray()[0]!;
          const oldNext = Math.max(maximum, readMessageIngestState(session.stream_ingest_state)?.maxSequence ?? 0) + 1;
          expect(nextSequence(sql, subject.session)).toBe(oldNext);
          return { rows, next: oldNext };
        });
      };
      const apply = async (operation: (stub: typeof subjects[number]['stub'], session: string) => Promise<unknown>) => {
        // Force the reference through the same MAX query the previous implementation ran
        // before every operation. The candidate keeps its durable watermark between calls.
        const reference = subjects[1]!;
        await runInDurableObject(reference.stub, (_instance, state) => {
          state.storage.sql.exec('UPDATE chat_sessions SET last_message_sequence=NULL,last_message_sequence_count=NULL WHERE id=?', reference.session);
        });
        for (const subject of subjects) await operation(subject.stub, subject.session);
        expect(await inspect(0)).toEqual(await inspect(1));
      };
      let batch = 0;
      const send = async (positions: Array<number | undefined>) => {
        const group = ++batch;
        let oldNext = (await inspect(1)).next;
        positions.forEach((position, index) => expectedPositions.set(`batch-${group}-${index}`, position ?? oldNext++));
        const messages = positions.map((position, index) => ({
          ...message(`batch-${group}-${index}`, position),
          timestamp: '2026-11-15T00:00:00.000Z',
        }));
        await apply((stub, session) => stub.persistMessageBatch(session, messages, source));
      };
      await send([undefined, undefined]);
      await send([5, 6]);
      await send([9, 8, 7]);
      await send([10, 10]);
      expectedPositions.set('user', (await inspect(1)).next);
      await apply((stub, session) => stub.persistMessage(session, 'user', 'synthetic differential user', null, 'user'));
      expectedPositions.set('system', (await inspect(1)).next);
      await apply((stub, session) => runInDurableObject(stub, (_instance, state) => persistSystemMessage(state.storage.sql, session, 'synthetic differential system')));
      await send([20, undefined, 15, undefined]);
      await send([0, -1, 10000.5]);
      await send([undefined]);
      await send([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 10]);
      await send([undefined]);
    });
  }

  it('initializes a legacy NULL only once and honors absorbed logical positions', async () => {
    const stub = projectDataStub(`legacy-sequence-${crypto.randomUUID()}`);
    const session = await stub.createSession(null, 'Existing topic');
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO chat_messages (id,session_id,role,content,created_at,sequence)
        VALUES ('legacy-message',?,'assistant','synthetic',1,100)`,
        session
      );
      sql.exec(
        'UPDATE chat_sessions SET last_message_sequence=NULL, message_count=1,stream_ingest_state=? WHERE id=?',
        JSON.stringify({
          source: 'legacy',
          through: 150,
          maxSequence: 150,
          recent: [],
          open: null,
        }),
        session
      );
    });
    await stub.persistMessage(session, 'user', 'synthetic followup', null, 'after-upgrade');
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      expect(
        sql.exec('SELECT sequence FROM chat_messages WHERE id=?', 'after-upgrade').toArray()[0]
          ?.sequence
      ).toBe(151);
      expect(
        sql.exec('SELECT last_message_sequence FROM chat_sessions WHERE id=?', session).toArray()[0]
          ?.last_message_sequence
      ).toBe(151);
      const cursors: SqlStorageCursor[] = [];
      const proxy = new Proxy(sql, {
        get(target, key) {
          if (key === 'exec')
            return (query: string, ...args: unknown[]) => {
              const cursor = target.exec(query, ...args);
              cursors.push(cursor);
              return cursor;
            };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      expect(nextSequence(proxy, session)).toBe(152);
      expect(cursors.reduce((n, c) => n + c.rowsRead, 0)).toBe(1);
      await state.storage.deleteAlarm();
    });
  });

  it('rolls back the watermark and transcript together after a failed batch', async () => {
    const stub = projectDataStub(`sequence-rollback-${crypto.randomUUID()}`);
    const session = await stub.createSession(null, 'Existing topic');
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`CREATE TRIGGER synthetic_batch_failure BEFORE INSERT ON chat_messages
        WHEN NEW.id='fail' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
    });
    const response = await stub.fetch(
      new Request('https://test/__capture-expected-error', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'persistMessageBatch',
          args: [session, [message('first'), message('fail')]],
        }),
      })
    );
    expect(await response.json()).toMatchObject({ threw: true });
    await stub.persistMessage(session, 'user', 'synthetic after rollback', null, 'after-rollback');
    const rows = (await stub.getMessages(session, 100, null, null, undefined, false, 'asc'))
      .messages;
    expect(rows.map((row) => ({ id: row.id, sequence: row.sequence }))).toEqual([
      { id: 'after-rollback', sequence: 1 },
    ]);
  });
});
