import type { NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatSessionResponse } from '../../../src/lib/api';

const mocks = vi.hoisted(() => ({
  updateProjectTaskStatus: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  updateProjectTaskStatus: mocks.updateProjectTaskStatus,
  deleteWorkspace: mocks.deleteWorkspace,
}));

vi.mock('../../../src/lib/text-utils', () => ({
  stripMarkdown: (s: string) => s,
}));

vi.mock('@simple-agent-manager/ui', () => ({
  Button: ({ children, onClick, disabled, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button onClick={onClick} disabled={disabled} {...props}>{children}</button>
  ),
  Dialog: ({ isOpen, onClose, children }: { isOpen: boolean; onClose: () => void; maxWidth?: string; children: React.ReactNode }) =>
    isOpen ? <div role="dialog" data-testid="dialog">{children}<button onClick={onClose}>CloseDialog</button></div> : null,
  Spinner: () => <span data-testid="spinner" />,
}));

vi.mock('lucide-react', () => ({
  Box: () => <span />,
  CheckCircle2: () => <span />,
  ChevronDown: () => <span />,
  ChevronUp: () => <span />,
  Cloud: () => <span />,
  Cpu: () => <span />,
  ExternalLink: () => <span />,
  FolderOpen: () => <span />,
  GitBranch: () => <span />,
  GitCompare: () => <span />,
  Globe: () => <span />,
  MapPin: () => <span />,
  Server: () => <span />,
}));

import { SessionHeader } from '../../../src/components/project-message-view/SessionHeader';

type SessionHeaderProps = React.ComponentProps<typeof SessionHeader>;

function makeSession(overrides: Partial<ChatSessionResponse> = {}): ChatSessionResponse {
  return {
    id: 'sess-abc123',
    projectId: 'proj-1',
    topic: 'Test Session',
    status: 'running',
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    messageCount: 5,
    workspaceId: 'ws-1',
    agentSessionId: null,
    task: null,
    ...overrides,
  } as ChatSessionResponse;
}

function makeTaskEmbed(overrides: Partial<NonNullable<ChatSessionResponse['task']>> = {}): NonNullable<ChatSessionResponse['task']> {
  return {
    id: 'task-1',
    title: 'Build feature',
    status: 'running',
    priority: 0,
    executionStep: 'running',
    outputBranch: 'sam/feature',
    outputPrUrl: null,
    outputSummary: null,
    errorMessage: null,
    ...overrides,
  } as NonNullable<ChatSessionResponse['task']>;
}

function makeWorkspace(overrides: Partial<WorkspaceResponse> = {}): WorkspaceResponse {
  return {
    id: 'ws-1',
    name: 'test-ws',
    displayName: 'Test Workspace',
    status: 'running',
    vmSize: 'medium',
    vmLocation: 'fsn1',
    workspaceProfile: 'full',
    ...overrides,
  } as WorkspaceResponse;
}

function makeNode(overrides: Partial<NodeResponse> = {}): NodeResponse {
  return {
    id: 'node-1',
    name: 'test-node',
    healthStatus: 'healthy',
    cloudProvider: 'hetzner',
    ...overrides,
  } as NodeResponse;
}

function renderHeader(overrides: Partial<SessionHeaderProps> = {}) {
  const props: SessionHeaderProps = {
    projectId: 'proj-1',
    session: makeSession(),
    sessionState: 'active',
    loading: false,
    idleCountdownMs: null,
    taskEmbed: makeTaskEmbed(),
    workspace: makeWorkspace(),
    node: makeNode(),
    detectedPorts: [],
    onSessionMutated: vi.fn(),
    onOpenFiles: vi.fn(),
    onOpenGit: vi.fn(),
    ...overrides,
  };
  const result = render(<SessionHeader {...props} />);
  return { ...result, props };
}

describe('SessionHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateProjectTaskStatus.mockResolvedValue({});
    mocks.deleteWorkspace.mockResolvedValue({});
  });

  it('renders session topic', () => {
    renderHeader({ session: makeSession({ topic: 'My Chat Session' }) });
    expect(screen.getByText('My Chat Session')).toBeInTheDocument();
  });

  it('shows session ID fallback when topic is absent', () => {
    renderHeader({ session: makeSession({ topic: null as unknown as string }) });
    expect(screen.getByText('Chat sess-abc')).toBeInTheDocument();
  });

  it('shows Active state indicator for active sessions', () => {
    renderHeader({ sessionState: 'active' });
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows Stopped state indicator for stopped sessions', () => {
    renderHeader({ sessionState: 'stopped' });
    expect(screen.getByText('Stopped')).toBeInTheDocument();
  });

  it('shows expand toggle when session has details', () => {
    renderHeader({ taskEmbed: makeTaskEmbed({ outputBranch: 'sam/test' }) });
    expect(screen.getByLabelText('Show session details')).toBeInTheDocument();
  });

  it('expands to show details when toggle is clicked', () => {
    renderHeader({ taskEmbed: makeTaskEmbed({ outputBranch: 'sam/test' }) });
    fireEvent.click(screen.getByLabelText('Show session details'));
    // Branch should now be visible
    expect(screen.getByText('sam/test')).toBeInTheDocument();
  });

  it('shows Open Workspace button for active sessions with workspace', () => {
    renderHeader({ sessionState: 'active' });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.getByText('Open Workspace')).toBeInTheDocument();
  });

  it('shows Mark Complete button when task is eligible', () => {
    renderHeader({ taskEmbed: makeTaskEmbed({ status: 'running' }) });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.getByText('Mark Complete')).toBeInTheDocument();
  });

  it('hides Mark Complete button when task is completed', () => {
    renderHeader({ taskEmbed: makeTaskEmbed({ status: 'completed' }) });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.queryByText('Mark Complete')).not.toBeInTheDocument();
  });

  it('hides Mark Complete button when task is failed', () => {
    renderHeader({ taskEmbed: makeTaskEmbed({ status: 'failed' }) });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.queryByText('Mark Complete')).not.toBeInTheDocument();
  });

  it('opens confirmation dialog when Mark Complete is clicked', () => {
    renderHeader();
    fireEvent.click(screen.getByLabelText('Show session details'));
    fireEvent.click(screen.getByText('Mark Complete'));
    expect(screen.getByText('Mark task as complete?')).toBeInTheDocument();
  });

  it('calls updateProjectTaskStatus and deleteWorkspace on confirm', async () => {
    renderHeader();
    fireEvent.click(screen.getByLabelText('Show session details'));
    fireEvent.click(screen.getByText('Mark Complete'));
    fireEvent.click(screen.getByText('Complete & Delete'));
    await waitFor(() => {
      expect(mocks.updateProjectTaskStatus).toHaveBeenCalledWith('proj-1', 'task-1', { toStatus: 'completed' });
      expect(mocks.deleteWorkspace).toHaveBeenCalledWith('ws-1');
    });
  });

  it('calls onSessionMutated after successful mark complete', async () => {
    const { props } = renderHeader();
    fireEvent.click(screen.getByLabelText('Show session details'));
    fireEvent.click(screen.getByText('Mark Complete'));
    fireEvent.click(screen.getByText('Complete & Delete'));
    await waitFor(() => {
      expect(props.onSessionMutated).toHaveBeenCalled();
    });
  });

  it('shows error message when mark complete fails', async () => {
    mocks.updateProjectTaskStatus.mockRejectedValue(new Error('API error'));
    renderHeader();
    fireEvent.click(screen.getByLabelText('Show session details'));
    fireEvent.click(screen.getByText('Mark Complete'));
    fireEvent.click(screen.getByText('Complete & Delete'));
    await waitFor(() => {
      expect(screen.getByText('API error')).toBeInTheDocument();
    });
  });

  it('shows Dismiss button for mark complete error', async () => {
    mocks.updateProjectTaskStatus.mockRejectedValue(new Error('API error'));
    renderHeader();
    fireEvent.click(screen.getByLabelText('Show session details'));
    fireEvent.click(screen.getByText('Mark Complete'));
    fireEvent.click(screen.getByText('Complete & Delete'));
    await waitFor(() => {
      expect(screen.getByText('Dismiss')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Dismiss'));
    expect(screen.queryByText('API error')).not.toBeInTheDocument();
  });

  it('shows branch name in expanded details', () => {
    renderHeader({ taskEmbed: makeTaskEmbed({ outputBranch: 'sam/feature-xyz' }) });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.getByText('sam/feature-xyz')).toBeInTheDocument();
  });

  it('shows node name with health status', () => {
    renderHeader({ node: makeNode({ name: 'node-alpha', healthStatus: 'healthy' }) });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.getByText('node-alpha')).toBeInTheDocument();
    expect(screen.getByText('(healthy)')).toBeInTheDocument();
  });

  it('shows provider with location', () => {
    renderHeader({
      node: makeNode({ cloudProvider: 'hetzner' }),
      workspace: makeWorkspace({ vmLocation: 'nbg1' }),
    });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.getByText('Hetzner')).toBeInTheDocument();
    expect(screen.getByText(/nbg1/)).toBeInTheDocument();
  });

  it('shows loading spinner when loading prop is true', () => {
    renderHeader({ loading: true });
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });

  it('uses Dialog component, not window.confirm', () => {
    renderHeader();
    fireEvent.click(screen.getByLabelText('Show session details'));
    fireEvent.click(screen.getByText('Mark Complete'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows idle countdown when session is idle', () => {
    renderHeader({ sessionState: 'idle', idleCountdownMs: 600000 });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.getByText(/Cleanup in/)).toBeInTheDocument();
  });

  it('shows View PR link when task has PR URL', () => {
    renderHeader({ taskEmbed: makeTaskEmbed({ outputPrUrl: 'https://github.com/test/pr/1' }) });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.getByText('View PR')).toBeInTheDocument();
  });

  it('disables Mark Complete button while completing', async () => {
    mocks.updateProjectTaskStatus.mockImplementation(() => new Promise(() => {}));
    renderHeader();
    fireEvent.click(screen.getByLabelText('Show session details'));
    fireEvent.click(screen.getByText('Mark Complete'));
    fireEvent.click(screen.getByText('Complete & Delete'));
    await waitFor(() => {
      expect(screen.getByText('Completing...')).toBeInTheDocument();
    });
  });
});
