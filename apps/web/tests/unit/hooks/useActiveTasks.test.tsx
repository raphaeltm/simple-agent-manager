import type { DashboardTask } from '@simple-agent-manager/shared';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useActiveTasks } from '../../../src/hooks/useActiveTasks';

const mocks = vi.hoisted(() => ({
  listActiveTasks: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listActiveTasks: mocks.listActiveTasks,
}));

const TASK = {
  id: 'task-1',
  projectId: 'project-1',
  projectName: 'Acme',
  title: 'Fix the bug',
  status: 'in_progress',
  createdAt: '2026-08-18T10:00:00.000Z',
  updatedAt: '2026-08-18T10:05:00.000Z',
} as unknown as DashboardTask;

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, Wrapper };
}

describe('useActiveTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listActiveTasks.mockResolvedValue({ tasks: [TASK] });
  });

  afterEach(() => {
    // Leave the shared focus manager in its default state for other suites.
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it('deduplicates concurrent consumers of the same task list', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(
      () => ({
        header: useActiveTasks({ queryScope: 'user-1', pollInterval: 0 }),
        page: useActiveTasks({ queryScope: 'user-1', pollInterval: 0 }),
      }),
      { wrapper: Wrapper }
    );

    await waitFor(() => {
      expect(result.current.header.tasks).toEqual([TASK]);
      expect(result.current.page.tasks).toEqual([TASK]);
    });
    expect(mocks.listActiveTasks).toHaveBeenCalledTimes(1);
  });

  it('reuses fresh cached data when a consumer remounts', async () => {
    const { Wrapper } = createWrapper();
    const first = renderHook(() => useActiveTasks({ queryScope: 'user-1', pollInterval: 0 }), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(first.result.current.tasks).toEqual([TASK]));
    first.unmount();

    const second = renderHook(() => useActiveTasks({ queryScope: 'user-1', pollInterval: 0 }), {
      wrapper: Wrapper,
    });

    expect(second.result.current.tasks).toEqual([TASK]);
    expect(second.result.current.loading).toBe(false);
    expect(mocks.listActiveTasks).toHaveBeenCalledTimes(1);
  });

  it('keeps cached tasks visible during a background refresh', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useActiveTasks({ queryScope: 'user-1', pollInterval: 0 }), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.tasks).toEqual([TASK]));

    let resolveRefresh: ((value: { tasks: DashboardTask[] }) => void) | undefined;
    mocks.listActiveTasks.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );

    act(() => {
      result.current.refresh();
    });

    // The load is in flight — the previously rendered rows must still be there.
    await waitFor(() => expect(result.current.isRefreshing).toBe(true));
    expect(result.current.tasks).toEqual([TASK]);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      resolveRefresh?.({ tasks: [{ ...TASK, title: 'Updated title' }] });
    });
    await waitFor(() => expect(result.current.tasks[0]?.title).toBe('Updated title'));
  });

  it('keeps cached tasks visible and suppresses the error when a background refresh fails', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useActiveTasks({ queryScope: 'user-1', pollInterval: 0 }), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.tasks).toEqual([TASK]));

    mocks.listActiveTasks.mockRejectedValueOnce(new Error('Background refresh failed'));
    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
    expect(result.current.tasks).toEqual([TASK]);
    expect(result.current.error).toBeNull();
  });

  it('surfaces the error when the initial load fails with nothing cached', async () => {
    const { Wrapper } = createWrapper();
    mocks.listActiveTasks.mockRejectedValueOnce(new Error('boom'));

    const { result } = renderHook(() => useActiveTasks({ queryScope: 'user-1', pollInterval: 0 }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.tasks).toEqual([]);
  });

  it('isolates identical requests by authenticated query scope', async () => {
    const { client, Wrapper } = createWrapper();
    mocks.listActiveTasks
      .mockResolvedValueOnce({ tasks: [{ ...TASK, title: 'User one task' }] })
      .mockResolvedValueOnce({ tasks: [{ ...TASK, title: 'User two task' }] });

    const { result } = renderHook(
      () => ({
        userOne: useActiveTasks({ queryScope: 'user-1', pollInterval: 0 }),
        userTwo: useActiveTasks({ queryScope: 'user-2', pollInterval: 0 }),
      }),
      { wrapper: Wrapper }
    );

    await waitFor(() => {
      expect(result.current.userOne.tasks[0]?.title).toBe('User one task');
      expect(result.current.userTwo.tasks[0]?.title).toBe('User two task');
    });
    expect(client.getQueryData(['auth', 'user-1', 'tasks', 'active'])).toBeDefined();
    expect(client.getQueryData(['auth', 'user-2', 'tasks', 'active'])).toBeDefined();
  });

  it('issues no request at all while the query scope is empty (signed out)', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useActiveTasks({ queryScope: '', pollInterval: 0 }), {
      wrapper: Wrapper,
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.listActiveTasks).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.tasks).toEqual([]);
  });

  /**
   * Rule 60 ("Polling Hygiene") requires background polls to stop on a hidden tab.
   *
   * TanStack gives this for free: `QueryObserver#updateRefetchInterval` only fetches
   * when `refetchIntervalInBackground || focusManager.isFocused()`, and the default
   * focus manager reads `document.visibilityState`. This test pins that behaviour so
   * a future `refetchIntervalInBackground: true` cannot silently reintroduce
   * hidden-tab polling — verified discriminating by setting that flag, which makes
   * the "hidden" assertion below fail.
   */
  it('stops polling while the tab is hidden and resumes when it becomes visible', async () => {
    // Real timers with a short cadence rather than fake timers: `waitFor` schedules on
    // real timers internally, so `vi.useFakeTimers()` deadlocks it.
    const POLL_MS = 40;
    const HIDDEN_WINDOW_MS = POLL_MS * 8;
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useActiveTasks({ queryScope: 'user-1', pollInterval: POLL_MS }),
      { wrapper: Wrapper }
    );
    await waitFor(() => expect(result.current.tasks).toEqual([TASK]));

    // Tab goes to the background.
    act(() => {
      focusManager.setFocused(false);
    });
    const callsWhenHidden = mocks.listActiveTasks.mock.calls.length;

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, HIDDEN_WINDOW_MS));
    });

    // Eight intervals elapsed with the tab hidden — not one request may have fired.
    // This is the discriminating assertion: setting `refetchIntervalInBackground: true`
    // on the query makes it fail.
    expect(mocks.listActiveTasks.mock.calls.length).toBe(callsWhenHidden);

    // Tab comes back — polling resumes.
    act(() => {
      focusManager.setFocused(true);
    });
    await waitFor(() =>
      expect(mocks.listActiveTasks.mock.calls.length).toBeGreaterThan(callsWhenHidden)
    );
  });
});
