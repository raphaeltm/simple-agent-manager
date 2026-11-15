import { persistSystemMessage } from '@simple-agent-manager/project-data/internal/do/messages';
import { nextSequence } from '@simple-agent-manager/project-data/internal/do/messages-persist-helpers';
import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectDataStub } from './helpers/archive-fixtures';

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
        expect(system?.sequence).toBe(6);
      });
      await stub.persistMessageBatch(session, [message('reset-chunk', 1)], {
        ...source,
        outboxIncarnation: 'new-outbox',
      });
      const rows = (await stub.getMessages(session, 100, null, null, undefined, false, 'asc'))
        .messages;
      const sequences = rows.map((row) => row.sequence);
      expect(new Set(sequences).size).toBe(sequences.length);
      // A merged run reserves positions for its absorbed chunks too.
      expect(sequences.at(-1)).toBe(7);
      await runInDurableObject(stub, async (_instance, state) => {
        expect(
          state.storage.sql
            .exec('SELECT last_message_sequence FROM chat_sessions WHERE id=?', session)
            .toArray()[0]?.last_message_sequence
        ).toBe(7);
        // No instance-local cache participates: a fresh allocator sees SQL state.
        expect(nextSequence(state.storage.sql, session)).toBe(8);
        await state.storage.deleteAlarm();
      });
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
