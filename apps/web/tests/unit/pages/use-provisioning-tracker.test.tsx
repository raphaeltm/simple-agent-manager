/**
 * Behavioral tests for `useProvisioningTracker`, the hook that decides whether
 * the project chat page shows `ProvisioningIndicator` for a session.
 *
 * Every case enters through the real trigger (rule 62): a `sessionId`, a session
 * list, and the task the API returns for it. The fixtures reproduce the task
 * shapes the API writes on sleep (`services/session-sleep-teardown.ts`) and wake
 * (`services/session-recovery.ts`) after PR #2230, which is what the pre-fix
 * "not terminal and not in_progress" gate misread as first-boot provisioning.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatSessionListItem } from '../../../src/lib/api';
import type { ProvisioningState } from '../../../src/pages/project-chat/types';
import {
  PROVISIONING_RESTORE_RETRIES,
  TASK_STATUS_POLL_MS,
} from '../../../src/pages/project-chat/types';
import { useProvisioningTracker } from '../../../src/pages/project-chat/useProvisioningTracker';

const mocks = vi.hoisted(() => ({
  getProjectTask: vi.fn(),
  getWorkspace: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getProjectTask: mocks.getProjectTask,
  getWorkspace: mocks.getWorkspace,
}));

const BRANCH = 'sam/something-wacky-going-take-8645tk';

function makeSession(overrides: Partial<ChatSessionListItem> = {}): ChatSessionListItem {
  return {
    id: 'session-1',
    workspaceId: null,
    taskId: 'task-1',
    topic: 'Investigate inactive workspace on running node',
    status: 'active',
    messageCount: 2,
    startedAt: 1_700_000_000_000,
    endedAt: null,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    status: 'queued',
    executionStep: 'node_provisioning',
    errorMessage: null,
    outputBranch: BRANCH,
    // First boot: `started_at` is written only when the agent first starts
    // (task-runner/state-machine.ts transitionToInProgress).
    startedAt: null,
    workspaceId: null,
    ...overrides,
  };
}

const ORIGINAL_START = '2026-10-05T04:58:29.900Z';

/** What `session-sleep-teardown.ts` leaves on a slept VM conversation's task. */
const sleepingTask = () =>
  makeTask({ status: 'sleeping', executionStep: null, startedAt: ORIGINAL_START });
/** What `session-recovery.ts` writes to the same task once a wake is claimed. */
const wakingTask = () =>
  makeTask({ status: 'queued', executionStep: 'node_selection', startedAt: ORIGINAL_START });
/** The task once the runner has handed the session to a live agent. */
const runningTask = () =>
  makeTask({
    status: 'in_progress',
    executionStep: 'running',
    workspaceId: 'ws-1',
    startedAt: ORIGINAL_START,
  });

interface HarnessProps {
  sessionId: string | undefined;
  sessions: ChatSessionListItem[];
  initial?: ProvisioningState | null;
}

function renderTracker(props: HarnessProps) {
  const navigate = vi.fn();
  const loadSessions = vi.fn().mockResolvedValue(undefined);
  const view = renderHook(
    (p: HarnessProps) => {
      const [provisioning, setProvisioning] = useState<ProvisioningState | null>(p.initial ?? null);
      useProvisioningTracker({
        projectId: 'proj-1',
        sessionId: p.sessionId,
        sessions: p.sessions,
        provisioning,
        setProvisioning,
        navigate,
        loadSessions,
      });
      return provisioning;
    },
    { initialProps: props }
  );
  return { ...view, navigate, loadSessions };
}

/** Let pending effects and resolved mocks settle without asserting a change. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getWorkspace.mockRejectedValue(new Error('workspace not ready'));
});

describe('useProvisioningTracker — restore on navigation', () => {
  it('restores provisioning for an active session whose task is still queued (control)', async () => {
    mocks.getProjectTask.mockResolvedValue(makeTask());
    const { result } = renderTracker({ sessionId: 'session-1', sessions: [makeSession()] });

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toMatchObject({
      taskId: 'task-1',
      sessionId: 'session-1',
      status: 'queued',
      executionStep: 'node_provisioning',
      branchName: BRANCH,
    });
  });

  it('does not restore provisioning for an idle sleeping session', async () => {
    mocks.getProjectTask.mockResolvedValue(sleepingTask());
    const { result } = renderTracker({
      sessionId: 'session-1',
      sessions: [makeSession({ status: 'sleeping' })],
    });

    await settle();
    expect(result.current).toBeNull();
    // The sleep/wake UI owns a sleeping session; there is nothing to fetch.
    expect(mocks.getProjectTask).not.toHaveBeenCalled();
  });

  it('does not restore provisioning while a sleeping session is being woken', async () => {
    // Mid-wake the session is still `sleeping` and its own task is `queued`;
    // WakeProgressBanner renders that, ProvisioningIndicator must not.
    mocks.getProjectTask.mockResolvedValue(wakingTask());
    const { result } = renderTracker({
      sessionId: 'session-1',
      sessions: [makeSession({ status: 'sleeping' })],
    });

    await settle();
    expect(result.current).toBeNull();
  });

  it('treats a sleeping task as not provisioning even when the session list lags', async () => {
    // The sidebar can be stale relative to the task row; the task is the authority.
    mocks.getProjectTask.mockResolvedValue(sleepingTask());
    const { result } = renderTracker({ sessionId: 'session-1', sessions: [makeSession()] });

    await waitFor(() => expect(mocks.getProjectTask).toHaveBeenCalledTimes(1));
    await settle();
    expect(result.current).toBeNull();
  });

  it('treats a waking task as not provisioning even when the session list lags', async () => {
    // A dropped `session.updated` frame can leave the list entry `active` while
    // the wake has already re-queued the task. The task has started before
    // (startedAt set), so it is a wake, not a first boot.
    mocks.getProjectTask.mockResolvedValue(wakingTask());
    const { result } = renderTracker({ sessionId: 'session-1', sessions: [makeSession()] });

    await waitFor(() => expect(mocks.getProjectTask).toHaveBeenCalledTimes(1));
    await settle();
    expect(result.current).toBeNull();
  });

  it('retries a transient task fetch failure and restores once it succeeds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.getProjectTask
        .mockRejectedValueOnce(new Error('502 Bad Gateway'))
        .mockResolvedValue(makeTask());
      const { result } = renderTracker({ sessionId: 'session-1', sessions: [makeSession()] });

      await waitFor(() => expect(mocks.getProjectTask).toHaveBeenCalledTimes(1));
      await settle();
      expect(result.current).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(TASK_STATUS_POLL_MS);
      });
      await waitFor(() => expect(result.current?.status).toBe('queued'));
      // 1 failed restore + 1 successful retry + the poll's immediate first tick
      // once provisioning is set.
      expect(mocks.getProjectTask).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the bounded number of retries', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.getProjectTask.mockRejectedValue(new Error('offline'));
      const { result } = renderTracker({ sessionId: 'session-1', sessions: [makeSession()] });

      await waitFor(() => expect(mocks.getProjectTask).toHaveBeenCalledTimes(1));
      for (let i = 0; i < PROVISIONING_RESTORE_RETRIES + 2; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(TASK_STATUS_POLL_MS);
        });
      }
      expect(mocks.getProjectTask).toHaveBeenCalledTimes(1 + PROVISIONING_RESTORE_RETRIES);
      expect(result.current).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not restore provisioning once the agent is running', async () => {
    mocks.getProjectTask.mockResolvedValue(runningTask());
    const { result } = renderTracker({ sessionId: 'session-1', sessions: [makeSession()] });

    await waitFor(() => expect(mocks.getProjectTask).toHaveBeenCalledTimes(1));
    await settle();
    expect(result.current).toBeNull();
  });

  it('refetches the task only when the selected session changes, not on unrelated list deltas', async () => {
    mocks.getProjectTask.mockResolvedValue(runningTask());
    const session = makeSession();
    const { rerender } = renderTracker({ sessionId: 'session-1', sessions: [session] });
    await waitFor(() => expect(mocks.getProjectTask).toHaveBeenCalledTimes(1));

    rerender({
      sessionId: 'session-1',
      sessions: [session, makeSession({ id: 'session-2', taskId: 'task-2' })],
    });
    await settle();
    expect(mocks.getProjectTask).toHaveBeenCalledTimes(1);

    rerender({ sessionId: 'session-1', sessions: [{ ...session, status: 'sleeping' }] });
    await settle();
    // Going to sleep is a change to the selected session, but a sleeping session
    // never triggers a fetch.
    expect(mocks.getProjectTask).toHaveBeenCalledTimes(1);
  });
});

describe('useProvisioningTracker — poll', () => {
  const inFlight = (): ProvisioningState => ({
    taskId: 'task-1',
    sessionId: 'session-1',
    branchName: BRANCH,
    status: 'queued',
    executionStep: null,
    errorMessage: null,
    startedAt: Date.now(),
    workspaceId: null,
    workspaceUrl: null,
    requestedVmSize: null,
    provisionedVmSize: null,
  });

  it('keeps tracking while the runner is still provisioning (control)', async () => {
    mocks.getProjectTask.mockResolvedValue(makeTask({ status: 'delegated' }));
    const { result, navigate } = renderTracker({
      sessionId: 'session-1',
      sessions: [],
      initial: inFlight(),
    });

    await waitFor(() => expect(result.current?.status).toBe('delegated'));
    expect(result.current?.executionStep).toBe('node_provisioning');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('stops tracking and returns to the session once the agent is running', async () => {
    mocks.getProjectTask.mockResolvedValue(runningTask());
    const { result, navigate } = renderTracker({
      sessionId: 'session-1',
      sessions: [],
      initial: inFlight(),
    });

    await waitFor(() => expect(result.current).toBeNull());
    expect(navigate).toHaveBeenCalledWith('/projects/proj-1/chat/session-1', { replace: true });
  });

  it('stops tracking and returns to the session when the conversation sleeps mid-poll', async () => {
    mocks.getProjectTask.mockResolvedValue(sleepingTask());
    const { result, navigate, loadSessions } = renderTracker({
      sessionId: 'session-1',
      sessions: [],
      initial: inFlight(),
    });

    await waitFor(() => expect(result.current).toBeNull());
    expect(navigate).toHaveBeenCalledWith('/projects/proj-1/chat/session-1', { replace: true });
    // The sidebar must learn the session slept, or the restore effect would
    // immediately refetch the task it just saw as sleeping.
    expect(loadSessions).toHaveBeenCalledTimes(1);
  });
});
