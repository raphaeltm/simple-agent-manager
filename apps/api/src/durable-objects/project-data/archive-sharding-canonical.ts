/** Canonical per-column serialization for terminal archive chunks. */

export const ARCHIVE_TABLE_COLUMNS = {
  chat_messages: [
    'id',
    'session_id',
    'role',
    'content',
    'tool_metadata',
    'created_at',
    'sequence',
    'origin',
  ],
  chat_messages_grouped: ['id', 'session_id', 'role', 'content', 'created_at'],
  tool_payload_archives: [
    'message_id',
    'session_id',
    'r2_key',
    'content_bytes',
    'tool_metadata_bytes',
    'archived_at',
    'message_created_at',
    'message_sequence',
    'archive_version',
  ],
} as const;

export type ArchiveTableName = keyof typeof ARCHIVE_TABLE_COLUMNS;

function rowKey(table: ArchiveTableName, row: Record<string, unknown>): string {
  const key = table === 'tool_payload_archives' ? row.message_id : row.id;
  if (typeof key !== 'string' || !key) throw new Error(`Archive ${table} row is missing its key`);
  return key;
}

function canonicalValue(value: unknown, table: ArchiveTableName, column: string): unknown {
  if (value === undefined) throw new Error(`Archive ${table} row is missing column ${column}`);
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`Archive ${table}.${column} contains a non-finite number`);
  }
  if (
    value !== null &&
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  ) {
    throw new Error(`Archive ${table}.${column} has an unsupported value type`);
  }
  return value;
}

export function canonicalArchiveRows(
  table: ArchiveTableName,
  inputRows: ReadonlyArray<Record<string, unknown>>
): string {
  const columns = ARCHIVE_TABLE_COLUMNS[table];
  const rows = [...inputRows]
    .sort((a, b) => rowKey(table, a).localeCompare(rowKey(table, b)))
    .map((row) => {
      const canonical: Record<string, unknown> = {};
      for (const column of columns) {
        canonical[column] = canonicalValue(row[column], table, column);
      }
      return canonical;
    });
  return JSON.stringify({ table, columns, rows });
}

export function archiveCanonicalBytes(
  table: ArchiveTableName,
  rows: ReadonlyArray<Record<string, unknown>>
): Uint8Array {
  return new TextEncoder().encode(canonicalArchiveRows(table, rows));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

export function canonicalAggregateManifest(
  chunks: ReadonlyArray<{
    table: ArchiveTableName;
    chunkIndex: number;
    rowCount: number;
    canonicalBytes: number;
    hash: string;
  }>
): string {
  return JSON.stringify(
    [...chunks].sort((a, b) => a.table.localeCompare(b.table) || a.chunkIndex - b.chunkIndex)
  );
}

export async function canonicalArchiveHash(
  table: ArchiveTableName,
  rows: ReadonlyArray<Record<string, unknown>>
): Promise<string> {
  return sha256Hex(archiveCanonicalBytes(table, rows));
}

export async function canonicalAggregateHash(
  chunks: Parameters<typeof canonicalAggregateManifest>[0]
): Promise<string> {
  return sha256Hex(canonicalAggregateManifest(chunks));
}

/**
 * Seed and extension for the v2 receipt hash chain. Chaining one canonical
 * receipt at a time makes the aggregate independent of R2 manifest page size.
 */
export const ARCHIVE_AGGREGATE_CHAIN_SEED = '0'.repeat(64);

export async function extendCanonicalAggregateHash(
  previousHash: string,
  chunks: Parameters<typeof canonicalAggregateManifest>[0]
): Promise<string> {
  let hash = previousHash;
  for (const chunk of chunks) {
    hash = await sha256Hex(
      JSON.stringify({
        version: 2,
        previousHash: hash,
        chunk: {
          table: chunk.table,
          chunkIndex: chunk.chunkIndex,
          rowCount: chunk.rowCount,
          canonicalBytes: chunk.canonicalBytes,
          hash: chunk.hash,
        },
      })
    );
  }
  return hash;
}
