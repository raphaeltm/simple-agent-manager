/**
 * Covers the state that moved out of `SessionHeader` when the action row became the
 * tool rail: strip-mode persistence, the report-issue gate, action dispatch, and the
 * mark-complete flow (dialog → mutation → error), which used to live in the header.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatSessionResponse } from '../../../src/lib/api';

const mocks = vi.hoisted(() => ({
  updateProjectTaskStatus: vi.fn(),
  deleteWorkspace: vi.fn(),
  getReportIssueConfig: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  updateProjectTaskStatus: mocks.updateProjectTaskStatus,
  deleteWorkspace: mocks.deleteWorkspace,
  getReportIssueConfig: mocks.getReportIssueConfig,
}));

import { TOOL_STRIP_MODE_STORAGE_KEY } from '../../../src/components/project-message-view/session-tool-actions';
import {
  useSessionTools,
  type UseSessionToolsInput,
} from '../../../src/components/project-message-view/useSessionTools';

function makeSession(overrides: Partial<ChatSessionResponse> = {}): ChatSessionResponse {
  return {
    id: 'sess-1',
    workspaceId: 'ws-1',
    taskId: 'task-1',
    topic: 'Test session',
    status: 'active',
    messageCount: 3,
    startedAt: Date.now() - 1000,
    endedAt: null,
    createdAt: Date.now() - 1000,
    task: { id: 'task-1', status: 'in_progress' },
    ...overrides,
  } as ChatSessionResponse;
}

function inputFor(overrides: Partial<UseSessionToolsInput> = {}): UseSessionToolsInput {
  const session = overrides.session ?? makeSession();
  return {
    projectId: 'proj-1',
    session,
    sessionState: 'active',
    taskEmbed: session?.task ?? null,
    unresolvedCommentCount: 0,
    onSessionMutated: vi.fn(),
    onOpenFiles: vi.fn(),
    onOpenGit: vi.fn(),
    onOpenTimeline: vi.fn(),
    onOpenComments: vi.fn(),
    onRetry: vi.fn(),
    onFork: vi.fn(),
    ...overrides,
  };
}

describe('useSessionTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.updateProjectTaskStatus.mockResolvedValue({});
    mocks.getReportIssueConfig.mockResolvedValue({ enabled: false });
  });

  describe('strip mode', () => {
    it('defaults to icons, never hidden', () => {
      const { result } = renderHook(() => useSessionTools(inputFor()));
      // Defaulting to hidden would recreate the discoverability problem the rail exists
      // to solve, so this default is load-bearing.
      expect(result.current.mode).toBe('icons');
    });

    it('applies every mode the rail can ask for', () => {
      // The rail owns the cycle order (it computes `nextToolStripMode` itself and calls
      // `onModeChange`), so what the hook must guarantee is that it faithfully applies
      // whichever mode it is handed. The cycle ORDER is pinned on `nextToolStripMode`
      // directly, and the button that walks it is covered by the Playwright audit.
      const { result } = renderHook(() => useSessionTools(inputFor()));

      for (const mode of ['labels', 'hidden', 'icons'] as const) {
        act(() => result.current.setMode(mode));
        expect(result.current.mode).toBe(mode);
      }
    });

    it('persists the chosen mode and restores it on remount', () => {
      const { result, unmount } = renderHook(() => useSessionTools(inputFor()));
      act(() => result.current.setMode('labels'));
      expect(window.localStorage.getItem(TOOL_STRIP_MODE_STORAGE_KEY)).toBe('labels');
      unmount();

      const remounted = renderHook(() => useSessionTools(inputFor()));
      expect(remounted.result.current.mode).toBe('labels');
    });

    it('falls back to the default when the stored value is not a mode', () => {
      window.localStorage.setItem(TOOL_STRIP_MODE_STORAGE_KEY, 'enormous');
      const { result } = renderHook(() => useSessionTools(inputFor()));
      expect(result.current.mode).toBe('icons');
    });
  });

  describe('action dispatch', () => {
    it('routes each id to its handler', () => {
      const input = inputFor();
      const { result } = renderHook(() => useSessionTools(input));

      act(() => result.current.selectTool('files'));
      act(() => result.current.selectTool('git'));
      act(() => result.current.selectTool('timeline'));
      act(() => result.current.selectTool('comments'));
      act(() => result.current.selectTool('retry'));
      act(() => result.current.selectTool('fork'));

      expect(input.onOpenFiles).toHaveBeenCalledTimes(1);
      expect(input.onOpenGit).toHaveBeenCalledTimes(1);
      expect(input.onOpenTimeline).toHaveBeenCalledTimes(1);
      expect(input.onOpenComments).toHaveBeenCalledTimes(1);
      expect(input.onRetry).toHaveBeenCalledTimes(1);
      expect(input.onFork).toHaveBeenCalledTimes(1);
    });

    it('toggles the details panel', () => {
      const { result } = renderHook(() => useSessionTools(inputFor()));
      expect(result.current.detailsExpanded).toBe(false);
      act(() => result.current.selectTool('details'));
      expect(result.current.detailsExpanded).toBe(true);
      act(() => result.current.selectTool('details'));
      expect(result.current.detailsExpanded).toBe(false);
    });

    it('opens the report dialog', () => {
      const { result } = renderHook(() => useSessionTools(inputFor()));
      act(() => result.current.selectTool('report'));
      expect(result.current.reportOpen).toBe(true);
      act(() => result.current.closeReport());
      expect(result.current.reportOpen).toBe(false);
    });

    it('does not invoke a handler for the workspace link', () => {
      const input = inputFor();
      const { result } = renderHook(() => useSessionTools(input));
      act(() => result.current.selectTool('workspace'));
      // Rendered as an anchor — navigation is the browser's job, not a handler call.
      expect(input.onOpenFiles).not.toHaveBeenCalled();
      expect(input.onOpenGit).not.toHaveBeenCalled();
    });
  });

  describe('report gating', () => {
    it('omits Report until the config says it is enabled', async () => {
      mocks.getReportIssueConfig.mockResolvedValue({ enabled: true });
      const { result } = renderHook(() => useSessionTools(inputFor()));

      expect(result.current.actions.find((a) => a.id === 'report')).toBeUndefined();
      await waitFor(() => {
        expect(result.current.actions.find((a) => a.id === 'report')).toBeDefined();
      });
    });

    it('omits Report when the config request fails', async () => {
      mocks.getReportIssueConfig.mockRejectedValue(new Error('nope'));
      const { result } = renderHook(() => useSessionTools(inputFor()));
      await waitFor(() => expect(mocks.getReportIssueConfig).toHaveBeenCalled());
      expect(result.current.actions.find((a) => a.id === 'report')).toBeUndefined();
      // Liveness: the rest of the action set survived the failed config fetch.
      expect(result.current.actions.find((a) => a.id === 'details')).toBeDefined();
    });
  });

  describe('mark complete', () => {
    it('opens the confirmation dialog rather than completing immediately', () => {
      const { result } = renderHook(() => useSessionTools(inputFor()));
      act(() => result.current.selectTool('complete'));
      expect(result.current.confirmCompleteOpen).toBe(true);
      expect(mocks.updateProjectTaskStatus).not.toHaveBeenCalled();
    });

    it('completes without deleting the resumable workspace snapshot', async () => {
      const { result } = renderHook(() => useSessionTools(inputFor()));
      act(() => result.current.selectTool('complete'));
      await act(async () => {
        await result.current.confirmComplete();
      });

      expect(mocks.updateProjectTaskStatus).toHaveBeenCalledWith('proj-1', 'task-1', {
        toStatus: 'completed',
      });
      expect(mocks.deleteWorkspace).not.toHaveBeenCalled();
      expect(result.current.confirmCompleteOpen).toBe(false);
    });

    it('notifies the owner after a successful completion', async () => {
      const input = inputFor();
      const { result } = renderHook(() => useSessionTools(input));
      await act(async () => {
        await result.current.confirmComplete();
      });
      expect(input.onSessionMutated).toHaveBeenCalled();
    });

    it('surfaces and dismisses a completion failure', async () => {
      mocks.updateProjectTaskStatus.mockRejectedValue(new Error('API error'));
      const { result } = renderHook(() => useSessionTools(inputFor()));

      await act(async () => {
        await result.current.confirmComplete();
      });
      expect(result.current.completeError).toBe('API error');

      act(() => result.current.dismissCompleteError());
      expect(result.current.completeError).toBeNull();
    });

    it('is a no-op when the session has no task', async () => {
      const session = makeSession({ task: undefined, taskId: null });
      const { result } = renderHook(() => useSessionTools(inputFor({ session, taskEmbed: null })));
      await act(async () => {
        await result.current.confirmComplete();
      });
      expect(mocks.updateProjectTaskStatus).not.toHaveBeenCalled();
      expect(result.current.actions.find((a) => a.id === 'complete')).toBeUndefined();
    });
  });

  it('returns no actions before the session has loaded', () => {
    const { result } = renderHook(() =>
      useSessionTools(inputFor({ session: null, taskEmbed: null }))
    );
    expect(result.current.actions).toEqual([]);
  });

  it('keeps the action array stable while unrelated state churns', () => {
    // Rebuilding this array on every render defeats its purpose: `ProjectChat` re-renders
    // on the session-sync poll and the provisioning poll, so an unstable array means
    // `buildSessionToolActions` re-runs on every tick (rule 64).
    //
    // Re-rendering with the SAME input object would be tautological — it proves the hook
    // is stable given stable inputs, not that it survives a real render loop. So this
    // rebuilds the input each render (as a parent component does) and changes a value
    // the actions do not depend on.
    let tick = 0;
    // Stable REFERENCES, as production supplies them: `session`/`taskEmbed` come from
    // `useSessionLifecycle` state and the handlers are `useCallback`-wrapped in
    // `ProjectChat`. What is fresh each render is the input OBJECT itself.
    const stableSession = makeSession();
    const stableTaskEmbed = stableSession.task ?? null;
    const stableHandlers = {
      onSessionMutated: vi.fn(),
      onOpenFiles: vi.fn(),
      onOpenGit: vi.fn(),
      onOpenTimeline: vi.fn(),
      onOpenComments: vi.fn(),
      onRetry: vi.fn(),
      onFork: vi.fn(),
    };
    const { result, rerender } = renderHook(() => {
      tick += 1;
      return useSessionTools({
        projectId: 'proj-1',
        session: stableSession,
        sessionState: 'active',
        taskEmbed: stableTaskEmbed,
        unresolvedCommentCount: 0,
        ...stableHandlers,
      });
    });

    const first = result.current.actions;
    rerender();
    rerender();
    expect(tick).toBeGreaterThan(1);
    expect(result.current.actions).toBe(first);
  });

  it('rebuilds the action array when something it depends on changes', () => {
    // The control for the stability test above: if `actions` were frozen rather than
    // memoized, that test would pass for the wrong reason.
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) =>
        useSessionTools(inputFor({ unresolvedCommentCount: count })),
      { initialProps: { count: 0 } }
    );

    const first = result.current.actions;
    rerender({ count: 3 });
    expect(result.current.actions).not.toBe(first);
    expect(result.current.actions.find((a) => a.id === 'comments')?.badge).toBe(3);
  });
});
