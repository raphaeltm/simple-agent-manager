import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatSessionResponse } from '../../src/lib/api';

// Mock API calls
vi.mock('../../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api')>();
  return {
    ...actual,
    getProjectTask: vi.fn().mockResolvedValue({ description: 'Original task description' }),
    summarizeSession: vi.fn().mockResolvedValue({
      summary: 'Summary of previous session',
      messageCount: 10,
      filteredCount: 5,
      method: 'ai' as const,
    }),
    deleteWorkspace: vi.fn(),
    updateProjectTaskStatus: vi.fn(),
  };
});

// Mock useBrowserSidecar hook
vi.mock('../../src/hooks/useBrowserSidecar', () => ({
  useBrowserSidecar: () => ({
    status: null,
    isLoading: false,
    error: null,
    start: vi.fn(),
  }),
}));

import { RetryDialog } from '../../src/components/project/RetryDialog';
import { ForkDialog, FORK_MESSAGE_TEMPLATE } from '../../src/components/project/ForkDialog';
import { SessionHeader } from '../../src/components/project-message-view/SessionHeader';

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

describe('RetryDialog', () => {
  const onClose = vi.fn();
  const onRetry = vi.fn().mockResolvedValue(undefined);
  const projectId = 'proj-1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with session title and error message', async () => {
    render(
      <RetryDialog
        open
        session={makeSession()}
        projectId={projectId}
        onClose={onClose}
        onRetry={onRetry}
      />
    );

    expect(screen.getByText('Retry task')).toBeTruthy();
    expect(screen.getByText('Fix the login bug')).toBeTruthy();
    expect(screen.getByText(/Agent crashed unexpectedly/)).toBeTruthy();
  });

  it('pre-fills message from task description', async () => {
    render(
      <RetryDialog
        open
        session={makeSession()}
        projectId={projectId}
        onClose={onClose}
        onRetry={onRetry}
      />
    );

    await waitFor(() => {
      const textarea = screen.getByPlaceholderText('Task description...');
      expect(textarea).toBeTruthy();
      expect((textarea as HTMLTextAreaElement).value).toBe('Original task description');
    });
  });

  it('calls onRetry with message and context summary on submit', async () => {
    const user = userEvent.setup();
    render(
      <RetryDialog
        open
        session={makeSession()}
        projectId={projectId}
        onClose={onClose}
        onRetry={onRetry}
      />
    );

    // Wait for data to load
    await waitFor(() => {
      expect((screen.getByPlaceholderText('Task description...') as HTMLTextAreaElement).value).toBe('Original task description');
    });

    // Wait for summary to load (needed for submit button to enable)
    await waitFor(() => {
      const retryBtn = screen.getByRole('button', { name: 'Retry' });
      expect(retryBtn).not.toBeDisabled();
    });

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(onRetry).toHaveBeenCalledTimes(1);
      const [msg, ctx, parentId] = onRetry.mock.calls[0] as [string, string, string];
      expect(msg).toBe('Original task description');
      expect(ctx).toContain('Retry Context');
      expect(ctx).toContain('session-abc12345');
      expect(parentId).toBe('task-1');
    });
  });

  it('disables submit when message is empty', async () => {
    const user = userEvent.setup();
    render(
      <RetryDialog
        open
        session={makeSession()}
        projectId={projectId}
        onClose={onClose}
        onRetry={onRetry}
      />
    );

    // Wait for load
    await waitFor(() => {
      expect((screen.getByPlaceholderText('Task description...') as HTMLTextAreaElement).value).toBe('Original task description');
    });

    // Clear the message
    const textarea = screen.getByPlaceholderText('Task description...');
    await user.clear(textarea);

    // Submit should be disabled
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });
});

describe('ForkDialog', () => {
  const onClose = vi.fn();
  const onFork = vi.fn().mockResolvedValue(undefined);
  const projectId = 'proj-1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pre-fills message with MCP tools template', async () => {
    render(
      <ForkDialog
        open
        session={makeSession()}
        projectId={projectId}
        onClose={onClose}
        onFork={onFork}
      />
    );

    await waitFor(() => {
      const textarea = screen.getByPlaceholderText('Describe the next task...');
      const value = (textarea as HTMLTextAreaElement).value;
      expect(value).toContain('SAM MCP tools');
      expect(value).toContain('get_session_messages');
      expect(value).toContain('search_messages');
      expect(value).toContain('Fix the login bug');
    });
  });

  it('exports FORK_MESSAGE_TEMPLATE constant', () => {
    expect(FORK_MESSAGE_TEMPLATE).toContain('SAM MCP tools');
    expect(FORK_MESSAGE_TEMPLATE).toContain('get_session_messages');
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
