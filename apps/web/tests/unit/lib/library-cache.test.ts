import type { ListFilesResponse } from '@simple-agent-manager/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CachedIndexFile } from '../../../src/lib/library-cache';
import {
  clearCachedIndex,
  clearLibraryCache,
  getCachedDirectories,
  getCachedFiles,
  getCachedIndex,
  setCachedDirectories,
  setCachedFiles,
  setCachedIndex,
} from '../../../src/lib/library-cache';

function makeIndexFile(id: string): CachedIndexFile {
  return {
    id,
    projectId: 'proj-1',
    filename: `${id}.txt`,
    directory: '/',
    mimeType: 'text/plain',
    sizeBytes: 1,
    description: null,
    uploadedBy: 'user-1',
    uploadSource: 'user',
    uploadSessionId: null,
    uploadTaskId: null,
    replacedAt: null,
    replacedBy: null,
    status: 'ready',
    extractedTextPreview: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    tags: [],
  };
}

describe('library-cache', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves file cache entries', () => {
    const data: ListFilesResponse = {
      files: [{ id: 'f1', filename: 'test.txt' }] as ListFilesResponse['files'],
      cursor: null,
      total: 1,
    };

    setCachedFiles('proj-1', '/', 'createdAt', data);
    const result = getCachedFiles('proj-1', '/', 'createdAt');

    expect(result).toEqual(data);
  });

  it('stores and retrieves directory cache entries', () => {
    const dirs = [{ path: '/docs/', name: 'docs', fileCount: 3 }];

    setCachedDirectories('proj-1', '/', dirs);
    const result = getCachedDirectories('proj-1', '/');

    expect(result).toEqual(dirs);
  });

  it('returns null for missing entries', () => {
    expect(getCachedFiles('proj-1', '/', 'createdAt')).toBeNull();
    expect(getCachedDirectories('proj-1', '/')).toBeNull();
  });

  it('returns null for expired entries (past TTL)', () => {
    const data: ListFilesResponse = {
      files: [],
      cursor: null,
      total: 0,
    };

    setCachedFiles('proj-1', '/', 'createdAt', data);

    // Advance time past 5 minute TTL
    vi.advanceTimersByTime(6 * 60 * 1000);

    expect(getCachedFiles('proj-1', '/', 'createdAt')).toBeNull();
  });

  it('does not expire entries within TTL', () => {
    const data: ListFilesResponse = {
      files: [],
      cursor: null,
      total: 0,
    };

    setCachedFiles('proj-1', '/', 'createdAt', data);

    // Advance to just under 5 minutes
    vi.advanceTimersByTime(4 * 60 * 1000);

    expect(getCachedFiles('proj-1', '/', 'createdAt')).toEqual(data);
  });

  it('uses different cache keys per project', () => {
    const data1: ListFilesResponse = { files: [], cursor: null, total: 0 };
    const data2: ListFilesResponse = { files: [], cursor: null, total: 1 };

    setCachedFiles('proj-1', '/', 'createdAt', data1);
    setCachedFiles('proj-2', '/', 'createdAt', data2);

    expect(getCachedFiles('proj-1', '/', 'createdAt')).toEqual(data1);
    expect(getCachedFiles('proj-2', '/', 'createdAt')).toEqual(data2);
  });

  it('uses different cache keys per directory', () => {
    const data1: ListFilesResponse = { files: [], cursor: null, total: 0 };
    const data2: ListFilesResponse = { files: [], cursor: null, total: 1 };

    setCachedFiles('proj-1', '/', 'createdAt', data1);
    setCachedFiles('proj-1', '/docs/', 'createdAt', data2);

    expect(getCachedFiles('proj-1', '/', 'createdAt')).toEqual(data1);
    expect(getCachedFiles('proj-1', '/docs/', 'createdAt')).toEqual(data2);
  });

  it('clearLibraryCache removes all sam-library entries', () => {
    setCachedFiles('proj-1', '/', 'createdAt', { files: [], cursor: null, total: 0 });
    setCachedDirectories('proj-1', '/', []);

    // Add a non-library item
    localStorage.setItem('other-key', 'should remain');

    clearLibraryCache();

    // Library entries gone
    expect(getCachedFiles('proj-1', '/', 'createdAt')).toBeNull();
    expect(getCachedDirectories('proj-1', '/')).toBeNull();

    // Other entries untouched
    expect(localStorage.getItem('other-key')).toBe('should remain');
  });

  it('handles corrupted cache entries gracefully', () => {
    localStorage.setItem('sam-library:proj-1:files:/:createdAt', 'not-json');
    expect(getCachedFiles('proj-1', '/', 'createdAt')).toBeNull();
  });

  describe('global index', () => {
    it('stores and retrieves the swept index with a count', () => {
      const files = [makeIndexFile('a'), makeIndexFile('b')];
      expect(setCachedIndex('proj-1', files)).toBe(true);

      const result = getCachedIndex('proj-1');
      expect(result?.count).toBe(2);
      expect(result?.files.map((f) => f.id)).toEqual(['a', 'b']);
    });

    it('uses a distinct key from per-directory file caches', () => {
      setCachedFiles('proj-1', '/', 'createdAt', { files: [], cursor: null, total: 0 });
      setCachedIndex('proj-1', [makeIndexFile('a')]);

      // The per-directory cache and the global index do not collide
      expect(getCachedFiles('proj-1', '/', 'createdAt')).toEqual({
        files: [],
        cursor: null,
        total: 0,
      });
      expect(getCachedIndex('proj-1')?.count).toBe(1);
    });

    it('returns null for a missing index', () => {
      expect(getCachedIndex('proj-1')).toBeNull();
    });

    it('expires the index past TTL', () => {
      setCachedIndex('proj-1', [makeIndexFile('a')]);
      vi.advanceTimersByTime(6 * 60 * 1000);
      expect(getCachedIndex('proj-1')).toBeNull();
    });

    it('clearCachedIndex removes only the index', () => {
      setCachedIndex('proj-1', [makeIndexFile('a')]);
      setCachedFiles('proj-1', '/', 'createdAt', { files: [], cursor: null, total: 0 });

      clearCachedIndex('proj-1');

      expect(getCachedIndex('proj-1')).toBeNull();
      expect(getCachedFiles('proj-1', '/', 'createdAt')).not.toBeNull();
    });

    it('handles a corrupted index entry gracefully', () => {
      localStorage.setItem('sam-library:proj-1:global-index', 'not-json');
      expect(getCachedIndex('proj-1')).toBeNull();
    });

    it('clearLibraryCache removes the global index too', () => {
      setCachedIndex('proj-1', [makeIndexFile('a')]);
      clearLibraryCache();
      expect(getCachedIndex('proj-1')).toBeNull();
    });
  });

  describe('localStorage quota safety', () => {
    it('skips the write (no throw, no eviction) when the value exceeds the size guard', () => {
      // Default INDEX_MAX_CACHE_CHARS is ~2M chars; build a payload above it.
      const huge = Array.from({ length: 8000 }, (_, i) => {
        const f = makeIndexFile(`f${i}`);
        f.description = 'x'.repeat(400);
        return f;
      });

      const removeSpy = vi.spyOn(Storage.prototype, 'removeItem');
      const ok = setCachedIndex('proj-1', huge);

      expect(ok).toBe(false);
      expect(getCachedIndex('proj-1')).toBeNull();
      // Oversized values are skipped outright — no eviction churn.
      expect(removeSpy).not.toHaveBeenCalled();
      removeSpy.mockRestore();
    });

    it('evicts the oldest sam-library entry and retries once on a quota error', () => {
      // Seed an older library entry that becomes the eviction victim.
      vi.setSystemTime(new Date('2026-04-24T11:00:00Z'));
      setCachedFiles('proj-1', '/old/', 'createdAt', { files: [], cursor: null, total: 0 });
      vi.setSystemTime(new Date('2026-04-24T12:00:00Z'));

      const realSetItem = Storage.prototype.setItem;
      let firstWrite = true;
      const setSpy = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(function (this: Storage, key: string, value: string) {
          // Fail only the FIRST index write to trigger one eviction + retry.
          if (firstWrite && key.endsWith(':global-index')) {
            firstWrite = false;
            throw new DOMException('quota', 'QuotaExceededError');
          }
          return realSetItem.call(this, key, value);
        } as typeof Storage.prototype.setItem);

      const ok = setCachedIndex('proj-1', [makeIndexFile('a')]);

      expect(ok).toBe(true);
      // The older per-directory entry was evicted to make room.
      expect(getCachedDirectories('proj-1', '/old/')).toBeNull();
      // The retry succeeded and the index persisted.
      expect(getCachedIndex('proj-1')?.count).toBe(1);
      setSpy.mockRestore();
    });

    it('gives up after MAX_EVICTIONS persistent quota failures without throwing or looping', () => {
      // Seed several library entries so eviction always finds a victim.
      vi.setSystemTime(new Date('2026-04-24T11:00:00Z'));
      for (let i = 0; i < 10; i++) {
        setCachedFiles('proj-1', `/d${i}/`, 'createdAt', { files: [], cursor: null, total: 0 });
      }
      vi.setSystemTime(new Date('2026-04-24T12:00:00Z'));

      const realSetItem = Storage.prototype.setItem;
      const setSpy = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(function (this: Storage, key: string, value: string) {
          // Persistent quota failure for the index write — every attempt throws.
          if (key.endsWith(':global-index')) {
            throw new DOMException('quota', 'QuotaExceededError');
          }
          return realSetItem.call(this, key, value);
        } as typeof Storage.prototype.setItem);

      // Must return false (not throw, not loop forever).
      const ok = setCachedIndex('proj-1', [makeIndexFile('a')]);

      expect(ok).toBe(false);
      // Bounded by MAX_EVICTIONS (5) + 1 initial attempt = 6 index-write attempts.
      const indexWrites = setSpy.mock.calls.filter(([k]) => String(k).endsWith(':global-index'));
      expect(indexWrites.length).toBe(6);
      setSpy.mockRestore();
    });
  });
});
