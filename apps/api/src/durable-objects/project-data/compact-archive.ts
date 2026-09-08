import { COMPACT_ARCHIVE_FORMAT, compactArchiveTimeout, type CompactChunkRef,readCompactChunk } from '../../project-data-archive/compact-r2';
import { PROJECT_DATA_ARCHIVE_MESSAGE_COLUMNS, type ProjectDataArchiveChunk, type ProjectDataArchiveRow } from '../../project-data-archive/contract';
import { canonicalRowsSha256, createCanonicalRowsHasher } from '../../project-data-archive/hashing';
import { estimateRowBytes, RPC_SIZE_BUDGET_BYTES } from './messages';
import type { Env } from './types';

export function isCompactArchive(sql: SqlStorage, sessionId: string): boolean {
  return sql.exec('SELECT storage_format FROM project_data_archive_target_sessions WHERE session_id = ?', sessionId)
    .toArray()[0]?.storage_format === COMPACT_ARCHIVE_FORMAT;
}

function bucket(env: Env): R2Bucket {
  if (!env.PROJECT_DATA_ARCHIVE_R2) throw new Error('Compact archive R2 binding is unavailable');
  return env.PROJECT_DATA_ARCHIVE_R2;
}

export async function commitCompactRawChunk(
  sql: SqlStorage, env: Env, input: ProjectDataArchiveChunk, ref: CompactChunkRef
): Promise<void> {
  const stored = await readCompactChunk(bucket(env), ref, input, compactArchiveTimeout(env.PROJECT_DATA_ARCHIVE_R2_TIMEOUT_MS));
  if (stored.sha256 !== input.sha256 || stored.rowCount !== input.rowCount ||
      await canonicalRowsSha256(PROJECT_DATA_ARCHIVE_MESSAGE_COLUMNS, stored.rows) !== input.sha256) {
    throw new Error('Compact archive source hash mismatch');
  }
  const counts: Record<string, number> = Object.create(null);
  for (const row of stored.rows) {
    const role = String(row.role);
    counts[role] = (counts[role] ?? 0) + 1;
  }
  const prior = sql.exec('SELECT body_sha256 FROM project_data_archive_raw_chunks WHERE session_id = ? AND ordinal = ?', input.sessionId, input.ordinal).toArray()[0];
  if (prior) {
    if (prior.body_sha256 !== ref.bodySha256) throw new Error('Compact archive reference conflict');
    return;
  }
  sql.exec(`INSERT INTO project_data_archive_raw_chunks
    (session_id, ordinal, r2_key, compressed_bytes, body_bytes, body_sha256,
     first_created_at, last_created_at, role_counts_json, row_ids_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.sessionId, input.ordinal, ref.key, ref.bytes, ref.bodyBytes, ref.bodySha256,
    stored.rows[0]?.created_at ?? null, stored.rows.at(-1)?.created_at ?? null,
    JSON.stringify(counts), JSON.stringify(stored.rowIds));
}

export function compactMessageCount(sql: SqlStorage, sessionId: string, roles?: string[]): number {
  let query = `SELECT COALESCE(SUM(j.value), 0) AS count FROM project_data_archive_raw_chunks c,
    json_each(c.role_counts_json) j WHERE c.session_id = ?`;
  const params: Array<string | number> = [sessionId];
  if (roles?.length) { query += ` AND j.key IN (${roles.map(() => '?').join(',')})`; params.push(...roles); }
  return Number(sql.exec(query, ...params).toArray()[0]?.count ?? 0);
}

function reference(row: Record<string, unknown>): CompactChunkRef {
  return { key: String(row.r2_key), bytes: Number(row.compressed_bytes),
    bodyBytes: Number(row.body_bytes), bodySha256: String(row.body_sha256) };
}

export async function* compactRawChunks(
  sql: SqlStorage, env: Env, sessionId: string,
  filter: { before?: number | null; after?: number | null; roles?: string[]; messageId?: string; order?: 'asc' | 'desc' } = {}
): AsyncGenerator<ProjectDataArchiveChunk> {
  const target = sql.exec('SELECT * FROM project_data_archive_target_sessions WHERE session_id = ?', sessionId).toArray()[0];
  if (!target) throw new Error('Compact archive target missing');
  const descending = filter.order === 'desc';
  let cursor: number | null = null;
  for (;;) {
    let query = 'SELECT * FROM project_data_archive_raw_chunks WHERE session_id = ?';
    const params: Array<string | number> = [sessionId];
    if (cursor !== null) { query += descending ? ' AND ordinal < ?' : ' AND ordinal > ?'; params.push(cursor); }
    if (filter.before != null) { query += ' AND first_created_at < ?'; params.push(filter.before); }
    if (filter.after != null) { query += ' AND last_created_at > ?'; params.push(filter.after); }
    if (filter.roles?.length) {
      query += ` AND EXISTS (SELECT 1 FROM json_each(role_counts_json) WHERE key IN (${filter.roles.map(() => '?').join(',')}))`;
      params.push(...filter.roles);
    }
    if (filter.messageId) { query += ' AND EXISTS (SELECT 1 FROM json_each(row_ids_json) WHERE value = ?)'; params.push(filter.messageId); }
    // One metadata row and one R2 body at a time; no session-sized object inventory.
    query += descending ? ' ORDER BY ordinal DESC LIMIT 1' : ' ORDER BY ordinal ASC LIMIT 1';
    const row = sql.exec(query, ...params).toArray()[0];
    if (!row) return;
    cursor = Number(row.ordinal);
    const chunk = await readCompactChunk(bucket(env), reference(row), {
      projectId: String(target.project_id), sessionId, migrationId: String(target.migration_id),
      targetOwnerName: String(target.owner_name), targetGeneration: Number(target.generation), ordinal: cursor,
    }, compactArchiveTimeout(env.PROJECT_DATA_ARCHIVE_R2_TIMEOUT_MS));
    if (await canonicalRowsSha256(PROJECT_DATA_ARCHIVE_MESSAGE_COLUMNS, chunk.rows) !== chunk.sha256) {
      throw new Error('Compact archive canonical row hash mismatch');
    }
    yield chunk;
  }
}

export async function compactRawDigest(sql: SqlStorage, env: Env, sessionId: string) {
  const hasher = createCanonicalRowsHasher(PROJECT_DATA_ARCHIVE_MESSAGE_COLUMNS);
  let lastMessageAt: number | null = null;
  let ordinal = 0;
  for await (const chunk of compactRawChunks(sql, env, sessionId)) {
    if (chunk.ordinal !== ordinal++) throw new Error('Compact archive chunk inventory gap');
    for (const row of chunk.rows) { hasher.update(row); lastMessageAt = Number(row.created_at); }
  }
  return { sha256: hasher.digestHex(), messageCount: hasher.rowCount, lastMessageAt };
}

export async function compactRawPage(
  sql: SqlStorage, env: Env, sessionId: string, limit: number,
  before: number | null, after: number | null, roles: string[] | undefined, order: 'asc' | 'desc'
): Promise<ProjectDataArchiveRow[]> {
  const result: ProjectDataArchiveRow[] = [];
  let bytes = 0;
  for await (const chunk of compactRawChunks(sql, env, sessionId, { before, after, roles, order })) {
    const rows = order === 'desc' ? [...chunk.rows].reverse() : chunk.rows;
    for (const row of rows) {
      const timestamp = Number(row.created_at);
      if (before !== null && timestamp >= before || after !== null && timestamp <= after ||
          roles?.length && !roles.includes(String(row.role))) continue;
      result.push(row);
      bytes += estimateRowBytes(row);
      if (bytes > RPC_SIZE_BUDGET_BYTES) return result;
      if (result.length >= limit) return result;
    }
  }
  return result;
}

export async function compactExportCandidates(
  sql: SqlStorage, env: Env, sessionId: string, limit: number,
  cursor: { createdAt: number; sequence: number; id: string } | null
): Promise<ProjectDataArchiveRow[]> {
  const rows: ProjectDataArchiveRow[] = [];
  let bytes = 0;
  for await (const chunk of compactRawChunks(sql, env, sessionId, { after: cursor ? cursor.createdAt - 1 : null })) {
    for (const row of chunk.rows) {
      if (cursor && (Number(row.created_at) < cursor.createdAt ||
        Number(row.created_at) === cursor.createdAt && (Number(row.sequence) < cursor.sequence ||
          Number(row.sequence) === cursor.sequence && String(row.id) <= cursor.id))) continue;
      rows.push(row);
      bytes += estimateRowBytes(row);
      if (rows.length >= limit || bytes > RPC_SIZE_BUDGET_BYTES) return rows;
    }
  }
  return rows;
}

export async function compactRawMessage(sql: SqlStorage, env: Env, sessionId: string, messageId: string) {
  for await (const chunk of compactRawChunks(sql, env, sessionId, { messageId })) {
    const row = chunk.rows.find(candidate => candidate.id === messageId);
    if (row) return row;
  }
  return null;
}
