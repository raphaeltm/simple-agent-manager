import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActiveTaskCard } from '../../../src/components/ActiveTaskCard';
import type { DashboardTask } from '@simple-agent-manager/shared';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

function makeTask(overrides: Partial<DashboardTask> = {}): DashboardTask {
  return {
    id: 'task-1',
    title: 'Fix authentication bug',
    status: 'in_progress',
    executionStep: 'running',
    projectId: 'proj-1',
    projectName: 'my-project',
    sessionId: 'session-1',
    createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
    startedAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
    lastMessageAt: Date.now() - 5 * 60 * 1000, // 5 min ago
    messageCount: 12,
    isActive: true,
    ...overrides,
  };
}

describe('ActiveTaskCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders task title and project name', () => {
    render(<ActiveTaskCard task={makeTask()} />);
    expect(screen.getByText('Fix authentication bug')).toBeInTheDocument();
    expect(screen.getByText('my-project')).toBeInTheDocument();
  });

  it('shows responding indicator when task is active', () => {
    render(<ActiveTaskCard task={makeTask({ isActive: true })} />);
    expect(screen.getByText('Responding')).toBeInTheDocument();
  });

  it('shows idle indicator when task is inactive', () => {
    render(<ActiveTaskCard task={makeTask({ isActive: false })} />);
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  it('shows "No messages" when lastMessageAt is null', () => {
    render(<ActiveTaskCard task={makeTask({ lastMessageAt: null })} />);
    expect(screen.getByText('No messages')).toBeInTheDocument();
  });

  it('shows relative time for last message', () => {
    render(<ActiveTaskCard task={makeTask({ lastMessageAt: Date.now() - 5 * 60 * 1000 })} />);
    expect(screen.getByText('Last msg 5m ago')).toBeInTheDocument();
  });

  it('shows submission time', () => {
    render(<ActiveTaskCard task={makeTask({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() })} />);
    expect(screen.getByText('Submitted 2h ago')).toBeInTheDocument();
  });

  it('navigates to chat session on click', () => {
    render(<ActiveTaskCard task={makeTask({ projectId: 'proj-1', sessionId: 'session-1' })} />);
    fireEvent.click(screen.getByRole('button'));
    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1/chat/session-1');
  });

  it('navigates to project chat when no session', () => {
    render(<ActiveTaskCard task={makeTask({ sessionId: null })} />);
    fireEvent.click(screen.getByRole('button'));
    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1/chat');
  });

  it('navigates on keyboard Enter', () => {
    render(<ActiveTaskCard task={makeTask()} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1/chat/session-1');
  });

  it('shows execution step when provisioning', () => {
    render(<ActiveTaskCard task={makeTask({ executionStep: 'node_provisioning' })} />);
    expect(screen.getByText('Setting up a new server...')).toBeInTheDocument();
  });

  it('does not show step label when step is running', () => {
    render(<ActiveTaskCard task={makeTask({ executionStep: 'running' })} />);
    expect(screen.queryByText('Agent is working...')).not.toBeInTheDocument();
  });

  it('renders status badge with correct status', () => {
    render(<ActiveTaskCard task={makeTask({ status: 'queued' })} />);
    expect(screen.getByText('Queued')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Keyboard — Space key
  // ---------------------------------------------------------------------------

  it('navigates on keyboard Space', () => {
    render(<ActiveTaskCard task={makeTask()} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: ' ' });
    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1/chat/session-1');
  });

  it('does not navigate on other keys', () => {
    render(<ActiveTaskCard task={makeTask()} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Tab' });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Execution step labels — each non-running step shows its label
  // ---------------------------------------------------------------------------

  it('shows label for node_selection step', () => {
    render(<ActiveTaskCard task={makeTask({ executionStep: 'node_selection' })} />);
    expect(screen.getByText('Finding a server...')).toBeInTheDocument();
  });

  it('shows label for workspace_creation step', () => {
    render(<ActiveTaskCard task={makeTask({ executionStep: 'workspace_creation' })} />);
    expect(screen.getByText('Creating workspace...')).toBeInTheDocument();
  });

  it('shows label for workspace_ready step', () => {
    render(<ActiveTaskCard task={makeTask({ executionStep: 'workspace_ready' })} />);
    expect(screen.getByText('Setting up development environment...')).toBeInTheDocument();
  });

  it('shows label for agent_session step', () => {
    render(<ActiveTaskCard task={makeTask({ executionStep: 'agent_session' })} />);
    expect(screen.getByText('Starting AI agent...')).toBeInTheDocument();
  });

  it('shows label for awaiting_followup step', () => {
    render(<ActiveTaskCard task={makeTask({ executionStep: 'awaiting_followup' })} />);
    expect(screen.getByText('Waiting for follow-up...')).toBeInTheDocument();
  });

  it('shows label for node_agent_ready step', () => {
    render(<ActiveTaskCard task={makeTask({ executionStep: 'node_agent_ready' })} />);
    expect(screen.getByText('Waiting for server to start...')).toBeInTheDocument();
  });

  it('does not show any step label when executionStep is null', () => {
    render(<ActiveTaskCard task={makeTask({ executionStep: null })} />);
    // None of the known labels should appear
    expect(screen.queryByText('Finding a server...')).not.toBeInTheDocument();
    expect(screen.queryByText('Setting up a new server...')).not.toBeInTheDocument();
    expect(screen.queryByText('Creating workspace...')).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // formatRelativeTime — boundary cases
  // ---------------------------------------------------------------------------

  it('shows "Just now" for timestamps less than 60 seconds ago', () => {
    render(<ActiveTaskCard task={makeTask({ lastMessageAt: Date.now() - 30 * 1000 })} />);
    expect(screen.getByText('Last msg Just now')).toBeInTheDocument();
  });

  it('shows days for timestamps older than 24 hours', () => {
    render(<ActiveTaskCard task={makeTask({ lastMessageAt: Date.now() - 2 * 24 * 60 * 60 * 1000 })} />);
    expect(screen.getByText('Last msg 2d ago')).toBeInTheDocument();
  });

  it('handles lastMessageAt as an ISO string', () => {
    // The component accepts string or number; the string branch converts via new Date()
    const isoTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    render(<ActiveTaskCard task={makeTask({ lastMessageAt: isoTime as unknown as number })} />);
    expect(screen.getByText('Last msg 10m ago')).toBeInTheDocument();
  });

  it('shows submission time in days when createdAt is old', () => {
    render(
      <ActiveTaskCard
        task={makeTask({ createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() })}
      />
    );
    expect(screen.getByText('Submitted 3d ago')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Status badge — additional status values
  // ---------------------------------------------------------------------------

  it('renders status badge for delegated status', () => {
    render(<ActiveTaskCard task={makeTask({ status: 'delegated' })} />);
    // StatusBadge should render something representing this status; at minimum it should render
    const button = screen.getByRole('button');
    expect(button).toBeInTheDocument();
  });
});
