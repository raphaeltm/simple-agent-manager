import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectDataStub } from './helpers/archive-fixtures';
import { profileObject, type WriteSample } from './helpers/archive-write-profile';

const activeStubs: ReturnType<typeof projectDataStub>[] = [];
afterEach(async () => {
  for (const stub of activeStubs.splice(0)) {
    await runInDurableObject(stub, () => undefined);
    await evictDurableObject(stub);
  }
  vi.restoreAllMocks();
});
const source = {
  workspaceId: 'seal-workspace',
  callbackGeneration: 'seal-generation',
  outboxIncarnation: 'seal-outbox',
};
async function fixture(maximum = 10000) {
  vi.spyOn(projectDataPorts().operations, 'messageMergeConfig').mockResolvedValue({
    enabled: true,
    maxRowBytes: 65536,
    recentIds: 200,
    bookkeepingFlushBatchSize: 100,
    bookkeepingSealMaxSessions: maximum,
    bookkeepingSealLeaseMs: 30000,
  });
  const stub = projectDataStub('bookkeeping-seal-' + crypto.randomUUID());
  activeStubs.push(stub);
  const create = async () => {
    const id = await stub.createSession(source.workspaceId, 'Synthetic seal');
    await stub.persistMessageBatch(
      id,
      [
        {
          messageId: 'chunk-' + id,
          sequence: 1,
          role: 'assistant',
          content: 'synthetic searchable seal',
          toolMetadata: null,
          timestamp: new Date().toISOString(),
        },
      ],
      source
    );
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT json_extract(stream_ingest_state,'$.open.id') AS id FROM chat_sessions WHERE id=?",
            id
          )
          .one().id
      ).toBeTruthy();
    });
    return id;
  };
  return { stub, create };
}
async function legacy(stub: ReturnType<typeof projectDataStub>, session?: string) {
  return stub.fetch(
    new Request('https://test/ws' + (session ? '?sessionId=' + session : ''), {
      headers: { Upgrade: 'websocket' },
    })
  );
}
async function close(response: Response) {
  const socket = response.webSocket!;
  socket.accept();
  const closed = new Promise<void>((resolve) =>
    socket.addEventListener('close', () => resolve(), { once: true })
  );
  socket.close();
  await closed;
}

describe('bookkeeping at real compatibility and materialization boundaries', () => {
  it('flushes a targeted legacy seal and materialization through public handlers', async () => {
    const { stub, create } = await fixture();
    const session = await create();
    const response = await legacy(stub, session);
    expect(response.status).toBe(101);
    await close(response);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT message_count,pending_message_count,json_extract(stream_ingest_state,'$.open') AS open FROM chat_sessions WHERE id=?",
            session
          )
          .one()
      ).toMatchObject({ message_count: 1, pending_message_count: 0, open: null });
    });
    const indexed = await create();
    await stub.materializeSession(indexed);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec('SELECT message_count,pending_message_count FROM chat_sessions WHERE id=?', indexed)
          .one()
      ).toMatchObject({ message_count: 1, pending_message_count: 0 });
      expect(
        Number(
          state.storage.sql
            .exec('SELECT COUNT(*) AS n FROM chat_messages_grouped WHERE session_id=?', indexed)
            .one().n
        )
      ).toBe(1);
    });
  });

  it('rejects a partial global seal, preserves progress, and accepts only after every row flushed', async () => {
    const { stub, create } = await fixture(2);
    await create();
    await create();
    await create();
    expect((await legacy(stub)).status).toBe(503);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        Number(
          state.storage.sql
            .exec('SELECT COUNT(*) AS n FROM chat_sessions WHERE pending_message_count=0')
            .one().n
        )
      ).toBe(2);
      expect(
        Number(
          state.storage.sql
            .exec(
              "SELECT COUNT(*) AS n FROM chat_sessions WHERE json_extract(stream_ingest_state,'$.open') IS NOT NULL"
            )
            .one().n
        )
      ).toBe(1);
    });
    const response = await legacy(stub);
    expect(response.status).toBe(101);
    await close(response);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        Number(state.storage.sql.exec('SELECT SUM(message_count) AS n FROM chat_sessions').one().n)
      ).toBe(3);
      expect(
        Number(
          state.storage.sql.exec('SELECT SUM(pending_message_count) AS n FROM chat_sessions').one()
            .n
        )
      ).toBe(0);
    });
  });

  it('bounds reads through 10000 predominantly closed rows and preserves its fence after eviction', async () => {
    const { stub, create } = await fixture(100);
    await runInDurableObject(stub, (instance, state) => {
      const holder = instance as unknown as { env: Record<string, unknown> };
      holder.env = { ...holder.env, MAX_SESSIONS_PER_PROJECT: '10000' };
      state.storage.sql
        .exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<9999)
        INSERT INTO chat_sessions(id,topic,status,message_count,created_at,updated_at,started_at)
        SELECT 'closed-'||x,'synthetic','stopped',0,1,1,1 FROM n`);
    });
    const session = await create();
    const samples: WriteSample[] = [];
    const collect = await profileObject(stub, 'root', samples, true);
    expect((await legacy(stub)).status).toBe(503);
    collect();
    const pages = samples.filter((row) => row.statement.startsWith('SELECT rowid AS seal_cursor'));
    expect(pages).toHaveLength(1);
    expect(pages[0]!.rowsRead).toBeLessThanOrEqual(100);
    await evictDurableObject(stub);
    await stub.persistMessageBatch(
      session,
      [
        {
          messageId: 'during-global-seal',
          sequence: 2,
          role: 'assistant',
          content: 'synthetic continuation',
          toolMetadata: null,
          timestamp: new Date().toISOString(),
        },
      ],
      source
    );
    await runInDurableObject(stub, (_instance, state) => {
      // Restored compatibility fence prevents append to an already-exposed canonical row.
      expect(
        Number(
          state.storage.sql
            .exec('SELECT COUNT(*) AS n FROM chat_messages WHERE session_id=?', session)
            .one().n
        )
      ).toBe(2);
    });
    let response: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      response = await legacy(stub);
      if (response.status === 101) break;
      expect(response.status).toBe(503);
    }
    expect(response?.status).toBe(101);
    await close(response!);
  }, 60000);

  it('seals 10000 open sessions through bounded pages at the configured outer limit', async () => {
    const { stub, create } = await fixture();
    const session = await create();
    await runInDurableObject(stub, (_instance, state) => {
      const stream = state.storage.sql
        .exec('SELECT stream_ingest_state FROM chat_sessions WHERE id=?', session)
        .one().stream_ingest_state;
      state.storage.sql.exec(
        `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<9999)
        INSERT INTO chat_sessions(id,topic,status,message_count,created_at,updated_at,started_at,stream_ingest_state)
        SELECT 'open-'||x,'synthetic','active',0,1,1,1,? FROM n`,
        stream
      );
    });
    const response = await legacy(stub);
    expect(response.status).toBe(101);
    await close(response);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        Number(state.storage.sql.exec('SELECT COUNT(*) AS n FROM chat_sessions').one().n)
      ).toBe(10000);
      expect(
        Number(
          state.storage.sql
            .exec(
              "SELECT COUNT(*) AS n FROM chat_sessions WHERE json_extract(stream_ingest_state,'$.open') IS NOT NULL"
            )
            .one().n
        )
      ).toBe(0);
    });
  }, 60000);
});
