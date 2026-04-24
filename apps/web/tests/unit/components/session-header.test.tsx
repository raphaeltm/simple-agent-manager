import type { NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatSessionResponse } from '../../../src/lib/api';

const mocks = vi.hoisted(() => ({
  updateProjectTaskStatus: vi.fn(),
  deleteWorkspace: vi.fn(),
  getProjectTask: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  updateProjectTaskStatus: mocks.updateProjectTaskStatus,
  deleteWorkspace: mocks.deleteWorkspace,
  getProjectTask: mocks.getProjectTask,
}));

vi.mock('../../../src/lib/text-utils', () => ({
  stripMarkdown: (s: string) => s,
}));

vi.mock('../../../src/lib/url-utils', () => ({
  sanitizeUrl: (s: string) => s,
}));

vi.mock('react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [key: string]: unknown }) => (
    <a href={to} {...props}>{children}</a>
  ),
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
  CheckCircle2: () => <span data-testid="icon-check-circle" />,
  ChevronDown: () => <span />,
  ChevronUp: () => <span />,
  Clock: () => <span />,
  Cloud: () => <span />,
  Copy: () => <span data-testid="icon-copy" />,
  Cpu: () => <span />,
  ExternalLink: () => <span />,
  FolderOpen: () => <span />,
  GitBranch: () => <span />,
  GitCompare: () => <span />,
  GitFork: () => <span />,
  Globe: () => <span />,
  Hash: () => <span />,
  Loader2: () => <span />,
  MapPin: () => <span />,
  Monitor: () => <span />,
  RotateCcw: () => <span />,
  Server: () => <span />,
  Tag: () => <span />,
  Timer: () => <span />,
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

  it('shows Workspace button for active sessions with workspace', () => {
    renderHeader({ sessionState: 'active' });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.getByLabelText('Open workspace')).toBeInTheDocument();
  });

  it('shows Complete button when task is eligible', () => {
    renderHeader({ taskEmbed: makeTaskEmbed({ status: 'running' }) });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.getByText('Complete')).toBeInTheDocument();
  });

  it('hides Complete button when task is completed', () => {
    renderHeader({ taskEmbed: makeTaskEmbed({ status: 'completed' }) });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.queryByText('Complete')).not.toBeInTheDocument();
  });

  it('hides Complete button when task is failed', () => {
    renderHeader({ taskEmbed: makeTaskEmbed({ status: 'failed' }) });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.queryByText('Complete')).not.toBeInTheDocument();
  });

  it('opens confirmation dialog when Complete is clicked', () => {
    renderHeader();
    fireEvent.click(screen.getByLabelText('Show session details'));
    fireEvent.click(screen.getByText('Complete'));
    expect(screen.getByText('Mark task as complete?')).toBeInTheDocument();
  });

  it('calls updateProjectTaskStatus and deleteWorkspace on confirm', async () => {
    renderHeader();
    fireEvent.click(screen.getByLabelText('Show session details'));
    fireEvent.click(screen.getByText('Complete'));
    fireEvent.click(screen.getByText('Complete & Delete'));
    await waitFor(() => {
      expect(mocks.updateProjectTaskStatus).toHaveBeenCalledWith('proj-1', 'task-1', { toStatus: 'completed' });
      expect(mocks.deleteWorkspace).toHaveBeenCalledWith('ws-1');
    });
  });

  it('calls onSessionMutated after successful mark complete', async () => {
    const { props } = renderHeader();
    fireEvent.click(screen.getByLabelText('Show session details'));
    fireEvent.click(screen.getByText('Complete'));
    fireEvent.click(screen.getByText('Complete & Delete'));
    await waitFor(() => {
      expect(props.onSessionMutated).toHaveBeenCalled();
    });
  });

  it('shows error message when mark complete fails', async () => {
    mocks.updateProjectTaskStatus.mockRejectedValue(new Error('API error'));
    renderHeader();
    fireEvent.click(screen.getByLabelText('Show session details'));
    fireEvent.click(screen.getByText('Complete'));
    fireEvent.click(screen.getByText('Complete & Delete'));
    await waitFor(() => {
      expect(screen.getByText('API error')).toBeInTheDocument();
    });
  });

  it('shows Dismiss button for complete error', async () => {
    mocks.updateProjectTaskStatus.mockRejectedValue(new Error('API error'));
    renderHeader();
    fireEvent.click(screen.getByLabelText('Show session details'));
    fireEvent.click(screen.getByText('Complete'));
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

  it('uses Dialog component for completion confirmation', () => {
    renderHeader();
    fireEvent.click(screen.getByLabelText('Show session details'));
    fireEvent.click(screen.getByText('Complete'));
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

  it('disables Complete button while completing', async () => {
    mocks.updateProjectTaskStatus.mockImplementation(() => new Promise(() => {}));
    renderHeader();
    fireEvent.click(screen.getByLabelText('Show session details'));
    fireEvent.click(screen.getByText('Complete'));
    fireEvent.click(screen.getByText('Complete & Delete'));
    await waitFor(() => {
      expect(screen.getByText('Completing...')).toBeInTheDocument();
    });
  });

  // --- CopyableId and Reference IDs ---

  it('shows References section with session ID when expanded', () => {
    renderHeader();
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.getByText('References')).toBeInTheDocument();
    // Session ID is always present — look for the truncated display
    expect(screen.getByTitle(/Session: sess-abc123/)).toBeInTheDocument();
  });

  it('shows task ID pill when task embed is present', () => {
    renderHeader({ taskEmbed: makeTaskEmbed({ id: 'task-xyz789' }) });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.getByTitle(/Task: task-xyz789/)).toBeInTheDocument();
  });

  it('shows workspace ID pill when workspace is linked', () => {
    renderHeader({ session: makeSession({ workspaceId: 'ws-deadbeef' }) });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.getByTitle(/Workspace: ws-deadbeef/)).toBeInTheDocument();
  });

  it('shows ACP session ID pill when agent session is linked', () => {
    renderHeader({ session: makeSession({ agentSessionId: 'acp-session-42' }) });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.getByTitle(/ACP: acp-session-42/)).toBeInTheDocument();
  });

  it('copies value to clipboard and shows checkmark when CopyableId is clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderHeader();
    fireEvent.click(screen.getByLabelText('Show session details'));

    const pill = screen.getByTitle(/Session: sess-abc123/);
    // Before click: shows copy icon, not check icon
    expect(pill.querySelector('[data-testid="icon-copy"]')).toBeInTheDocument();
    expect(pill.querySelector('[data-testid="icon-check-circle"]')).not.toBeInTheDocument();

    fireEvent.click(pill);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('sess-abc123');
    });

    // After copy: shows checkmark feedback
    await waitFor(() => {
      expect(pill.querySelector('[data-testid="icon-check-circle"]')).toBeInTheDocument();
    });
  });

  // --- Task execution step and status badge ---

  it('shows task execution step when task is in_progress', () => {
    renderHeader({
      taskEmbed: makeTaskEmbed({ status: 'in_progress', executionStep: 'node_provisioning' }),
    });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.getByText('Provisioning node')).toBeInTheDocument();
  });

  it('does not show execution step when task is completed', () => {
    renderHeader({
      taskEmbed: makeTaskEmbed({ status: 'completed', executionStep: 'agent_session' }),
    });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.queryByText('Agent running')).not.toBeInTheDocument();
  });

  it('shows task status badge with formatted text', () => {
    renderHeader({
      taskEmbed: makeTaskEmbed({ status: 'in_progress' }),
    });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.getByText('In progress')).toBeInTheDocument();
  });

  it('shows completed status badge with check icon', () => {
    renderHeader({
      taskEmbed: makeTaskEmbed({ status: 'completed' }),
    });
    fireEvent.click(screen.getByLabelText('Show session details'));
    const badge = screen.getByText('Completed');
    expect(badge).toBeInTheDocument();
    // Check icon is within the badge
    expect(badge.closest('span')?.querySelector('[data-testid="icon-check-circle"]')).toBeInTheDocument();
  });

  // --- Session timing ---

  it('shows session start time when startedAt is set', () => {
    const startedAt = new Date('2026-04-24T10:30:00Z').getTime();
    renderHeader({ session: makeSession({ startedAt }) });
    fireEvent.click(screen.getByLabelText('Show session details'));
    // The formatted time should contain Apr 24
    expect(screen.getByText(/Apr 24/)).toBeInTheDocument();
  });

  it('shows duration for completed sessions', () => {
    const startedAt = new Date('2026-04-24T10:00:00Z').getTime();
    const endedAt = new Date('2026-04-24T10:15:00Z').getTime();
    renderHeader({ session: makeSession({ startedAt, endedAt }) });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.getByText('15m')).toBeInTheDocument();
  });

  it('shows running indicator for active sessions with timing', () => {
    const startedAt = Date.now() - 60_000; // 1 minute ago
    renderHeader({
      session: makeSession({ startedAt }),
      taskEmbed: null,
      workspace: null,
    });
    fireEvent.click(screen.getByLabelText('Show session details'));
    expect(screen.getByText('(running)')).toBeInTheDocument();
  });

  // --- Retry and Fork buttons ---

  it('shows retry button when onRetry is provided and session has task', () => {
    renderHeader({
      session: makeSession({ taskId: 'task-1' }),
      onRetry: vi.fn(),
    });
    expect(screen.getByLabelText('Retry task')).toBeInTheDocument();
  });

  it('shows fork button when onFork is provided and session has task', () => {
    renderHeader({
      session: makeSession({ taskId: 'task-1' }),
      onFork: vi.fn(),
    });
    expect(screen.getByLabelText('Fork session')).toBeInTheDocument();
  });
});
