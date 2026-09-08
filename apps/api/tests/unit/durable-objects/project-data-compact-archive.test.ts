import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import {
  readCompactChunk,
  writeCompactChunk,
} from '../../../src/project-data-archive/compact-r2';
import type { ProjectDataArchiveChunk } from '../../../src/project-data-archive/contract';
import { canonicalRowsSha256 } from '../../../src/project-data-archive/hashing';
import { createSqlStorage } from './sql-storage-test-utils';

const columns = ['id', 'session_id', 'role', 'content', 'tool_metadata', 'created_at', 'sequence', 'origin'];

function memoryR2() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    bucket: {
      put: vi.fn(async (key: string, value: Uint8Array) => {
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

async function fixture(): Promise<ProjectDataArchiveChunk> {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    id: `message-${i}`, session_id: 'session', role: i === 0 ? 'user' : 'assistant',
    content: `Unicode \u00e9\u{1f642} ${'repeat '.repeat(100)}`, tool_metadata: null,
    created_at: 1000 + i, sequence: i, origin: null,
  }));
  return {
    projectId: 'project', sessionId: 'session', migrationId: 'migration',
    sourceOwnerName: 'project', targetOwnerName: 'project:archive:g1:s0', targetGeneration: 1,
    tableName: 'chat_messages', ordinal: 0, rows, rowIds: rows.map(row => row.id),
    rowCount: rows.length, byteCount: 40_000, sha256: await canonicalRowsSha256(columns, rows),
    cursor: 'cursor', hasMore: false,
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
    expect(bucket.put).toHaveBeenCalledTimes(1);
  });

  it('adds compact storage metadata to an existing database without rewriting messages', () => {
    const db = new Database(':memory:');
    try {
      const sql = createSqlStorage(db);
      runMigrations(sql);
      expect(sql.exec('SELECT storage_format FROM project_data_archive_target_sessions LIMIT 0').toArray()).toEqual([]);
      expect(sql.exec('SELECT r2_key FROM project_data_archive_raw_chunks LIMIT 0').toArray()).toEqual([]);
      runMigrations(sql);
    } finally { db.close(); }
  });
});

describe('compact archive migration compatibility', () => {
  it('preserves exact paging, tool expansion, search, counts and recovery export without raw target rows', async () => {
    const archive = await import('../../../src/durable-objects/project-data/archive-sharding');
    const { getMessages } = await import('../../../src/durable-objects/project-data/messages');
    const { PROJECT_DATA_ARCHIVE_TABLES } = await import('../../../src/project-data-archive/contract');
    const sourceDb = new Database(':memory:');
    const targetDb = new Database(':memory:');
    const source = createSqlStorage(sourceDb);
    const target = createSqlStorage(targetDb);
    const { bucket, objects } = memoryR2();
    const env = { PROJECT_DATA_ARCHIVE_R2: bucket };
    try {
      runMigrations(source); runMigrations(target);
      source.exec(`INSERT INTO chat_sessions (id, status, message_count, started_at, ended_at,
        created_at, updated_at, agent_completed_at, materialized_at)
        VALUES ('session', 'stopped', 40, 1000, 1500, 1000, 1500, 1500, 1500)`);
      const original = await fixture();
      original.rows[10]!.role = 'tool';
      original.rows[10]!.tool_metadata = JSON.stringify({ content: [{ type: 'text', text: 'complete tool payload' }] });
      for (const row of original.rows) source.exec(`INSERT INTO chat_messages
        (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...columns.map(c => row[c]));
      source.exec(`INSERT INTO chat_messages_grouped (id, session_id, role, content, created_at)
        VALUES ('group', 'session', 'assistant', 'searchable complete consolidated answer', 1100)`);
      const base = { projectId: 'project', sessionId: 'session', migrationId: 'migration',
        sourceOwnerName: 'project', targetOwnerName: 'project:archive:g1:s0', targetGeneration: 1,
        sourceIntentToken: 'intent', now: 2_000_000, minTerminalAgeMs: 0 };
      const prepared = await archive.prepareArchiveSourceIntentOrRefuse(source, base);
      if ('refused' in prepared) throw new Error(JSON.stringify(prepared));
      if (!('terminalVersionSha256' in prepared)) throw new Error('Unexpected source refusal');
      const prepareTarget = { ...base, terminalVersionSha256: prepared.terminalVersionSha256,
        sessionRow: prepared.sessionRow, expectedMessageCount: prepared.messageCount };
      archive.prepareArchiveTarget(target, { ...prepareTarget, storageFormat: 'r2-gzip-v1' });
      // A flag change/retry cannot turn an already compact target into SQLite storage.
      archive.prepareArchiveTarget(target, { ...prepareTarget, storageFormat: 'sqlite-v1' });
      const hashes: string[] = [];
      for (const tableName of PROJECT_DATA_ARCHIVE_TABLES) {
        let cursor: string | null = null;
        let ordinal = 0;
        do {
          const chunk = await archive.exportArchiveChunk(source, { ...base, tableName, ordinal, cursor, maxRows: 7, maxBytes: 100_000 });
          const rawChunkRef = tableName === 'chat_messages' ? await writeCompactChunk(bucket, 'archive', chunk) : undefined;
          await archive.commitArchiveTargetChunk(target, { ...chunk, rawChunkRef, now: base.now }, env);
          expect((await archive.commitArchiveTargetChunk(target, { ...chunk, rawChunkRef, now: base.now }, env)).idempotent).toBe(true);
          hashes.push(chunk.sha256);
          cursor = chunk.hasMore ? chunk.cursor : null;
          ordinal++;
        } while (cursor);
      }
      const sealInput = { ...base, terminalVersionSha256: prepared.terminalVersionSha256, expectedChunkHashes: hashes };
      const sealed = await archive.sealArchiveTarget(target, sealInput, env);
      expect(sealed.messageCount).toBe(40);
      expect(await archive.sealArchiveTarget(target, sealInput, env)).toEqual(sealed);
      expect(target.exec('SELECT COUNT(*) AS count FROM chat_messages').toArray()[0]?.count).toBe(0);
      const owner = { ...base, ownerName: base.targetOwnerName, generation: 1 };
      expect(archive.archiveTargetReadMessageCount(target, owner)).toBe(40);
      expect(archive.archiveTargetReadMessageCount(target, owner, ['tool'])).toBe(1);
      for (const order of ['asc', 'desc'] as const) for (const compact of [false, true]) {
        for (const roles of [undefined, ['assistant'], ['tool']]) {
          expect(await archive.archiveTargetReadMessages(target, env, owner, 9, 1035, 1002, roles, compact, order))
            .toEqual(getMessages(source, 'session', 9, 1035, 1002, roles, compact, order));
        }
      }
      expect(await archive.archiveTargetReadMessageToolContent(target, env, { ...owner, messageId: 'message-10' }))
        .toEqual({ content: [{ type: 'text', text: 'complete tool payload' }], source: 'inline' });
      expect(archive.archiveTargetSearchMessages(target, owner, 'consolidated', null, 10).length).toBe(1);
      const recovered: unknown[] = [];
      let cursor: string | null = null;
      let ordinal = 0;
      do {
        const chunk = await archive.exportArchiveTargetChunk(target, { ...base, tableName: 'chat_messages', ordinal,
          cursor, maxRows: 11, maxBytes: 100_000 }, env);
        recovered.push(...chunk.rows);
        cursor = chunk.hasMore ? chunk.cursor : null;
        ordinal++;
      } while (cursor);
      expect(recovered).toEqual(original.rows);
      await expect(archive.archiveTargetReadMessages(target, env, { ...owner, projectId: 'other' }, 9, null, null, undefined, false, 'asc')).rejects.toThrow();
      objects.clear();
      await expect(archive.archiveTargetReadMessages(target, env, owner, 9, null, null, undefined, false, 'asc')).rejects.toThrow();
      expect(source.exec('SELECT COUNT(*) AS count FROM chat_messages').toArray()[0]?.count).toBe(40);
    } finally { sourceDb.close(); targetDb.close(); }
  });
});
