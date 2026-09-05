import { createHash } from 'node:crypto';

const encoder = new TextEncoder();

/** Separator `canonicalizeArchiveRows` joins rows with; the streaming hasher must emit the same byte. */
const ARCHIVE_ROW_SEPARATOR = '\u001d';

export function compareArchiveStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortJson(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort(compareArchiveStrings)) {
      sorted[key] = sortJson(record[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalizeArchiveValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return `string:${value.length}:${value}`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number cannot be archived');
    return `number:${Object.is(value, -0) ? '0' : String(value)}`;
  }
  if (typeof value === 'bigint') return `bigint:${value.toString()}`;
  if (typeof value === 'boolean') return `boolean:${value ? '1' : '0'}`;
  return `json:${JSON.stringify(sortJson(value))}`;
}

export function canonicalizeArchiveRow(
  columns: readonly string[],
  row: Record<string, unknown>
): string {
  return columns
    .map((column) => `${column}\u001f${canonicalizeArchiveValue(row[column] ?? null)}`)
    .join('\u001e');
}

export function canonicalizeArchiveRows(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[]
): string {
  return rows.map((row) => canonicalizeArchiveRow(columns, row)).join(ARCHIVE_ROW_SEPARATOR);
}

export function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function canonicalRowsSha256(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[]
): Promise<string> {
  return sha256Hex(canonicalizeArchiveRows(columns, rows));
}

export type CanonicalRowsHasher = {
  /** Feed one row. Rows must arrive in the table's total `orderBy` order. */
  update(row: Record<string, unknown>): void;
  /** Rows fed so far. */
  readonly rowCount: number;
  /** Finalize. The hasher cannot be reused afterwards. */
  digestHex(): string;
};

/**
 * Incremental equivalent of `canonicalRowsSha256`.
 *
 * Produces the byte-identical SHA-256 of `canonicalizeArchiveRows(columns, rows)` while
 * holding only one canonical row in memory at a time. `canonicalRowsSha256` encodes the
 * joined string with `TextEncoder` (UTF-8); `Hash.update(string, 'utf8')` encodes the
 * same code points the same way, so feeding each row plus the join separator yields the
 * same digest. Terminal-version proofs recorded by the one-shot definition therefore stay
 * valid for sessions hashed page by page (see `computeTerminalVersion`).
 */
export function createCanonicalRowsHasher(columns: readonly string[]): CanonicalRowsHasher {
  const hash = createHash('sha256');
  let rowCount = 0;
  return {
    get rowCount() {
      return rowCount;
    },
    update(row) {
      if (rowCount > 0) hash.update(ARCHIVE_ROW_SEPARATOR, 'utf8');
      hash.update(canonicalizeArchiveRow(columns, row), 'utf8');
      rowCount++;
    },
    digestHex() {
      return hash.digest('hex');
    },
  };
}
