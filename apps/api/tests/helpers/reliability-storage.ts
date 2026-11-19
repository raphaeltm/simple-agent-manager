import { expect, vi } from 'vitest';

/** Unpublished primary activation fixture; live storage behavior has Worker coverage. */
export function createUnpublishedStorageSession() {
  return vi.fn((constraint: string) => {
    expect(constraint).toBe('first-primary');
    return {
      prepare: (sql: string) => {
        expect(sql).toBe('SELECT value FROM platform_settings WHERE key = ?');
        return {
          bind: (key: string) => {
            expect(key).toBe('reliability.storage.activation.v1');
            return { first: () => Promise.resolve(null) };
          },
        };
      },
    };
  });
}
