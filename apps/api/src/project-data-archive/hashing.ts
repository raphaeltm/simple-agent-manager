const encoder = new TextEncoder();

function sortJson(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
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
  return rows.map((row) => canonicalizeArchiveRow(columns, row)).join('\u001d');
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
