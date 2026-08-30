import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildSessionToolActions,
  type BuildSessionToolActionsInput,
} from '../../src/components/project-message-view/session-tool-actions';
import { SessionToolRail } from '../../src/components/project-message-view/SessionToolRail';
import type { ChatSessionResponse } from '../../src/lib/api';
import { DerivedSessionBanner } from '../../src/pages/project-chat/DerivedSessionBanner';

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

/**
 * Retry and Fork used to be unlabeled 14px icons in the session-header title row. They
 * are now named controls in `SessionToolRail`, so the same behavioural contract —
 * present for sessions with a task, absent without, wired to their handlers — is
 * asserted against the rail.
 */
describe('Retry/Fork in the session tool rail', () => {
  const onSelect = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function actionsFor(
    session: ChatSessionResponse,
    sessionState: BuildSessionToolActionsInput['sessionState'] = 'terminated',
    overrides: Partial<BuildSessionToolActionsInput> = {}
  ) {
    return buildSessionToolActions({
      session,
      sessionState,
      taskEmbed: session.task ?? null,
      reportEnabled: false,
      unresolvedCommentCount: 0,
      hasFilesHandler: true,
      hasGitHandler: true,
      hasTimelineHandler: true,
      hasCommentsHandler: true,
      hasRetryHandler: true,
      hasForkHandler: true,
      ...overrides,
    });
  }

  function renderRail(
    session: ChatSessionResponse,
    sessionState: BuildSessionToolActionsInput['sessionState'] = 'terminated'
  ) {
    return render(
      <MemoryRouter>
        <SessionToolRail
          actions={actionsFor(session, sessionState)}
          mode="labels"
          onModeChange={vi.fn()}
          onSelect={onSelect}
          isMobile={false}
        />
      </MemoryRouter>
    );
  }

  it('shows retry and fork for terminated sessions with tasks', () => {
    renderRail(makeSession(), 'terminated');

    expect(screen.getByLabelText('Retry — re-run this task')).toBeTruthy();
    expect(screen.getByLabelText('Fork — start a new task from this session')).toBeTruthy();
  });

  it('shows retry and fork for active sessions with tasks', () => {
    renderRail(makeSession({ status: 'active' }), 'active');

    expect(screen.getByLabelText('Retry — re-run this task')).toBeTruthy();
    expect(screen.getByLabelText('Fork — start a new task from this session')).toBeTruthy();
  });

  it('shows retry and fork for idle sessions with tasks', () => {
    renderRail(makeSession({ status: 'active', isIdle: true }), 'idle');

    expect(screen.getByLabelText('Retry — re-run this task')).toBeTruthy();
    expect(screen.getByLabelText('Fork — start a new task from this session')).toBeTruthy();
  });

  it('omits retry and fork when the session has no task', () => {
    renderRail(makeSession({ task: undefined, taskId: null }), 'terminated');

    expect(screen.queryByLabelText('Retry — re-run this task')).toBeNull();
    expect(screen.queryByLabelText('Fork — start a new task from this session')).toBeNull();
    // Liveness: the rail rendered, so the absence above is a real omission rather than
    // a component that failed to mount (rule 62).
    expect(screen.getByLabelText('Show session details, IDs and infrastructure')).toBeTruthy();
  });

  it('omits retry and fork when no handler is supplied', () => {
    render(
      <MemoryRouter>
        <SessionToolRail
          actions={actionsFor(makeSession(), 'terminated', {
            hasRetryHandler: false,
            hasForkHandler: false,
          })}
          mode="labels"
          onModeChange={vi.fn()}
          onSelect={onSelect}
          isMobile={false}
        />
      </MemoryRouter>
    );

    expect(screen.queryByLabelText('Retry — re-run this task')).toBeNull();
    expect(screen.queryByLabelText('Fork — start a new task from this session')).toBeNull();
    expect(screen.getByLabelText('Show session details, IDs and infrastructure')).toBeTruthy();
  });

  it('dispatches retry when the retry control is clicked', async () => {
    const user = userEvent.setup();
    renderRail(makeSession(), 'terminated');

    await user.click(screen.getByLabelText('Retry — re-run this task'));
    expect(onSelect).toHaveBeenCalledWith('retry');
  });

  it('dispatches fork when the fork control is clicked', async () => {
    const user = userEvent.setup();
    renderRail(makeSession(), 'terminated');

    await user.click(screen.getByLabelText('Fork — start a new task from this session'));
    expect(onSelect).toHaveBeenCalledWith('fork');
  });
});
