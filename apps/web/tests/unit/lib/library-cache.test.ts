import type { ListFilesResponse } from '@simple-agent-manager/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearLibraryCache,
  getCachedDirectories,
  getCachedFiles,
  setCachedDirectories,
  setCachedFiles,
} from '../../../src/lib/library-cache';

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
});
