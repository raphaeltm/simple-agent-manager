import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import type {
  RowUsage,
  RowUsageTotals,
} from '@simple-agent-manager/project-data/internal/do/row-usage';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectDataStub } from './helpers/archive-fixtures';

afterEach(() => vi.restoreAllMocks());

describe('message ingest row cost in real workerd', () => {
  it('attributes archive reclaim reads with unrelated comments', async () => {
    const stub = projectDataStub(`reclaim-cost-${crypto.randomUUID()}`);
    const session = await stub.createSession(null, 'Reclaim fixture');
    const other = await stub.createSession(null, 'Unrelated fixture');
    const cursors: Array<{ query: string; cursor: SqlStorageCursor }> = [];
    await runInDurableObject(stub, (instance, state) => {
      const sql = state.storage.sql;
      sql.exec(
        `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
        INSERT INTO chat_messages (id,session_id,role,content,created_at,sequence)
        SELECT 'reclaim-'||x, ?, 'assistant','synthetic',x,x FROM n`,
        session
      );
      sql.exec(
        `INSERT INTO chat_messages (id,session_id,role,content,created_at,sequence)
        VALUES ('unrelated-message',?,'user','synthetic',1,1)`,
        other
      );
      for (const table of ['comment_threads', 'anchored_comment_threads']) {
        const extra = table === 'anchored_comment_threads' ? ', anchor_kind,scope_key' : '';
        const values = table === 'anchored_comment_threads' ? ", 'message',?" : '';
        sql.exec(
          `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000)
          INSERT INTO ${table} (id,session_id,message_id,body,author_type,author_id,created_at,updated_at,sequence${extra})
          SELECT 'comment-'||x,?,'unrelated-message','synthetic','human','fixture',1,1,x${values} FROM n`,
          ...(table === 'anchored_comment_threads' ? [other, other] : [other])
        );
      }
      sql.exec(
        `INSERT INTO project_data_archive_source_intents
        (session_id,project_id,migration_id,source_owner_name,target_owner_name,target_generation,source_intent_token,state,terminal_version_sha256,prepared_at,created_at,updated_at)
        VALUES (?,'cost-project','cost-migration','root','archive',1,'synthetic-token','source_deleted','synthetic-hash',1,1,1)`,
        session
      );
      const holder = instance as unknown as { sql: SqlStorage };
      const original = holder.sql;
      holder.sql = new Proxy(original, {
        get(target, key) {
          if (key === 'exec')
            return (query: string, ...bindings: unknown[]) => {
              const cursor = target.exec(query, ...bindings);
              cursors.push({ query, cursor });
              return cursor;
            };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    expect(
      await stub.archiveSourceReclaimPage({
        projectId: 'cost-project',
        sessionId: session,
        migrationId: 'cost-migration',
        maxRows: 25,
      })
    ).toMatchObject({ messagesDeleted: 25, remaining: true });
    expect(
      cursors.map(({ query, cursor }) => ({
        statement: query.replace(/\s+/g, ' ').trim(),
        read: cursor.rowsRead,
        written: cursor.rowsWritten,
      }))
    ).toMatchSnapshot();
    await runInDurableObject(stub, async (_instance, state) => {
      for (const table of ['comment_threads', 'anchored_comment_threads'])
        expect(
          state.storage.sql
            .exec(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id=?`, other)
            .toArray()[0]?.n
        ).toBe(1000);
      await state.storage.deleteAlarm();
    });
  });
  it('profiles long-session batches with production indexes', async () => {
    const reports: unknown[] = [];
    for (const count of [10000, 30000])
      for (const enabled of [false, true]) {
        vi.spyOn(projectDataPorts().operations, 'messageMergeConfig').mockResolvedValue({
          enabled,
          maxRowBytes: 65536,
          recentIds: 200,
        });
        const stub = projectDataStub(`ingest-cost-${crypto.randomUUID()}`);
        const session = await stub.createSession('cost-workspace', 'Existing topic');
        const now = Date.now();
        await runInDurableObject(stub, (_instance, state) => {
          state.storage.sql.exec(
            `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?)
          INSERT INTO chat_messages (id,session_id,role,content,created_at,sequence)
          SELECT 'fixture-'||x, ?, 'assistant', 'synthetic fixture', ?+x, x FROM n`,
            count,
            session,
            now - count - 10000
          );
          state.storage.sql.exec(
            'UPDATE chat_sessions SET message_count=?,last_message_sequence=NULL WHERE id=?',
            count,
            session
          );
          state.storage.sql.exec(
            `INSERT INTO acp_sessions (id,chat_session_id,node_id,status,created_at,updated_at)
          VALUES ('cost-acp',?,'cost-node','running',?,?)`,
            session,
            now,
            now
          );
          state.storage.sql.exec(
            `INSERT INTO session_state (session_id,activity,activity_at,work_at)
          VALUES ('cost-acp','prompting',?,?)`,
            now,
            now
          );
        });
        const source = {
          workspaceId: 'cost-workspace',
          callbackGeneration: 'cost-generation',
          outboxIncarnation: 'cost-outbox',
        };
        const message = (id: string, role = 'assistant', sequence?: number) => ({
          messageId: id,
          role,
          content: `synthetic ${id}`,
          toolMetadata: null,
          timestamp: new Date(now).toISOString(),
          sequence,
        });
        await stub.persistMessageBatch(
          session,
          [message('warmup', 'assistant', count + 1)],
          source
        );
        const pending: Array<{ statement: string; cursor: SqlStorageCursor }> = [];
        let restore = () => {};
        await runInDurableObject(stub, (instance) => {
          const holder = instance as unknown as { sql: SqlStorage };
          const original = holder.sql;
          restore = () => {
            holder.sql = original;
          };
          holder.sql = new Proxy(original, {
            get(target, key) {
              if (key === 'exec')
                return (query: string, ...bindings: unknown[]) => {
                  const cursor = target.exec(query, ...bindings);
                  pending.push({ statement: query.replace(/\s+/g, ' ').trim(), cursor });
                  return cursor;
                };
              const value = Reflect.get(target, key, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        });
        for (const [label, batch] of [
          ['steady', [message('steady', 'assistant', count + 2)]],
          ['user', [message('user', 'user')]],
        ] as const) {
          const meterTotals = () =>
            runInDurableObject(stub, (instance) => {
              const meter = (instance as unknown as { rowUsage: RowUsage }).rowUsage;
              meter.fold();
              const totals = (
                meter as unknown as { totals: Map<string, RowUsageTotals> }
              ).totals.get('persistMessageBatch')!;
              return { ...totals };
            });
          const before = await meterTotals();
          await stub.persistMessageBatch(session, [...batch], source);
          const after = await meterTotals();
          const statements = pending.map(({ statement, cursor }) => ({
            statement,
            read: cursor.rowsRead,
            written: cursor.rowsWritten,
          }));
          const read = statements.reduce((n, s) => n + s.read, 0);
          const written = statements.reduce((n, s) => n + s.written, 0);
          expect(read).toBeLessThan(30);
          expect(after.rowsRead - before.rowsRead).toBe(read);
          expect(after.rowsWritten - before.rowsWritten).toBe(written);
          if (count === 10000) reports.push({ enabled, label, read, written, statements });
          pending.length = 0;
        }
        await runInDurableObject(stub, async (_instance, state) => {
          restore();
          await state.storage.deleteAlarm();
        });
      }
    expect(reports).toMatchSnapshot();
    expect(reports).toHaveLength(4);
  });
});
