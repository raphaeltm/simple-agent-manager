import type { ListFilesResponse } from '@simple-agent-manager/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileWithTags } from '../../../src/components/library/types';

const { listLibraryFiles } = vi.hoisted(() => ({ listLibraryFiles: vi.fn() }));
const cache = vi.hoisted(() => ({
  getCachedIndex: vi.fn(),
  setCachedIndex: vi.fn(),
  clearCachedIndex: vi.fn(),
}));

vi.mock('../../../src/lib/api/library', () => ({ listLibraryFiles }));
vi.mock('../../../src/lib/library-cache', () => ({
  getCachedIndex: cache.getCachedIndex,
  setCachedIndex: cache.setCachedIndex,
  clearCachedIndex: cache.clearCachedIndex,
}));

import { useLibraryIndex } from '../../../src/hooks/useLibraryIndex';

function makeFile(overrides: Partial<FileWithTags> = {}): FileWithTags {
  return {
    id: overrides.id ?? 'f1',
    projectId: 'proj-1',
    filename: overrides.filename ?? 'a.txt',
    directory: overrides.directory ?? '/',
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
    extractedTextPreview: overrides.extractedTextPreview ?? 'preview text',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    tags: [],
    ...overrides,
  };
}

function page(files: FileWithTags[], cursor: string | null, total: number): ListFilesResponse {
  return { files, cursor, total } as ListFilesResponse;
}

describe('useLibraryIndex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cache.getCachedIndex.mockReturnValue(null);
    cache.setCachedIndex.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sweeps multiple pages with sortOrder=asc until cursor===null', async () => {
    listLibraryFiles
      .mockResolvedValueOnce(page([makeFile({ id: 'a' })], 'a', 2))
      .mockResolvedValueOnce(page([makeFile({ id: 'b' })], null, 2));

    const { result } = renderHook(() => useLibraryIndex('proj-1'));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.files.map((f) => f.id)).toEqual(['a', 'b']);

    // Every sweep call must request ascending order
    for (const call of listLibraryFiles.mock.calls) {
      expect(call[1]).toMatchObject({ sortOrder: 'asc', sortBy: 'createdAt' });
    }
    // Second page passed the first page's cursor
    expect(listLibraryFiles.mock.calls[1]![1]).toMatchObject({ cursor: 'a' });
  });

  it('strips extractedTextPreview before caching', async () => {
    listLibraryFiles.mockResolvedValueOnce(page([makeFile({ id: 'a' })], null, 1));

    const { result } = renderHook(() => useLibraryIndex('proj-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(cache.setCachedIndex).toHaveBeenCalledTimes(1);
    const cached = cache.setCachedIndex.mock.calls[0]![1] as FileWithTags[];
    expect(cached[0]!.extractedTextPreview).toBeNull();
  });

  it('falls back to overCap when total >= cap and clears the cache', async () => {
    listLibraryFiles.mockResolvedValueOnce(page([], null, 9999));

    const { result } = renderHook(() => useLibraryIndex('proj-1'));
    await waitFor(() => expect(result.current.status).toBe('overCap'));

    expect(result.current.files).toEqual([]);
    expect(result.current.fileCount).toBe(9999);
    expect(cache.clearCachedIndex).toHaveBeenCalledWith('proj-1');
    expect(cache.setCachedIndex).not.toHaveBeenCalled();
  });

  it('hydrates from cache for flicker-free first paint', async () => {
    cache.getCachedIndex.mockReturnValue({
      files: [makeFile({ id: 'cached', extractedTextPreview: null })],
      count: 1,
      sweptAt: Date.now(),
    });
    listLibraryFiles.mockResolvedValueOnce(page([makeFile({ id: 'fresh' })], null, 1));

    const { result } = renderHook(() => useLibraryIndex('proj-1'));

    // Immediately ready from cache (no loading flash)
    expect(result.current.status).toBe('ready');
    expect(result.current.files[0]!.id).toBe('cached');

    // Then the re-sweep replaces it
    await waitFor(() => expect(result.current.files[0]!.id).toBe('fresh'));
  });

  it('keeps prior files and reports sweepError on a failed page', async () => {
    cache.getCachedIndex.mockReturnValue({
      files: [makeFile({ id: 'cached', extractedTextPreview: null })],
      count: 1,
      sweptAt: Date.now(),
    });
    listLibraryFiles.mockRejectedValueOnce(new Error('network'));

    const { result } = renderHook(() => useLibraryIndex('proj-1'));

    await waitFor(() => expect(result.current.sweepError).toBe(true));
    expect(result.current.status).toBe('ready');
    expect(result.current.files[0]!.id).toBe('cached');
  });

  it('re-sweeps when invalidate() is called', async () => {
    listLibraryFiles.mockResolvedValue(page([makeFile({ id: 'a' })], null, 1));

    const { result } = renderHook(() => useLibraryIndex('proj-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const before = listLibraryFiles.mock.calls.length;

    act(() => result.current.invalidate());
    await waitFor(() => expect(listLibraryFiles.mock.calls.length).toBeGreaterThan(before));
  });

  it('generation guard discards a stale in-flight sweep when invalidate() supersedes it', async () => {
    // Two deferred sweeps: A is in-flight when invalidate() starts B.
    function deferred() {
      let resolve!: (v: ListFilesResponse) => void;
      const promise = new Promise<ListFilesResponse>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }
    const sweepA = deferred();
    const sweepB = deferred();
    listLibraryFiles.mockReturnValueOnce(sweepA.promise).mockReturnValueOnce(sweepB.promise);

    const { result } = renderHook(() => useLibraryIndex('proj-1'));
    expect(result.current.status).toBe('loading');

    // Supersede sweep A before it resolves — bumps the generation, starts sweep B.
    act(() => result.current.invalidate());
    await waitFor(() => expect(listLibraryFiles.mock.calls.length).toBe(2));

    // Resolve the STALE sweep first, then the current one.
    await act(async () => {
      sweepA.resolve(page([makeFile({ id: 'stale' })], null, 1));
      sweepB.resolve(page([makeFile({ id: 'fresh' })], null, 1));
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    // Stale sweep A's result must be discarded; only sweep B's files survive.
    expect(result.current.files.map((f) => f.id)).toEqual(['fresh']);
    // And the stale result must never have been cached.
    for (const call of cache.setCachedIndex.mock.calls) {
      const cached = call[1] as FileWithTags[];
      expect(cached.map((f) => f.id)).not.toContain('stale');
    }
  });
});
