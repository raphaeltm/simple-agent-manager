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

  it('shows active indicator when task is active', () => {
    render(<ActiveTaskCard task={makeTask({ isActive: true })} />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows inactive indicator when task is inactive', () => {
    render(<ActiveTaskCard task={makeTask({ isActive: false })} />);
    expect(screen.getByText('Inactive')).toBeInTheDocument();
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
});
