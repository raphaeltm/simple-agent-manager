import type { ProjectSummary } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listProjects: mocks.listProjects,
}));

import { useProjectList } from '../../../src/hooks/useProjectData';

// Regression coverage for the ListProjectsResponse type fix: useProjectList
// used to force `result.projects as unknown as ProjectSummary[]` to bridge a
// `ListProjectsResponse.projects: Project[]` type that never matched the real
// payload. Now that the shared type says `ProjectSummary[]`, the hook assigns
// `result.projects` directly. These tests prove that direct assignment still
// delivers real ProjectSummary-shaped data end to end (not just "compiles").

function makeProjectSummary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'proj-1',
    name: 'Project One',
    repository: 'acme/repo-one',
    githubRepoId: 42,
    defaultBranch: 'main',
    repoProvider: 'github',
    status: 'active',
    activeWorkspaceCount: 2,
    activeSessionCount: 1,
    lastActivityAt: '2026-08-01T00:00:00.000Z',
    createdAt: '2026-07-01T00:00:00.000Z',
    taskCountsByStatus: { in_progress: 1 },
    linkedWorkspaces: 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 60_000,
      },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }

  return Wrapper;
}

describe('useProjectList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows first-load loading before any data resolves', () => {
    mocks.listProjects.mockReturnValue(deferred().promise);

    const { result } = renderHook(() => useProjectList({ queryScope: 'user-1', pollInterval: 0 }), {
      wrapper: createWrapper(),
    });

    expect(result.current.projects).toEqual([]);
    expect(result.current.loading).toBe(true);
    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('assigns ListProjectsResponse.projects directly as ProjectSummary[] (no cast/transform)', async () => {
    const summary = makeProjectSummary();
    mocks.listProjects.mockResolvedValue({ projects: [summary], nextCursor: null });

    const { result } = renderHook(() => useProjectList({ queryScope: 'user-1', pollInterval: 0 }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Same array reference and same object reference — proves the hook does
    // a plain assignment, not a copy/cast, so ProjectSummary-only fields
    // (activeWorkspaceCount, taskCountsByStatus, linkedWorkspaces) survive
    // untouched all the way to the caller.
    expect(result.current.projects).toHaveLength(1);
    expect(result.current.projects[0]).toBe(summary);
    expect(result.current.projects[0]).toMatchObject({
      id: 'proj-1',
      activeWorkspaceCount: 2,
      taskCountsByStatus: { in_progress: 1 },
      linkedWorkspaces: 0,
    });
    expect(result.current.error).toBeNull();
  });

  it('loads an empty successful response as an explicit empty state', async () => {
    mocks.listProjects.mockResolvedValue({ projects: [], nextCursor: null });

    const { result } = renderHook(() => useProjectList({ queryScope: 'user-1', pollInterval: 0 }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.projects).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('keeps existing projects visible while a refresh is in flight', async () => {
    const oldSummary = makeProjectSummary({ id: 'proj-old', name: 'Old Project' });
    const newSummary = makeProjectSummary({ id: 'proj-new', name: 'New Project' });
    const refresh = deferred<{ projects: ProjectSummary[]; nextCursor: string | null }>();
    mocks.listProjects
      .mockResolvedValueOnce({ projects: [oldSummary], nextCursor: null })
      .mockReturnValueOnce(refresh.promise);

    const { result } = renderHook(() => useProjectList({ queryScope: 'user-1', pollInterval: 0 }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.projects).toMatchObject([{ id: 'proj-old' }]);

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.isRefreshing).toBe(true));
    expect(result.current.loading).toBe(false);
    expect(result.current.projects).toMatchObject([{ id: 'proj-old' }]);

    await act(async () => {
      refresh.resolve({ projects: [newSummary], nextCursor: null });
      await refresh.promise;
    });

    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
    expect(result.current.projects).toMatchObject([{ id: 'proj-new' }]);
  });

  it('suppresses refresh failure errors without blanking stale data', async () => {
    const oldSummary = makeProjectSummary();
    const refresh = deferred<{ projects: ProjectSummary[]; nextCursor: string | null }>();
    mocks.listProjects
      .mockResolvedValueOnce({ projects: [oldSummary], nextCursor: null })
      .mockReturnValueOnce(refresh.promise);

    const { result } = renderHook(() => useProjectList({ queryScope: 'user-1', pollInterval: 0 }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.isRefreshing).toBe(true));

    await act(async () => {
      refresh.reject(new Error('network failed'));
      await refresh.promise.catch(() => undefined);
    });

    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.projects).toMatchObject([{ id: 'proj-1' }]);
  });

  it('surfaces first-load failure with no projects', async () => {
    mocks.listProjects.mockRejectedValue(new Error('network failed'));

    const { result } = renderHook(() => useProjectList({ queryScope: 'user-1', pollInterval: 0 }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('network failed');
    expect(result.current.projects).toEqual([]);
  });
});
