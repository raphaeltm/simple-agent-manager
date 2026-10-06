import type { ProjectSummary } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectList } from '../../../src/hooks/useProjectData';

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listProjects: mocks.listProjects,
}));

const PROJECT = {
  id: 'project-1',
  name: 'Cached project',
  repository: 'acme/cached-project',
  githubRepoId: 101,
  defaultBranch: 'main',
  repoProvider: 'github',
  status: 'active',
  activeWorkspaceCount: 1,
  activeSessionCount: 0,
  lastActivityAt: '2026-08-07T20:00:00.000Z',
  taskCountsByStatus: {},
  linkedWorkspaces: 1,
  createdAt: '2026-08-07T19:00:00.000Z',
} satisfies ProjectSummary;

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
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  return { client, Wrapper };
}

describe('useProjectList query cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listProjects.mockResolvedValue({ projects: [PROJECT] });
  });

  it('deduplicates concurrent consumers of the same project list', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(
      () => ({
        sidebar: useProjectList({ queryScope: 'user-1', limit: 50, pollInterval: 0 }),
        page: useProjectList({ queryScope: 'user-1', limit: 50, pollInterval: 0 }),
      }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(result.current.sidebar.projects).toEqual([PROJECT]);
      expect(result.current.page.projects).toEqual([PROJECT]);
    });
    expect(mocks.listProjects).toHaveBeenCalledTimes(1);
  });

  it('reuses fresh cached data when a consumer remounts', async () => {
    const { Wrapper } = createWrapper();
    const first = renderHook(
      () => useProjectList({ queryScope: 'user-1', limit: 50, pollInterval: 0 }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(first.result.current.projects).toEqual([PROJECT]));
    first.unmount();

    const second = renderHook(
      () => useProjectList({ queryScope: 'user-1', limit: 50, pollInterval: 0 }),
      { wrapper: Wrapper },
    );

    expect(second.result.current.projects).toEqual([PROJECT]);
    expect(second.result.current.loading).toBe(false);
    expect(mocks.listProjects).toHaveBeenCalledTimes(1);
  });

  it('keeps cached projects visible during a background refresh', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(
      () => useProjectList({ queryScope: 'user-1', limit: 50, pollInterval: 0 }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.projects).toEqual([PROJECT]));

    let resolveRefresh: ((value: { projects: ProjectSummary[] }) => void) | undefined;
    mocks.listProjects.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.isRefreshing).toBe(true));
    expect(result.current.projects).toEqual([PROJECT]);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      resolveRefresh?.({ projects: [{ ...PROJECT, name: 'Updated project' }] });
    });

    await waitFor(() => expect(result.current.projects[0]?.name).toBe('Updated project'));
  });

  it('keeps cached projects visible and suppresses page errors when background refresh fails', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(
      () => useProjectList({ queryScope: 'user-1', limit: 50, pollInterval: 0 }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.projects).toEqual([PROJECT]));

    mocks.listProjects.mockRejectedValueOnce(new Error('Background refresh failed'));
    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
    expect(result.current.projects).toEqual([PROJECT]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('isolates identical list parameters by authenticated query scope', async () => {
    const { client, Wrapper } = createWrapper();
    mocks.listProjects
      .mockResolvedValueOnce({ projects: [{ ...PROJECT, name: 'User one project' }] })
      .mockResolvedValueOnce({ projects: [{ ...PROJECT, name: 'User two project' }] });

    const { result } = renderHook(
      () => ({
        userOne: useProjectList({ queryScope: 'user-1', limit: 50, pollInterval: 0 }),
        userTwo: useProjectList({ queryScope: 'user-2', limit: 50, pollInterval: 0 }),
      }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(result.current.userOne.projects[0]?.name).toBe('User one project');
      expect(result.current.userTwo.projects[0]?.name).toBe('User two project');
    });
    expect(client.getQueryData(['auth', 'user-1', 'projects', 'list', { limit: 50 }])).toBeDefined();
    expect(client.getQueryData(['auth', 'user-2', 'projects', 'list', { limit: 50 }])).toBeDefined();
  });
});
