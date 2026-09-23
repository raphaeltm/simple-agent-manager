import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import {
  ARCHIVE_IMMUTABLE_JSON_MAX_OBJECT_BYTES,
  COMPACT_ARCHIVE_MAX_OBJECT_BYTES,
  readCompactChunk,
  writeCompactChunk,
  writeImmutableJson,
} from '../../../src/project-data-archive/compact-r2';
import type { ProjectDataArchiveChunk } from '../../../src/project-data-archive/contract';
import {
  canonicalRowsSha256,
  createCanonicalRowsChainHasher,
} from '../../../src/project-data-archive/hashing';
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
            if (!metadataBytes && tableName === 'chat_messages' && ordinal === 0) {
              // Simulate a compact receipt written before durable projection
              // checkpoints and continuation fields shipped. Coordinator replay
              // must adopt both without restarting the immutable R2 copy.
              for (const row of target
                .exec(
                  `SELECT rowid, content FROM project_data_archive_search_documents
                   WHERE session_id = 'session'`
                )
                .toArray()) {
                target.exec(
                  `INSERT INTO project_data_archive_search_documents_fts(
                     project_data_archive_search_documents_fts, rowid, content
                   ) VALUES('delete', ?, ?)`,
                  row.rowid,
                  row.content
                );
              }
              target.exec(
                "DELETE FROM project_data_archive_search_documents WHERE session_id = 'session'"
              );
              target.exec(
                `UPDATE project_data_archive_target_sessions
                 SET search_index_version = NULL, search_index_state = NULL,
                     search_repair_phase = NULL, search_repair_next_ordinal = NULL,
                     search_repair_pending_json = NULL,
                     search_repair_message_count = NULL,
                     search_repair_projection_sha256 = NULL,
                     search_repair_document_count = NULL
                 WHERE session_id = 'session'`
              );
              target.exec(
                `UPDATE project_data_archive_target_chunks
                 SET source_cursor = NULL, source_has_more = NULL
                 WHERE session_id = 'session' AND table_name = 'chat_messages' AND ordinal = 0`
              );
            }
            expect(
              (
                await archive.commitArchiveTargetChunk(
                  target,
                  { ...chunk, rawChunkRef, now: base.now },
                  env
                )
              ).idempotent
            ).toBe(true);
            if (!metadataBytes && tableName === 'chat_messages' && ordinal === 0) {
              expect(
                target
                  .exec(
                    `SELECT search_index_state, search_repair_phase,
                            search_repair_next_ordinal
                     FROM project_data_archive_target_sessions WHERE session_id = 'session'`
                  )
                  .toArray()[0]
              ).toMatchObject({
                search_index_state: 'repairing',
                search_repair_phase: 'raw',
                search_repair_next_ordinal: 1,
              });
            }
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
        const rawChunkCount = Number(
          target
            .exec(
              `SELECT COUNT(*) AS count FROM project_data_archive_raw_chunks
               WHERE session_id = 'session'`
            )
            .toArray()[0]?.count ?? 0
        );
        // Fresh seal consumes the per-chunk verification receipts and the
        // projection built during copy; it does not traverse R2 again.
        vi.mocked(bucket.get).mockClear();
        const sealed = await archive.sealArchiveTarget(target, sealInput, env);
        expect(bucket.get).not.toHaveBeenCalled();
        expect(sealed.messageCount).toBe(count);

        // A resumed/final pre-delete seal always revalidates every immutable
        // R2 object, so loss after the first seal still fails closed.
        const saved = new Map(objects);
        objects.clear();
        await expect(archive.sealArchiveTarget(target, sealInput, env)).rejects.toThrow();
        expect(source.exec('SELECT COUNT(*) AS n FROM chat_messages').toArray()[0]?.n).toBe(count);
        for (const [key, value] of saved) objects.set(key, value);
        if (!metadataBytes) {
          const originalGet = bucket.get;
          let clock = Date.now();
          const date = vi.spyOn(Date, 'now').mockImplementation(() => clock);
          // Per-chunk timeout: each chunk gets its own budget, so each read
          // must individually exceed the timeout to trigger the error.
          const deadlineEnv = { ...env, PROJECT_DATA_ARCHIVE_R2_TIMEOUT_MS: '3' };
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
        vi.mocked(bucket.get).mockClear();
        expect(await archive.sealArchiveTarget(target, sealInput, env)).toEqual(sealed);
        expect(bucket.get).toHaveBeenCalledTimes(rawChunkCount);
        vi.mocked(bucket.get).mockClear();
        expect(await archive.sealArchiveTarget(target, sealInput, env)).toEqual(sealed);
        expect(bucket.get).toHaveBeenCalledTimes(rawChunkCount);
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
          await archive.archiveTargetSearchMessages(target, env, owner, 'consolidated', null, 10)
        ).toHaveLength(1);
        if (!metadataBytes) {
          const expectedProjection = target
            .exec(
              `SELECT projection_id, document_id, session_id, role, content, created_at
               FROM project_data_archive_search_documents
               WHERE session_id = 'session' ORDER BY rowid ASC`
            )
            .toArray();
          const expectedCoverage = target
            .exec(
              `SELECT search_index_message_count, search_index_document_count, search_index_sha256
               FROM project_data_archive_target_sessions WHERE session_id = 'session'`
            )
            .toArray()[0];
          target.exec('DELETE FROM project_data_archive_search_documents_fts');
          target.exec('DELETE FROM project_data_archive_search_documents');
          target.exec(
            `UPDATE project_data_archive_target_sessions
             SET search_index_version = NULL, search_index_state = NULL,
                 search_index_message_count = NULL, search_index_document_count = NULL,
                 search_index_sha256 = NULL, search_indexed_at = NULL,
                 search_repair_next_ordinal = NULL, search_repair_pending_json = NULL,
                 search_repair_message_count = NULL
             WHERE session_id = 'session'`
          );
          vi.mocked(bucket.get).mockClear();
          let projectSearch;
          let replayedInterruptedChunk = false;
          const firstObject = [...objects.entries()][0];
          expect(firstObject).toBeDefined();
          if (firstObject) objects.delete(firstObject[0]);
          const corruptSearch = await archive.archiveTargetSearchProjectMessages(
            target,
            env,
            {
              kind: 'archive_shard',
              projectId: 'project',
              ownerName: owner.ownerName,
              generation: 1,
            },
            'Unicode',
            null,
            10
          );
          expect(corruptSearch.coverage).toMatchObject({
            sessionsIncomplete: 1,
            errors: [{ sessionId: 'session', error: 'archive_search_projection_repair_failed' }],
          });
          if (firstObject) objects.set(firstObject[0], firstObject[1]);
          for (let step = 0; step <= rawChunkCount + 2; step++) {
            const beforeGets = vi.mocked(bucket.get).mock.calls.length;
            projectSearch = await archive.archiveTargetSearchProjectMessages(
              target,
              env,
              {
                kind: 'archive_shard',
                projectId: 'project',
                ownerName: owner.ownerName,
                generation: 1,
              },
              'Unicode',
              null,
              10
            );
            expect(vi.mocked(bucket.get).mock.calls.length - beforeGets).toBeLessThanOrEqual(1);
            if (step === 0 && rawChunkCount > 1) {
              const indexed = target
                .exec(
                  `SELECT rowid FROM project_data_archive_search_documents
                   WHERE session_id = 'session' ORDER BY rowid ASC LIMIT 1`
                )
                .toArray()[0];
              expect(indexed).toBeDefined();
              target.exec(
                'DELETE FROM project_data_archive_search_documents_fts WHERE rowid = ?',
                indexed?.rowid
              );
              target.exec(
                `UPDATE project_data_archive_target_sessions
                 SET search_repair_phase = 'raw', search_repair_next_ordinal = 0,
                     search_repair_raw_cursor = NULL, search_repair_grouped_cursor = NULL,
                     search_repair_pending_json = NULL, search_repair_message_count = 0,
                     search_repair_projection_sha256 = ?, search_repair_document_count = 0
                 WHERE session_id = 'session'`,
                createCanonicalRowsChainHasher([
                  'projection_id',
                  'document_id',
                  'session_id',
                  'role',
                  'content',
                  'created_at',
                ]).digestHex
              );
              replayedInterruptedChunk = true;
            }
            if (projectSearch.coverage.sessionsIncomplete === 0) break;
          }
          expect(projectSearch?.coverage).toMatchObject({
            sessionsAvailable: 1,
            sessionsIndexed: 1,
            sessionsIncomplete: 0,
          });
          expect(projectSearch?.results.map((result) => result.id)).toContain('message-1');
          expect(
            (
              await archive.archiveTargetSearchProjectMessages(
                target,
                env,
                {
                  kind: 'archive_shard',
                  projectId: 'project',
                  ownerName: owner.ownerName,
                  generation: 1,
                },
                'consolidated',
                null,
                10
              )
            ).results
          ).toHaveLength(1);
          expect(
            target
              .exec(
                `SELECT projection_id, document_id, session_id, role, content, created_at
                 FROM project_data_archive_search_documents
                 WHERE session_id = 'session' ORDER BY rowid ASC`
              )
              .toArray()
          ).toEqual(expectedProjection);
          expect(
            target
              .exec(
                `SELECT search_index_message_count, search_index_document_count, search_index_sha256
                 FROM project_data_archive_target_sessions WHERE session_id = 'session'`
              )
              .toArray()[0]
          ).toEqual(expectedCoverage);
          expect(bucket.get).toHaveBeenCalledTimes(
            rawChunkCount + (replayedInterruptedChunk ? 1 : 0) + 1
          );
        }
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
  it('bounds immutable JSON publication and refuses conflicting retry payloads', async () => {
    const { bucket } = memoryR2();
    await expect(
      writeImmutableJson(
        bucket,
        'too-large.json',
        'x'.repeat(ARCHIVE_IMMUTABLE_JSON_MAX_OBJECT_BYTES + 1)
      )
    ).rejects.toThrow('byte limit');
    expect(bucket.head).not.toHaveBeenCalled();

    await expect(
      writeImmutableJson(bucket, 'large-tool-row.json', {
        payload: 'x'.repeat(COMPACT_ARCHIVE_MAX_OBJECT_BYTES + 1),
      })
    ).resolves.toBeUndefined();

    await writeImmutableJson(bucket, 'manifest.json', { version: 1 });
    await expect(writeImmutableJson(bucket, 'manifest.json', { version: 2 })).rejects.toThrow(
      'conflict'
    );
    expect(bucket.put).toHaveBeenCalledTimes(2);
  });

  it('does not race a retry against a timed-out immutable provider write', async () => {
    let finishPut: ((value: R2Object) => void) | undefined;
    const stored = new Map<string, Uint8Array>();
    const bucket = {
      head: vi.fn(async (key: string) => {
        const body = stored.get(key);
        return body
          ? ({
              size: body.byteLength,
              customMetadata: {
                archiveBodySha256: await crypto.subtle
                  .digest('SHA-256', body)
                  .then((digest) =>
                    Array.from(new Uint8Array(digest), (byte) =>
                      byte.toString(16).padStart(2, '0')
                    ).join('')
                  ),
              },
            } as R2Object)
          : null;
      }),
      put: vi.fn(
        (key: string, body: Uint8Array) =>
          new Promise<R2Object>((resolve) => {
            stored.set(key, new Uint8Array(body));
            finishPut = resolve;
          })
      ),
      get: vi.fn(),
    } as unknown as R2Bucket;

    await expect(
      writeImmutableJson(bucket, 'pending.json', { ok: true }, 250)
    ).rejects.toMatchObject({
      name: 'CompactArchiveTimeoutError',
      stage: 'put',
    });
    await expect(writeImmutableJson(bucket, 'pending.json', { ok: true }, 5)).rejects.toMatchObject(
      {
        name: 'CompactArchiveTimeoutError',
        stage: 'head_pending',
      }
    );
    expect(bucket.put).toHaveBeenCalledTimes(1);
    finishPut?.({} as R2Object);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      writeImmutableJson(bucket, 'pending.json', { ok: true }, 50)
    ).resolves.toBeUndefined();
    expect(bucket.put).toHaveBeenCalledTimes(1);
  });

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
    await expect(readCompactChunk(bucket, ref, chunk, 5)).rejects.toMatchObject({
      name: 'CompactArchiveTimeoutError',
      stage: 'get',
    });
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
    await expect(readCompactChunk(bucket, ref, chunk, 5)).rejects.toMatchObject({
      name: 'CompactArchiveTimeoutError',
      stage: 'decompress_read',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
