import { LIBRARY_DEFAULTS, type ListFilesResponse } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLibraryIndex } from '../../../src/hooks/useLibraryIndex';
import {
  type LibraryIndexFile,
  type LibraryIndexQueryData,
  libraryQueryKeys,
} from '../../../src/lib/query-options/library';

vi.mock('../../../src/lib/api/library', () => ({
  listLibraryFiles: vi.fn(),
}));

vi.mock('../../../src/hooks/useQueryScope', () => ({
  useQueryScope: () => 'user-1',
}));

import { listLibraryFiles } from '../../../src/lib/api/library';

const mockListLibraryFiles = vi.mocked(listLibraryFiles);

const DEFAULT_INDEX_CONFIG = {
  cap: LIBRARY_DEFAULTS.CLIENT_SWEEP_CAP,
  maxSweepPages: LIBRARY_DEFAULTS.CLIENT_MAX_SWEEP_PAGES,
  namespace: null,
} as const;

function createWrapper(client = createQueryClient()) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: Infinity,
        retry: false,
        staleTime: 0,
      },
    },
  });
}

function makeFile(id: string, overrides: Partial<LibraryIndexFile> = {}): LibraryIndexFile {
  return {
    id,
    projectId: 'proj-1',
    filename: `${id}.md`,
    directory: '/',
    mimeType: 'text/markdown',
    sizeBytes: 123,
    description: null,
    uploadedBy: 'user-1',
    uploadSource: 'user',
    uploadSessionId: null,
    uploadTaskId: null,
    replacedAt: null,
    replacedBy: null,
    status: 'ready',
    extractedTextPreview: 'preview text that must not be cached',
    createdAt: `2026-08-20T00:00:0${id.length}.000Z`,
    updatedAt: `2026-08-20T00:00:0${id.length}.000Z`,
    tags: [],
    ...overrides,
  };
}

function page(
  files: LibraryIndexFile[],
  cursor: string | null,
  total = files.length
): ListFilesResponse {
  return { files, cursor, total };
}

function seedIndexData(client: QueryClient, data: LibraryIndexQueryData) {
  client.setQueryData(libraryQueryKeys.index('user-1', 'proj-1', DEFAULT_INDEX_CONFIG), data);
}

describe('useLibraryIndex', () => {
  beforeEach(() => {
    mockListLibraryFiles.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sweeps all pages using recursive ascending createdAt pagination', async () => {
    const firstFile = makeFile('a');
    const secondFile = makeFile('b');
    mockListLibraryFiles
      .mockResolvedValueOnce(page([firstFile], 'cursor-1', 2))
      .mockResolvedValueOnce(page([secondFile], null, 2));

    const { result } = renderHook(() => useLibraryIndex('proj-1'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.files.map((file) => file.id)).toEqual(['a', 'b']);
    expect(mockListLibraryFiles).toHaveBeenNthCalledWith(1, 'proj-1', {
      directory: '/',
      recursive: true,
      sortBy: 'createdAt',
      sortOrder: 'asc',
      limit: LIBRARY_DEFAULTS.LIST_MAX_PAGE_SIZE,
      cursor: undefined,
    });
    expect(mockListLibraryFiles).toHaveBeenNthCalledWith(2, 'proj-1', {
      directory: '/',
      recursive: true,
      sortBy: 'createdAt',
      sortOrder: 'asc',
      limit: LIBRARY_DEFAULTS.LIST_MAX_PAGE_SIZE,
      cursor: 'cursor-1',
    });
  });

  it('strips extracted text previews before exposing and caching swept files', async () => {
    const client = createQueryClient();
    mockListLibraryFiles.mockResolvedValueOnce(page([makeFile('a')], null, 1));

    const { result } = renderHook(() => useLibraryIndex('proj-1'), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.files[0]?.extractedTextPreview).toBeNull();
    const cached = client.getQueryData<LibraryIndexQueryData>(
      libraryQueryKeys.index('user-1', 'proj-1', DEFAULT_INDEX_CONFIG)
    );
    expect(cached?.files[0]?.extractedTextPreview).toBeNull();
  });

  it('reports overCap without storing files when the server total reaches the client cap', async () => {
    mockListLibraryFiles.mockResolvedValueOnce(
      page([makeFile('too-many')], null, LIBRARY_DEFAULTS.CLIENT_SWEEP_CAP)
    );

    const { result } = renderHook(() => useLibraryIndex('proj-1'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.status).toBe('overCap'));

    expect(result.current.files).toEqual([]);
    expect(result.current.fileCount).toBe(LIBRARY_DEFAULTS.CLIENT_SWEEP_CAP);
  });

  it('hydrates immediately from Query cache and stale-revalidates in the background', async () => {
    const client = createQueryClient();
    const cachedFile = makeFile('cached', { extractedTextPreview: null });
    seedIndexData(client, { files: [cachedFile], fileCount: 1, status: 'ready' });
    mockListLibraryFiles.mockResolvedValueOnce(page([makeFile('fresh')], null, 1));

    const { result } = renderHook(() => useLibraryIndex('proj-1'), {
      wrapper: createWrapper(client),
    });

    expect(result.current.status).toBe('ready');
    expect(result.current.files.map((file) => file.id)).toEqual(['cached']);

    await waitFor(() => expect(result.current.files.map((file) => file.id)).toEqual(['fresh']));
    expect(mockListLibraryFiles).toHaveBeenCalledTimes(1);
  });

  it('keeps cached data and reports sweepError when a background re-sweep fails', async () => {
    const client = createQueryClient();
    const cachedFile = makeFile('cached', { extractedTextPreview: null });
    seedIndexData(client, { files: [cachedFile], fileCount: 1, status: 'ready' });
    mockListLibraryFiles.mockRejectedValueOnce(new Error('network down'));

    const { result } = renderHook(() => useLibraryIndex('proj-1'), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => expect(result.current.sweepError).toBe(true));

    expect(result.current.status).toBe('ready');
    expect(result.current.files.map((file) => file.id)).toEqual(['cached']);
  });

  it('reports error when the initial sweep fails without cached data', async () => {
    mockListLibraryFiles.mockRejectedValueOnce(new Error('network down'));

    const { result } = renderHook(() => useLibraryIndex('proj-1'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.status).toBe('error'));

    expect(result.current.files).toEqual([]);
    expect(result.current.sweepError).toBe(true);
  });

  it('stops sweeping at the configured page cap when the cursor never ends', async () => {
    mockListLibraryFiles.mockImplementation(async (_projectId, filters) =>
      page([makeFile(String(filters?.cursor ?? 'first'))], 'next-cursor', 1)
    );

    const { result } = renderHook(() => useLibraryIndex('proj-1'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(mockListLibraryFiles).toHaveBeenCalledTimes(LIBRARY_DEFAULTS.CLIENT_MAX_SWEEP_PAGES);
    expect(result.current.files).toHaveLength(LIBRARY_DEFAULTS.CLIENT_MAX_SWEEP_PAGES);
  });

  it('invalidates the exact project index query and re-sweeps', async () => {
    mockListLibraryFiles
      .mockResolvedValueOnce(page([makeFile('a')], null, 1))
      .mockResolvedValueOnce(page([makeFile('b')], null, 1));

    const { result } = renderHook(() => useLibraryIndex('proj-1'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.files.map((file) => file.id)).toEqual(['a']));

    await act(async () => {
      result.current.invalidate();
    });

    await waitFor(() => expect(result.current.files.map((file) => file.id)).toEqual(['b']));
    expect(mockListLibraryFiles).toHaveBeenCalledTimes(2);
  });
});
