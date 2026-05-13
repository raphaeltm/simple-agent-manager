import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionHeader } from '../../src/components/project-message-view/SessionHeader';
import type { ChatSessionResponse } from '../../src/lib/api';
import { DerivedSessionBanner } from '../../src/pages/project-chat/DerivedSessionBanner';
import { SessionItem } from '../../src/pages/project-chat/SessionItem';

function makeSession(overrides: Partial<ChatSessionResponse> = {}): ChatSessionResponse {
  return {
    id: 'session-abc12345',
    workspaceId: 'ws-1',
    taskId: 'task-1',
    topic: 'Fix the login bug',
    status: 'stopped',
    messageCount: 15,
    startedAt: Date.now() - 3600000,
    endedAt: Date.now() - 1800000,
    createdAt: Date.now() - 3600000,
    task: {
      id: 'task-1',
      status: 'failed',
      errorMessage: 'Agent crashed unexpectedly',
      outputBranch: 'sam/fix-login-bug',
    },
    ...overrides,
  };
}

describe('DerivedSessionBanner', () => {
  const onDismiss = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders fork lineage with branch and loading context state', () => {
    render(
      <DerivedSessionBanner
        derived={{
          type: 'fork',
          parentSessionId: 'session-abc12345',
          parentSessionLabel: 'Fix the login bug',
          parentTaskId: 'task-1',
          parentBranch: 'sam/fix-login-bug',
          contextSummary: '',
          summaryLoading: true,
        }}
        onDismiss={onDismiss}
      />
    );

    expect(screen.getByText('Forking from: Fix the login bug')).toBeTruthy();
    expect(screen.getByText('Branch: sam/fix-login-bug')).toBeTruthy();
    expect(screen.getByText('Loading context...')).toBeTruthy();
  });

  it('renders retry lineage with the previous error message', () => {
    render(
      <DerivedSessionBanner
        derived={{
          type: 'retry',
          parentSessionId: 'session-abc12345',
          parentSessionLabel: 'Fix the login bug',
          parentTaskId: 'task-1',
          errorMessage: 'Agent crashed unexpectedly',
          contextSummary: 'Retry context',
          summaryLoading: false,
        }}
        onDismiss={onDismiss}
      />
    );

    expect(screen.getByText('Retrying: Fix the login bug')).toBeTruthy();
    expect(screen.getByText('Error: Agent crashed unexpectedly')).toBeTruthy();
    expect(screen.queryByText('Loading context...')).toBeNull();
  });

  it('calls onDismiss when the cancel button is clicked', async () => {
    const user = userEvent.setup();
    render(
      <DerivedSessionBanner
        derived={{
          type: 'fork',
          parentSessionId: 'session-abc12345',
          parentSessionLabel: 'Fix the login bug',
          parentTaskId: 'task-1',
          contextSummary: '',
          summaryLoading: false,
        }}
        onDismiss={onDismiss}
      />
    );

    await user.click(screen.getByLabelText('Cancel fork/retry'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('SessionHeader retry/fork buttons', () => {
  const onRetry = vi.fn();
  const onFork = vi.fn();
  const projectId = 'proj-1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderHeader(
    session: ChatSessionResponse,
    sessionState: 'active' | 'idle' | 'terminated' = 'terminated',
    extraProps: Record<string, unknown> = {},
  ) {
    return render(
      <MemoryRouter>
        <SessionHeader
          projectId={projectId}
          session={session}
          sessionState={sessionState}
          loading={false}
          idleCountdownMs={null}
          taskEmbed={session.task ?? null}
          workspace={null}
          node={null}
          detectedPorts={[]}
          onRetry={onRetry}
          onFork={onFork}
          {...extraProps}
        />
      </MemoryRouter>
    );
  }

  it('shows retry and fork buttons for terminated sessions with tasks', () => {
    renderHeader(makeSession(), 'terminated');

    expect(screen.getByLabelText('Retry task')).toBeTruthy();
    expect(screen.getByLabelText('Fork session')).toBeTruthy();
  });

  it('shows retry and fork buttons for active sessions with tasks', () => {
    renderHeader(makeSession({ status: 'active' }), 'active');

    expect(screen.getByLabelText('Retry task')).toBeTruthy();
    expect(screen.getByLabelText('Fork session')).toBeTruthy();
  });

  it('shows retry and fork buttons for idle sessions with tasks', () => {
    renderHeader(makeSession({ status: 'active', isIdle: true }), 'idle');

    expect(screen.getByLabelText('Retry task')).toBeTruthy();
    expect(screen.getByLabelText('Fork session')).toBeTruthy();
  });

  it('does not show buttons when session has no task', () => {
    const noTaskSession = makeSession({ task: undefined, taskId: null });
    renderHeader(noTaskSession, 'terminated');

    expect(screen.queryByLabelText('Retry task')).toBeNull();
    expect(screen.queryByLabelText('Fork session')).toBeNull();
  });

  it('calls onRetry when retry button is clicked', async () => {
    const user = userEvent.setup();
    renderHeader(makeSession(), 'terminated');

    await user.click(screen.getByLabelText('Retry task'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('calls onFork when fork button is clicked', async () => {
    const user = userEvent.setup();
    renderHeader(makeSession(), 'terminated');

    await user.click(screen.getByLabelText('Fork session'));
    expect(onFork).toHaveBeenCalledTimes(1);
  });
});

describe('SessionItem sidebar fork button (regression)', () => {
  it('shows fork button for terminated sessions with tasks', () => {
    const onForkSidebar = vi.fn();
    render(
      <SessionItem
        session={makeSession()}
        isSelected={false}
        onSelect={vi.fn()}
        onFork={onForkSidebar}
      />
    );

    const forkBtn = screen.getByTitle('Continue from this session');
    expect(forkBtn).toBeTruthy();
  });

  it('calls onFork with session when sidebar fork button is clicked', async () => {
    const user = userEvent.setup();
    const onForkSidebar = vi.fn();
    const session = makeSession();
    render(
      <SessionItem
        session={session}
        isSelected={false}
        onSelect={vi.fn()}
        onFork={onForkSidebar}
      />
    );

    await user.click(screen.getByTitle('Continue from this session'));
    expect(onForkSidebar).toHaveBeenCalledTimes(1);
    expect(onForkSidebar).toHaveBeenCalledWith(session);
  });

  it('does not show fork button for active sessions', () => {
    render(
      <SessionItem
        session={makeSession({ status: 'active', isIdle: false, endedAt: null, task: { id: 'task-1', status: 'in_progress' } })}
        isSelected={false}
        onSelect={vi.fn()}
        onFork={vi.fn()}
      />
    );

    expect(screen.queryByTitle('Continue from this session')).toBeNull();
  });

  it('shows fork button when session status is active but task is failed (reconciliation)', () => {
    render(
      <SessionItem
        session={makeSession({ status: 'active', endedAt: null, task: { id: 'task-1', status: 'failed', errorMessage: 'crashed' } })}
        isSelected={false}
        onSelect={vi.fn()}
        onFork={vi.fn()}
      />
    );

    // Task terminal state makes getSessionState return 'terminated', so fork button should appear
    expect(screen.getByTitle('Continue from this session')).toBeTruthy();
  });
});
