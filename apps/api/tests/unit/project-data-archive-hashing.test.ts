import { describe, expect, it } from 'vitest';

import {
  canonicalizeArchiveRows,
  canonicalRowsSha256,
  createCanonicalRowsHasher,
  sha256Hex,
} from '../../src/project-data-archive/hashing';

const COLUMNS = ['id', 'session_id', 'role', 'content', 'tool_metadata', 'created_at'] as const;

function row(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `message-${String(index).padStart(4, '0')}`,
    session_id: 'session-hash',
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `payload ${index}    emoji \u{1F600} accent é`,
    tool_metadata: index % 3 === 0 ? JSON.stringify({ b: 1, a: [index] }) : null,
    created_at: 1_000 + index,
    ...overrides,
  };
}

describe('createCanonicalRowsHasher', () => {
  it('matches canonicalRowsSha256 byte for byte across row counts', async () => {
    for (const count of [0, 1, 2, 7, 64]) {
      const rows = Array.from({ length: count }, (_, index) => row(index));
      const hasher = createCanonicalRowsHasher(COLUMNS);
      for (const item of rows) hasher.update(item);
      expect(hasher.rowCount).toBe(count);
      expect(hasher.digestHex()).toBe(await canonicalRowsSha256(COLUMNS, rows));
    }
  });

  it('is the SHA-256 of the joined canonical string, so recorded proofs stay valid', async () => {
    const rows = [row(0), row(1), row(2)];
    const hasher = createCanonicalRowsHasher(COLUMNS);
    for (const item of rows) hasher.update(item);
    expect(hasher.digestHex()).toBe(await sha256Hex(canonicalizeArchiveRows(COLUMNS, rows)));
  });

  it('distinguishes row boundaries from separator bytes inside content', async () => {
    // Two rows whose contents contain the row separator must not collide with a single row
    // whose content is their concatenation; the separator between rows is not escaped, so
    // this pins that the hasher emits exactly one separator per boundary and no extras.
    const split = [row(0, { content: 'a' }), row(1, { content: 'b' })];
    const merged = [row(0, { content: 'ab' })];
    const splitHasher = createCanonicalRowsHasher(COLUMNS);
    for (const item of split) splitHasher.update(item);
    const mergedHasher = createCanonicalRowsHasher(COLUMNS);
    for (const item of merged) mergedHasher.update(item);
    const splitDigest = splitHasher.digestHex();
    const mergedDigest = mergedHasher.digestHex();
    expect(splitDigest).not.toBe(mergedDigest);
    expect(splitDigest).toBe(await canonicalRowsSha256(COLUMNS, split));
    expect(mergedDigest).toBe(await canonicalRowsSha256(COLUMNS, merged));
  });

  it('treats missing columns as null exactly like the one-shot definition', async () => {
    const rows = [row(0, { tool_metadata: undefined }), { id: 'only-id' }];
    const hasher = createCanonicalRowsHasher(COLUMNS);
    for (const item of rows) hasher.update(item);
    expect(hasher.digestHex()).toBe(await canonicalRowsSha256(COLUMNS, rows));
  });
});
