import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import {
  COMPACT_ARCHIVE_MAX_OBJECT_BYTES,
  readCompactChunk,
  writeCompactChunk,
} from '../../../src/project-data-archive/compact-r2';
import type { ProjectDataArchiveChunk } from '../../../src/project-data-archive/contract';
import { canonicalRowsSha256 } from '../../../src/project-data-archive/hashing';
import { createSqlStorage } from './sql-storage-test-utils';

const columns = [
  'id',
  'session_id',
  'role',
  'content',
  'tool_metadata',
  'created_at',
  'sequence',
  'origin',
];

function memoryR2() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    bucket: {
      head: vi.fn(async (key: string) =>
        objects.has(key) ? { size: objects.get(key)?.byteLength } : null
      ),
      put: vi.fn(async (key: string, value: Uint8Array, options?: R2PutOptions) => {
        if (options?.onlyIf && objects.has(key)) return null;
        objects.set(key, new Uint8Array(value));
        return {};
      }),
      get: vi.fn(async (key: string) => {
        const body = objects.get(key);
        return body ? { size: body.byteLength, body: new Response(body).body } : null;
      }),
    } as unknown as R2Bucket,
  };
}

async function fixture(count = 40): Promise<ProjectDataArchiveChunk> {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `message-${i}`,
    session_id: 'session',
    role: i === 0 ? 'user' : 'assistant',
    content: `Unicode \u00e9\u{1f642} ${'repeat '.repeat(100)}`,
    tool_metadata: null,
    created_at: 1000 + i,
    sequence: i,
    origin: null,
  }));
  return {
    projectId: 'project',
    sessionId: 'session',
    migrationId: 'migration',
    sourceOwnerName: 'project',
    targetOwnerName: 'project:archive:g1:s0',
    targetGeneration: 1,
    tableName: 'chat_messages',
    ordinal: 0,
    rows,
    rowIds: rows.map((row) => row.id),
    rowCount: rows.length,
    byteCount: count * 1000,
    sha256: await canonicalRowsSha256(columns, rows),
    cursor: 'cursor',
    hasMore: false,
  };
}

describe('compact raw transcript chunks', () => {
  it('compresses, verifies the stored bytes, and round-trips exact original rows', async () => {
    const { bucket, objects } = memoryR2();
    const chunk = await fixture();
    const ref = await writeCompactChunk(bucket, 'archives', chunk);
    expect(objects.get(ref.key)!.byteLength).toBeLessThan(JSON.stringify(chunk).length / 3);
    expect(await readCompactChunk(bucket, ref, chunk)).toEqual(chunk);
    expect(bucket.get).toHaveBeenCalled();
  });

  it('fails closed on missing, corrupt, or cross-session R2 objects', async () => {
    const { bucket, objects } = memoryR2();
    const chunk = await fixture();
    const ref = await writeCompactChunk(bucket, 'archives', chunk);
    await expect(readCompactChunk(bucket, ref, { ...chunk, sessionId: 'other' })).rejects.toThrow();
    objects.set(ref.key, new Uint8Array([1, 2, 3]));
    await expect(readCompactChunk(bucket, ref, chunk)).rejects.toThrow();
    objects.delete(ref.key);
    await expect(readCompactChunk(bucket, ref, chunk)).rejects.toThrow();
  });

  it('does not overwrite a previously committed conflicting chunk on retry', async () => {
    const { bucket } = memoryR2();
    const chunk = await fixture();
    await writeCompactChunk(bucket, 'archives', chunk);
    await writeCompactChunk(bucket, 'archives', chunk);
    const conflicting = {
      ...chunk,
      rows: chunk.rows.map((row, i) => (i === 0 ? { ...row, content: 'conflict' } : row)),
    };
    await expect(writeCompactChunk(bucket, 'archives', conflicting)).rejects.toThrow();
    expect(bucket.put).toHaveBeenCalledTimes(1);
  });

  it('adds compact storage metadata to an existing database without rewriting messages', () => {
    const db = new Database(':memory:');
    try {
      const sql = createSqlStorage(db);
      runMigrations(sql);
      expect(
        sql
          .exec('SELECT storage_format FROM project_data_archive_target_sessions LIMIT 0')
          .toArray()
      ).toEqual([]);
      expect(
        sql.exec('SELECT r2_key FROM project_data_archive_raw_chunks LIMIT 0').toArray()
      ).toEqual([]);
      sql.exec(
        "INSERT INTO chat_sessions (id, status, started_at, created_at, updated_at) VALUES ('legacy', 'stopped', 1, 1, 1)"
      );
      sql.exec(
        "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES ('original', 'legacy', 'user', 'retain original', 1)"
      );
      db.exec(
        "DROP TABLE project_data_archive_raw_chunks; ALTER TABLE project_data_archive_target_sessions DROP COLUMN storage_format; DELETE FROM migrations WHERE name = '045-project-data-compact-archive'"
      );
      runMigrations(sql);
      expect(
        sql.exec("SELECT content FROM chat_messages WHERE id = 'original'").toArray()[0]?.content
      ).toBe('retain original');
    } finally {
      db.close();
    }
  });
});

describe('compact archive migration compatibility', () => {
  it.each([
    { count: 40, metadataBytes: 0 },
    { count: 100, metadataBytes: 200 * 1024 },
  ])(
    'preserves exact paging, tools, search and default-size recovery for $count rows ($metadataBytes byte metadata)',
    { timeout: 30_000 },
    async ({ count, metadataBytes }) => {
      const archive = await import('../../../src/durable-objects/project-data/archive-sharding');
      const { getMessages } = await import('../../../src/durable-objects/project-data/messages');
      const { PROJECT_DATA_ARCHIVE_TABLES } =
        await import('../../../src/project-data-archive/contract');
      const sourceDb = new Database(':memory:');
      const targetDb = new Database(':memory:');
      const source = createSqlStorage(sourceDb);
      if (metadataBytes) {
        const execute = source.exec.bind(source);
        source.exec = ((query: string, ...params: unknown[]) => {
          const cursor = execute(query, ...params);
          if (query.startsWith('SELECT id, session_id, role, content')) {
            cursor.toArray = () => {
              throw new Error('Archive raw history must stream its SQL cursor');
            };
          }
          return cursor;
        }) as typeof source.exec;
      }
      const target = createSqlStorage(targetDb);
      const { bucket, objects } = memoryR2();
      const env = { PROJECT_DATA_ARCHIVE_R2: bucket };
      try {
        runMigrations(source);
        runMigrations(target);
        source.exec(
          `INSERT INTO chat_sessions (id, status, message_count, started_at, ended_at,
        created_at, updated_at, agent_completed_at, materialized_at)
        VALUES ('session', 'stopped', ?, 1000, 1500, 1000, 1500, 1500, 1500)`,
          count
        );
        const original = await fixture(count);
        if (metadataBytes)
          for (const row of original.rows)
            row.tool_metadata = JSON.stringify({ payload: 'x'.repeat(metadataBytes) });
        original.rows[10]!.role = 'tool';
        original.rows[10]!.tool_metadata = JSON.stringify({
          content: [{ type: 'text', text: 'complete tool payload' }],
        });
        for (const row of original.rows)
          source.exec(
            `INSERT INTO chat_messages
        (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
            ...columns.map((c) => row[c])
          );
        source.exec(`INSERT INTO chat_messages_grouped (id, session_id, role, content, created_at)
        VALUES ('group', 'session', 'assistant', 'searchable complete consolidated answer', 1100)`);
        const base = {
          projectId: 'project',
          sessionId: 'session',
          migrationId: 'migration',
          sourceOwnerName: 'project',
          targetOwnerName: 'project:archive:g1:s0',
          targetGeneration: 1,
          sourceIntentToken: 'intent',
          now: 2_000_000,
          minTerminalAgeMs: 0,
        };
        expect(
          await archive.prepareArchiveSourceIntentOrRefuse(source, {
            ...base,
            writeReservation: { estimatedWrites: 1, factor: 32, maxMessages: count },
          })
        ).toMatchObject({ refused: true, reason: 'write_budget_inventory_changed' });
        expect(
          source.exec('SELECT COUNT(*) AS n FROM project_data_archive_source_intents').toArray()[0]
            ?.n
        ).toBe(0);
        const prepared = await archive.prepareArchiveSourceIntentOrRefuse(source, base);
        if ('refused' in prepared) throw new Error(JSON.stringify(prepared));
        if (!('terminalVersionSha256' in prepared)) throw new Error('Unexpected source refusal');
        const prepareTarget = {
          ...base,
          terminalVersionSha256: prepared.terminalVersionSha256,
          sessionRow: prepared.sessionRow,
          expectedMessageCount: prepared.messageCount,
        };
        archive.prepareArchiveTarget(target, { ...prepareTarget, storageFormat: 'r2-gzip-v1' });
        // A flag change/retry cannot turn an already compact target into SQLite storage.
        archive.prepareArchiveTarget(target, { ...prepareTarget, storageFormat: 'sqlite-v1' });
        const hashes: string[] = [];
        for (const tableName of PROJECT_DATA_ARCHIVE_TABLES) {
          let cursor: string | null = null;
          let ordinal = 0;
          do {
            const chunk = await archive.exportArchiveChunk(source, {
              ...base,
              tableName,
              ordinal,
              cursor,
              maxRows: metadataBytes ? 500 : 7,
              maxBytes: metadataBytes ? 2 * 1024 * 1024 : 100_000,
            });
            const rawChunkRef =
              tableName === 'chat_messages'
                ? await writeCompactChunk(bucket, 'archive', chunk)
                : undefined;
            await archive.commitArchiveTargetChunk(
              target,
              { ...chunk, rawChunkRef, now: base.now },
              env
            );
            expect(
              (
                await archive.commitArchiveTargetChunk(
                  target,
                  { ...chunk, rawChunkRef, now: base.now },
                  env
                )
              ).idempotent
            ).toBe(true);
            await expect(
              archive.commitArchiveTargetChunk(
                target,
                { ...chunk, rawChunkRef, projectId: 'wrong', now: base.now },
                env
              )
            ).rejects.toThrow();
            hashes.push(chunk.sha256);
            cursor = chunk.hasMore ? chunk.cursor : null;
            ordinal++;
          } while (cursor);
        }
        const sealInput = {
          ...base,
          terminalVersionSha256: prepared.terminalVersionSha256,
          expectedChunkHashes: hashes,
        };
        const saved = new Map(objects);
        objects.clear();
        await expect(archive.sealArchiveTarget(target, sealInput, env)).rejects.toThrow();
        expect(source.exec('SELECT COUNT(*) AS n FROM chat_messages').toArray()[0]?.n).toBe(count);
        for (const [key, value] of saved) objects.set(key, value);
        if (!metadataBytes) {
          const originalGet = bucket.get;
          let clock = Date.now();
          const date = vi.spyOn(Date, 'now').mockImplementation(() => clock);
          const deadlineEnv = { ...env, PROJECT_DATA_ARCHIVE_R2_TIMEOUT_MS: '10' };
          bucket.get = ((key: string) => {
            clock += 4;
            return originalGet.call(bucket, key);
          }) as typeof bucket.get;
          try {
            await expect(archive.sealArchiveTarget(target, sealInput, deadlineEnv)).rejects.toThrow(
              'deadline'
            );
          } finally {
            bucket.get = originalGet;
            date.mockRestore();
          }
        }
        const sealed = await archive.sealArchiveTarget(target, sealInput, env);
        expect(sealed.messageCount).toBe(count);
        expect(await archive.sealArchiveTarget(target, sealInput, env)).toEqual(sealed);
        expect(target.exec('SELECT COUNT(*) AS count FROM chat_messages').toArray()[0]?.count).toBe(
          0
        );
        const owner = { ...base, ownerName: base.targetOwnerName, generation: 1 };
        expect(archive.archiveTargetReadMessageCount(target, owner)).toBe(count);
        expect(archive.archiveTargetReadMessageCount(target, owner, ['tool'])).toBe(1);
        for (const order of ['asc', 'desc'] as const)
          for (const compact of [false, true]) {
            for (const roles of [undefined, ['assistant'], ['tool']]) {
              expect(
                await archive.archiveTargetReadMessages(target, env, owner, {
                  limit: 9,
                  before: 1035,
                  after: 1002,
                  roles,
                  compact,
                  order,
                })
              ).toEqual(
                getMessages(
                  createSqlStorage(sourceDb),
                  'session',
                  9,
                  1035,
                  1002,
                  roles,
                  compact,
                  order
                )
              );
            }
          }
        expect(
          await archive.archiveTargetReadMessageToolContent(target, env, {
            ...owner,
            messageId: 'message-10',
          })
        ).toEqual({ content: [{ type: 'text', text: 'complete tool payload' }], source: 'inline' });
        expect(
          archive.archiveTargetSearchMessages(target, owner, 'consolidated', null, 10)
        ).toHaveLength(1);
        const recovered: unknown[] = [];
        let cursor: string | null = null;
        let ordinal = 0;
        do {
          const chunk = await archive.exportArchiveTargetChunk(
            target,
            {
              ...base,
              tableName: 'chat_messages',
              ordinal,
              cursor,
              ...(metadataBytes ? {} : { maxRows: 11, maxBytes: 100_000 }),
            },
            env
          );
          recovered.push(...chunk.rows);
          cursor = chunk.hasMore ? chunk.cursor : null;
          ordinal++;
        } while (cursor);
        expect(recovered).toEqual(original.rows);
        await expect(
          archive.archiveTargetReadMessages(
            target,
            env,
            { ...owner, projectId: 'other' },
            { limit: 9, before: null, after: null, compact: false, order: 'asc' }
          )
        ).rejects.toThrow();
        objects.clear();
        await expect(archive.sealArchiveTarget(target, sealInput, env)).rejects.toThrow();
        await expect(
          archive.archiveTargetReadMessages(target, env, owner, {
            limit: 9,
            before: null,
            after: null,
            compact: false,
            order: 'asc',
          })
        ).rejects.toThrow();
        expect(source.exec('SELECT COUNT(*) AS count FROM chat_messages').toArray()[0]?.count).toBe(
          count
        );
      } finally {
        sourceDb.close();
        targetDb.close();
      }
    }
  );
});

describe('compact archive bounded failures', () => {
  it('rejects oversized metadata before fetching and cancels a stalled object read', async () => {
    const { bucket } = memoryR2();
    const chunk = await fixture();
    const ref = await writeCompactChunk(bucket, 'bounded', chunk);
    vi.mocked(bucket.get).mockClear();
    await expect(
      readCompactChunk(bucket, { ...ref, bodyBytes: COMPACT_ARCHIVE_MAX_OBJECT_BYTES + 1 }, chunk)
    ).rejects.toThrow('size');
    expect(bucket.get).not.toHaveBeenCalled();
    vi.mocked(bucket.get).mockImplementation(() => new Promise(() => undefined));
    await expect(readCompactChunk(bucket, ref, chunk, 5)).rejects.toThrow('deadline');
  });

  it('round-trips bulky inline tool metadata without truncating Unicode or JSON', async () => {
    const { bucket } = memoryR2();
    const chunk = await fixture();
    chunk.rows[0].tool_metadata = JSON.stringify({
      content: [{ type: 'text', text: 'tool result \u00e9'.repeat(100_000) }],
    });
    const ref = await writeCompactChunk(bucket, 'bulky', chunk);
    expect((await readCompactChunk(bucket, ref, chunk)).rows).toEqual(chunk.rows);
  });
});

describe('compact object corruption after transport validation', () => {
  it('rejects a bad hash, gzip corruption with an unchanged length, and decompression overflow', async () => {
    const { bucket, objects } = memoryR2();
    const chunk = await fixture();
    const ref = await writeCompactChunk(bucket, 'corruption', chunk);
    await expect(
      readCompactChunk(bucket, { ...ref, bodySha256: '0'.repeat(64) }, chunk)
    ).rejects.toThrow('hash');
    await expect(
      readCompactChunk(bucket, { ...ref, bodyBytes: ref.bodyBytes - 1 }, chunk)
    ).rejects.toThrow('byte limit');
    const bytes = objects.get(ref.key);
    if (!bytes) throw new Error('Fixture missing');
    const corrupt = new Uint8Array(bytes);
    corrupt[corrupt.length - 8] ^= 1;
    objects.set(ref.key, corrupt);
    await expect(readCompactChunk(bucket, ref, chunk)).rejects.toThrow();
  });

  it('cancels a stalled body stream at the object deadline', async () => {
    const { bucket } = memoryR2();
    const chunk = await fixture();
    const ref = await writeCompactChunk(bucket, 'stalled', chunk);
    const cancel = vi.fn();
    vi.mocked(bucket.get).mockResolvedValue({
      size: ref.bytes,
      body: new ReadableStream({ cancel }),
    } as R2ObjectBody);
    await expect(readCompactChunk(bucket, ref, chunk, 5)).rejects.toThrow('deadline');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
