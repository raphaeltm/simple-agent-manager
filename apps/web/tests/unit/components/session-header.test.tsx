/**
 * Behavioral tests for SessionHeader — mark-complete flow and UI structure.
 *
 * Replaces source-contract tests that read component files as strings.
 * These tests render the actual component, simulate user interactions,
 * and verify the mark-complete confirmation dialog flow.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock API calls
vi.mock('../../../src/lib/api', () => ({
  updateProjectTaskStatus: vi.fn().mockResolvedValue(undefined),
  deleteWorkspace: vi.fn().mockResolvedValue(undefined),
}));

import type { ChatSessionResponse } from '../../../src/lib/api';
import { deleteWorkspace, updateProjectTaskStatus } from '../../../src/lib/api';
import { SessionHeader } from '../../../src/components/project-message-view/SessionHeader';
import type { SessionState } from '../../../src/components/project-message-view/types';

afterEach(cleanup);

function makeSession(overrides: Partial<ChatSessionResponse> = {}): ChatSessionResponse {
  return {
    id: 'session-1',
    topic: 'Fix login bug',
    status: 'running',
    messageCount: 5,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T01:00:00Z',
    workspaceId: 'ws-1',
    agentSessionId: 'agent-1',
    task: {
      id: 'task-1',
      title: 'Fix login bug',
      status: 'in_progress' as const,
      executionStep: 'running',
      outputBranch: 'sam/fix-login',
      outputPrUrl: null,
      errorMessage: null,
      outputSummary: null,
    },
    ...overrides,
  } as ChatSessionResponse;
}

describe('SessionHeader', () => {
  const defaultProps = {
    projectId: 'proj-1',
    session: makeSession(),
    sessionState: 'active' as SessionState,
    loading: false,
    idleCountdownMs: null,
    taskEmbed: makeSession().task,
    workspace: null,
    node: null,
    detectedPorts: [],
    onSessionMutated: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders session topic', () => {
    render(<SessionHeader {...defaultProps} />);
    expect(screen.getByText('Fix login bug')).toBeInTheDocument();
  });

  it('shows state indicator for active session', () => {
    render(<SessionHeader {...defaultProps} />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows state indicator for stopped session', () => {
    render(<SessionHeader {...defaultProps} sessionState="terminated" />);
    expect(screen.getByText('Stopped')).toBeInTheDocument();
  });

  it('shows expand/collapse button when there are details', () => {
    render(<SessionHeader {...defaultProps} />);
    const toggle = screen.getByLabelText('Show session details');
    expect(toggle).toBeInTheDocument();
  });

  it('shows Mark Complete button when expanded for eligible task', () => {
    render(<SessionHeader {...defaultProps} />);

    // Expand the details
    fireEvent.click(screen.getByLabelText('Show session details'));

    expect(screen.getByText('Mark Complete')).toBeInTheDocument();
  });

  it('does not show Mark Complete for completed tasks', () => {
    const session = makeSession();
    const task = { ...session.task!, status: 'completed' as const };
    render(<SessionHeader {...defaultProps} session={session} taskEmbed={task} />);

    // Expand the details
    fireEvent.click(screen.getByLabelText('Show session details'));

    expect(screen.queryByText('Mark Complete')).not.toBeInTheDocument();
  });

  it('does not show Mark Complete for failed tasks', () => {
    const session = makeSession();
    const task = { ...session.task!, status: 'failed' as const };
    render(<SessionHeader {...defaultProps} session={session} taskEmbed={task} />);

    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.queryByText('Mark Complete')).not.toBeInTheDocument();
  });

  it('opens confirmation dialog when Mark Complete is clicked', () => {
    render(<SessionHeader {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Show session details'));
    fireEvent.click(screen.getByText('Mark Complete'));

    expect(screen.getByText('Mark task as complete?')).toBeInTheDocument();
    expect(screen.getByText(/archive the task and delete the workspace/)).toBeInTheDocument();
  });

  it('calls updateProjectTaskStatus and deleteWorkspace on confirm', async () => {
    render(<SessionHeader {...defaultProps} />);

    // Expand → click Mark Complete → confirm
    fireEvent.click(screen.getByLabelText('Show session details'));
    fireEvent.click(screen.getByText('Mark Complete'));
    fireEvent.click(screen.getByText('Complete & Delete'));

    await waitFor(() => {
      expect(updateProjectTaskStatus).toHaveBeenCalledWith('proj-1', 'task-1', { toStatus: 'completed' });
    });
    expect(deleteWorkspace).toHaveBeenCalledWith('ws-1');
    expect(defaultProps.onSessionMutated).toHaveBeenCalled();
  });

  it('cancels the dialog without calling API', () => {
    render(<SessionHeader {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Show session details'));
    fireEvent.click(screen.getByText('Mark Complete'));
    fireEvent.click(screen.getByText('Cancel'));

    expect(updateProjectTaskStatus).not.toHaveBeenCalled();
    // Dialog should be closed
    expect(screen.queryByText('Mark task as complete?')).not.toBeInTheDocument();
  });

  it('shows inline error on failure and allows dismiss', async () => {
    (updateProjectTaskStatus as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Server error'));

    render(<SessionHeader {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Show session details'));
    fireEvent.click(screen.getByText('Mark Complete'));
    fireEvent.click(screen.getByText('Complete & Delete'));

    await waitFor(() => {
      expect(screen.getByText('Server error')).toBeInTheDocument();
    });

    // Dismiss the error
    fireEvent.click(screen.getByText('Dismiss'));
    expect(screen.queryByText('Server error')).not.toBeInTheDocument();
  });

  it('shows loading spinner when loading prop is true', () => {
    render(<SessionHeader {...defaultProps} loading />);
    expect(screen.getByLabelText('Refreshing messages')).toBeInTheDocument();
  });

  it('shows Open Workspace button when expanded for active session with workspace', () => {
    render(<SessionHeader {...defaultProps} />);
    fireEvent.click(screen.getByLabelText('Show session details'));

    expect(screen.getByText('Open Workspace')).toBeInTheDocument();
  });

  it('renders branch name in expanded details', () => {
    render(<SessionHeader {...defaultProps} workspace={{
      id: 'ws-1',
      name: 'test-ws',
      displayName: 'Test WS',
      status: 'running',
      vmSize: 'small',
      vmLocation: 'fsn1',
      workspaceProfile: 'full',
    } as any} />);

    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.getByText('sam/fix-login')).toBeInTheDocument();
  });

  it('calls onSessionMutated callback after mark complete (no page reload)', async () => {
    // The mark-complete handler must call onSessionMutated (React state refresh)
    // rather than window.location.reload() per rule 16.
    // We verify the callback IS called; the absence of reload is ensured
    // by the component using onSessionMutated?.() — see SessionHeader.tsx:96.
    const onMutated = vi.fn();
    render(<SessionHeader {...defaultProps} onSessionMutated={onMutated} />);

    fireEvent.click(screen.getByLabelText('Show session details'));
    fireEvent.click(screen.getByText('Mark Complete'));
    fireEvent.click(screen.getByText('Complete & Delete'));

    await waitFor(() => {
      expect(onMutated).toHaveBeenCalledTimes(1);
    });
  });
});
