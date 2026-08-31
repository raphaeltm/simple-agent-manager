import type { NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatSessionResponse } from '../../../src/lib/api';

const mocks = vi.hoisted(() => ({
  updateProjectTaskStatus: vi.fn(),
  deleteWorkspace: vi.fn(),
  getProjectTask: vi.fn(),
  listChatMessages: vi.fn(),
  updateWorkspacePortsPublic: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  updateProjectTaskStatus: mocks.updateProjectTaskStatus,
  deleteWorkspace: mocks.deleteWorkspace,
  getProjectTask: mocks.getProjectTask,
  listChatMessages: mocks.listChatMessages,
  updateWorkspacePortsPublic: mocks.updateWorkspacePortsPublic,
}));

vi.mock('../../../src/lib/text-utils', () => ({
  stripMarkdown: (s: string) => s,
}));

vi.mock('../../../src/lib/url-utils', () => ({
  sanitizeUrl: (s: string) => s,
}));

vi.mock('react-router', () => ({
  Link: ({
    children,
    to,
    ...props
  }: {
    children: React.ReactNode;
    to: string;
    [key: string]: unknown;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@simple-agent-manager/ui', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  ),
  Dialog: ({
    isOpen,
    onClose,
    children,
  }: {
    isOpen: boolean;
    onClose: () => void;
    maxWidth?: string;
    children: React.ReactNode;
  }) =>
    isOpen ? (
      <div role="dialog" data-testid="dialog">
        {children}
        <button onClick={onClose}>CloseDialog</button>
      </div>
    ) : null,
  Spinner: () => <span data-testid="spinner" />,
}));

vi.mock('lucide-react', () => ({
  AlertTriangle: () => <span />,
  Bot: () => <span />,
  Box: () => <span />,
  CheckCircle2: () => <span data-testid="icon-check-circle" />,
  ChevronDown: () => <span />,
  ChevronLeft: () => <span />,
  ChevronRight: () => <span />,
  ChevronUp: () => <span />,
  Clock: () => <span />,
  Cloud: () => <span />,
  Copy: () => <span data-testid="icon-copy" />,
  Cpu: () => <span />,
  ExternalLink: () => <span />,
  Flag: () => <span />,
  FolderOpen: () => <span />,
  GitBranch: () => <span />,
  GitCompare: () => <span />,
  GitFork: () => <span />,
  Globe: () => <span />,
  Hash: () => <span />,
  Info: () => <span />,
  Loader2: () => <span />,
  MapPin: () => <span />,
  MessageSquare: () => <span />,
  MessageSquareQuote: () => <span />,
  Monitor: () => <span />,
  RotateCcw: () => <span />,
  Server: () => <span />,
  Tag: () => <span />,
  Timer: () => <span />,
  User2: () => <span />,
}));

import { useState } from 'react';

import { buildSessionToolActions } from '../../../src/components/project-message-view/session-tool-actions';
import { SessionHeader } from '../../../src/components/project-message-view/SessionHeader';
import { SessionToolRail } from '../../../src/components/project-message-view/SessionToolRail';

type SessionHeaderProps = React.ComponentProps<typeof SessionHeader>;

/** The rail's Details action — the production trigger for the header's details panel. */
const DETAILS_CONTROL = 'Show session details, IDs and infrastructure';

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

function makeTaskEmbed(
  overrides: Partial<NonNullable<ChatSessionResponse['task']>> = {}
): NonNullable<ChatSessionResponse['task']> {
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

type HarnessProps = Omit<SessionHeaderProps, 'expanded' | 'onExpandedChange'>;

/**
 * Renders the header together with the real tool rail.
 *
 * The details panel is controlled now — the chevron that used to toggle it is gone, and
 * the rail's "Details" action is the production trigger. Pairing them here keeps these
 * tests driving a real control instead of setting `expanded` directly
 * (`.claude/rules/62-tests-must-observe-the-real-trigger.md`).
 */
function HeaderHarness(props: HarnessProps) {
  const [expanded, setExpanded] = useState(false);
  const actions = buildSessionToolActions({
    session: props.session,
    sessionState: props.sessionState,
    taskEmbed: props.taskEmbed,
    reportEnabled: false,
    unresolvedCommentCount: 0,
    hasFilesHandler: true,
    hasGitHandler: true,
    hasTimelineHandler: true,
    hasCommentsHandler: true,
    hasRetryHandler: true,
    hasForkHandler: true,
  });
  return (
    <>
      <SessionHeader {...props} expanded={expanded} onExpandedChange={setExpanded} />
      <SessionToolRail
        actions={actions}
        mode="icons"
        onModeChange={vi.fn()}
        onSelect={(id) => {
          if (id === 'details') setExpanded((v) => !v);
        }}
        isMobile={false}
      />
    </>
  );
}

function renderHeader(overrides: Partial<HarnessProps> = {}) {
  const props: HarnessProps = {
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
    ...overrides,
  };
  const result = render(<HeaderHarness {...props} />);
  return { ...result, props };
}

describe('SessionHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateProjectTaskStatus.mockResolvedValue({});
    mocks.deleteWorkspace.mockResolvedValue({});
    mocks.listChatMessages.mockResolvedValue({ messages: [], hasMore: false });
    mocks.updateWorkspacePortsPublic.mockResolvedValue(makeWorkspace({ portsPublicEnabled: true }));
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

  it('exposes the details control in the tool rail', () => {
    renderHeader({ taskEmbed: makeTaskEmbed({ outputBranch: 'sam/test' }) });
    expect(screen.getByLabelText(DETAILS_CONTROL)).toBeInTheDocument();
  });

  it('keeps the details panel collapsed until the rail control is used', () => {
    renderHeader({ taskEmbed: makeTaskEmbed({ outputBranch: 'sam/test' }) });
    expect(screen.queryByText('References')).not.toBeInTheDocument();
    // Liveness beside the absence assertion: the header really did render.
    expect(screen.getByText('Test Session')).toBeInTheDocument();
  });

  it('expands to show details when toggle is clicked', () => {
    renderHeader({ taskEmbed: makeTaskEmbed({ outputBranch: 'sam/test' }) });
    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));
    // Branch should now be visible
    expect(screen.getByText('sam/test')).toBeInTheDocument();
  });

  it('shows the full title and fallback initial prompt in expanded details', () => {
    renderHeader({
      session: makeSession({
        topic: 'A very long session title that should be inspectable in full',
      }),
      initialPromptFallback: 'Please build the thing from the original user prompt.',
    });

    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));

    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(
      screen.getAllByText('A very long session title that should be inspectable in full')
    ).toHaveLength(2);
    expect(screen.getByText('Initial prompt')).toBeInTheDocument();
    expect(
      screen.getByText('Please build the thing from the original user prompt.')
    ).toBeInTheDocument();
    expect(mocks.listChatMessages).not.toHaveBeenCalled();
  });

  it('fetches the oldest user message when no safe initial prompt fallback is available', async () => {
    mocks.listChatMessages.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-initial',
          sessionId: 'sess-abc123',
          role: 'user',
          content: 'Initial prompt loaded from the server',
          toolMetadata: null,
          createdAt: 1000,
        },
      ],
      hasMore: true,
    });

    renderHeader({ initialPromptFallback: null });
    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));

    await waitFor(() => {
      expect(mocks.listChatMessages).toHaveBeenCalledWith('proj-1', 'sess-abc123', {
        limit: 1,
        roles: ['user'],
        compact: true,
        order: 'asc',
      });
    });
    expect(await screen.findByText('Initial prompt loaded from the server')).toBeInTheDocument();
  });

  it('expands details from the more-ports control', async () => {
    renderHeader({
      detectedPorts: [
        {
          port: 5173,
          address: '127.0.0.1',
          label: 'Vite',
          url: 'https://ws-ws-1--5173.workspaces.example.com',
          detectedAt: '2026-06-01T00:00:00Z',
        },
        {
          port: 8787,
          address: '127.0.0.1',
          label: 'Worker',
          url: 'https://ws-ws-1--8787.workspaces.example.com',
          detectedAt: '2026-06-01T00:00:00Z',
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more forwarded port' }));

    await waitFor(() => {
      expect(screen.getByText('References')).toBeInTheDocument();
    });
    expect(screen.getAllByText('5173').length).toBeGreaterThan(0);
    expect(screen.getByText(/8787/)).toBeInTheDocument();
  });

  // Workspace / Complete now live in the tool rail, always visible — no disclosure to
  // open first. The mark-complete FLOW (dialog, mutation, error) moved with them to
  // `useSessionTools`; see `tests/unit/components/use-session-tools.test.tsx`.
  /*
   * Workspaces are an implementation detail. The `/workspaces/:id` page survives for
   * debugging, but nothing in the chat should route a user to it — so an active session
   * with a live workspace must still offer no such control.
   *
   * The liveness assertion beside it matters: "the workspace control is absent" is also
   * satisfied by a header that rendered nothing at all.
   */
  it('offers no workspace control, even for an active session with a workspace', () => {
    renderHeader({ sessionState: 'active' });
    expect(screen.queryByLabelText('Open the full workspace view')).not.toBeInTheDocument();
    expect(screen.getByLabelText(DETAILS_CONTROL)).toBeInTheDocument();
  });

  it('shows the Complete control when the task is eligible', () => {
    renderHeader({ taskEmbed: makeTaskEmbed({ status: 'running' }) });
    expect(screen.getByLabelText('Mark this task complete')).toBeInTheDocument();
  });

  it('hides the Complete control when the task is completed', () => {
    renderHeader({ taskEmbed: makeTaskEmbed({ status: 'completed' }) });
    expect(screen.queryByLabelText('Mark this task complete')).not.toBeInTheDocument();
    expect(screen.getByLabelText(DETAILS_CONTROL)).toBeInTheDocument();
  });

  it('hides the Complete control when the task failed', () => {
    renderHeader({ taskEmbed: makeTaskEmbed({ status: 'failed' }) });
    expect(screen.queryByLabelText('Mark this task complete')).not.toBeInTheDocument();
    expect(screen.getByLabelText(DETAILS_CONTROL)).toBeInTheDocument();
  });

  it('renders a mark-complete error outside the details panel', () => {
    renderHeader({ completeError: 'API error', onDismissCompleteError: vi.fn() });
    // Visible with the panel COLLAPSED — the action that produces this error is in the
    // rail now, so the user has no reason to have details open when it fails.
    expect(screen.queryByText('References')).not.toBeInTheDocument();
    expect(screen.getByText('API error')).toBeInTheDocument();
  });

  it('dismisses the mark-complete error', () => {
    const onDismissCompleteError = vi.fn();
    renderHeader({ completeError: 'API error', onDismissCompleteError });
    fireEvent.click(screen.getByText('Dismiss'));
    expect(onDismissCompleteError).toHaveBeenCalledTimes(1);
  });

  it('shows branch name in expanded details', () => {
    renderHeader({ taskEmbed: makeTaskEmbed({ outputBranch: 'sam/feature-xyz' }) });
    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));
    expect(screen.getByText('sam/feature-xyz')).toBeInTheDocument();
  });

  it('shows node name with health status', () => {
    renderHeader({ node: makeNode({ name: 'node-alpha', healthStatus: 'healthy' }) });
    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));
    expect(screen.getByText('node-alpha')).toBeInTheDocument();
    expect(screen.getByText('(healthy)')).toBeInTheDocument();
  });

  it('shows provider with location', () => {
    renderHeader({
      node: makeNode({ cloudProvider: 'hetzner' }),
      workspace: makeWorkspace({ vmLocation: 'nbg1' }),
    });
    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));
    expect(screen.getByText('Hetzner')).toBeInTheDocument();
    expect(screen.getByText(/nbg1/)).toBeInTheDocument();
  });

  it('shows loading spinner when loading prop is true', () => {
    renderHeader({ loading: true });
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });

  it('shows idle countdown when session is idle', () => {
    renderHeader({ sessionState: 'idle', idleCountdownMs: 600000 });
    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));
    expect(screen.getByText(/Cleanup in/)).toBeInTheDocument();
  });

  it('shows View PR link when task has PR URL', () => {
    renderHeader({ taskEmbed: makeTaskEmbed({ outputPrUrl: 'https://github.com/test/pr/1' }) });
    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));
    expect(screen.getByText('View PR')).toBeInTheDocument();
  });

  it('shows the public ports switch when detected ports are present', () => {
    renderHeader({
      workspace: makeWorkspace({ portsPublicEnabled: false }),
      detectedPorts: [
        {
          port: 5173,
          address: '127.0.0.1',
          label: 'Vite',
          url: 'https://ws-ws-1--5173.workspaces.example.com',
          detectedAt: '2026-06-01T00:00:00Z',
        },
      ],
    });

    expect(screen.getByText('Public ports')).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: 'Enable public forwarded ports' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Forwarded port URLs require a SAM access token.')).toBeInTheDocument();
  });

  it('toggles public ports through the workspace API', async () => {
    const { props } = renderHeader({
      workspace: makeWorkspace({ portsPublicEnabled: false }),
      detectedPorts: [
        {
          port: 5173,
          address: '127.0.0.1',
          label: 'Vite',
          url: 'https://ws-ws-1--5173.workspaces.example.com',
          detectedAt: '2026-06-01T00:00:00Z',
        },
      ],
    });

    fireEvent.click(screen.getByRole('switch', { name: 'Enable public forwarded ports' }));

    await waitFor(() => {
      expect(mocks.updateWorkspacePortsPublic).toHaveBeenCalledWith('ws-1', true);
      expect(props.onSessionMutated).toHaveBeenCalled();
    });
    expect(screen.getByRole('switch', { name: 'Disable public forwarded ports' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('rolls back the public ports switch when the API fails', async () => {
    mocks.updateWorkspacePortsPublic.mockRejectedValueOnce(new Error('Nope'));
    renderHeader({
      workspace: makeWorkspace({ portsPublicEnabled: false }),
      detectedPorts: [
        {
          port: 5173,
          address: '127.0.0.1',
          label: 'Vite',
          url: 'https://ws-ws-1--5173.workspaces.example.com',
          detectedAt: '2026-06-01T00:00:00Z',
        },
      ],
    });

    fireEvent.click(screen.getByRole('switch', { name: 'Enable public forwarded ports' }));

    await waitFor(() => {
      expect(screen.getByText('Nope')).toBeInTheDocument();
    });
    expect(screen.getByRole('switch', { name: 'Enable public forwarded ports' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  // --- CopyableId and Reference IDs ---

  it('shows References section with session ID when expanded', () => {
    renderHeader();
    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));
    expect(screen.getByText('References')).toBeInTheDocument();
    // Session ID is always present — look for the truncated display
    expect(screen.getByTitle(/Session: sess-abc123/)).toBeInTheDocument();
  });

  it('shows task ID pill when task embed is present', () => {
    renderHeader({ taskEmbed: makeTaskEmbed({ id: 'task-xyz789' }) });
    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));
    expect(screen.getByTitle(/Task: task-xyz789/)).toBeInTheDocument();
  });

  it('shows workspace ID pill when workspace is linked', () => {
    renderHeader({ session: makeSession({ workspaceId: 'ws-deadbeef' }) });
    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));
    expect(screen.getByTitle(/Workspace: ws-deadbeef/)).toBeInTheDocument();
  });

  it('shows ACP session ID pill when agent session is linked', () => {
    renderHeader({ session: makeSession({ agentSessionId: 'acp-session-42' }) });
    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));
    expect(screen.getByTitle(/ACP: acp-session-42/)).toBeInTheDocument();
  });

  it('shows source context for forked or retried sessions when expanded', () => {
    renderHeader({
      sourceContext: {
        lineageText: '⑂ from Parent session',
        parentTaskId: 'parent-task-123',
        parentSessionId: 'parent-session-456',
        parentTitle: 'Parent session with useful context',
      },
    });

    expect(screen.queryByText('Source')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));

    expect(screen.getByText('Source')).toBeInTheDocument();
    expect(screen.getByText('Parent session with useful context')).toBeInTheDocument();
    expect(screen.getByText('⑂ from Parent session')).toBeInTheDocument();
    expect(screen.getByTitle(/Parent task: parent-task-123/)).toBeInTheDocument();
    expect(screen.getByTitle(/Parent session: parent-session-456/)).toBeInTheDocument();
  });

  it('does not show source context for ordinary sessions', () => {
    renderHeader();
    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));
    expect(screen.queryByText('Source')).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Parent task:/)).not.toBeInTheDocument();
  });

  it('copies value to clipboard and shows checkmark when CopyableId is clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderHeader();
    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));

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
    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));
    expect(screen.getByText('Provisioning node')).toBeInTheDocument();
  });

  it('does not show execution step when task is completed', () => {
    renderHeader({
      taskEmbed: makeTaskEmbed({ status: 'completed', executionStep: 'agent_session' }),
    });
    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));
    expect(screen.queryByText('Agent running')).not.toBeInTheDocument();
  });

  it('shows task status badge with formatted text', () => {
    renderHeader({
      taskEmbed: makeTaskEmbed({ status: 'in_progress' }),
    });
    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));
    expect(screen.getByText('In progress')).toBeInTheDocument();
  });

  it('shows completed status badge with check icon', () => {
    renderHeader({
      taskEmbed: makeTaskEmbed({ status: 'completed' }),
    });
    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));
    const badge = screen.getByText('Completed');
    expect(badge).toBeInTheDocument();
    // Check icon is within the badge
    expect(
      badge.closest('span')?.querySelector('[data-testid="icon-check-circle"]')
    ).toBeInTheDocument();
  });

  // --- Session timing ---

  it('shows session start time when startedAt is set', () => {
    const startedAt = new Date('2026-04-24T10:30:00Z').getTime();
    renderHeader({ session: makeSession({ startedAt }) });
    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));
    // The formatted time should contain Apr 24
    expect(screen.getByText(/Apr 24/)).toBeInTheDocument();
  });

  it('shows duration for completed sessions', () => {
    const startedAt = new Date('2026-04-24T10:00:00Z').getTime();
    const endedAt = new Date('2026-04-24T10:15:00Z').getTime();
    renderHeader({ session: makeSession({ startedAt, endedAt }) });
    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));
    expect(screen.getByText('15m')).toBeInTheDocument();
  });

  it('shows running indicator for active sessions with timing', () => {
    const startedAt = Date.now() - 60_000; // 1 minute ago
    renderHeader({
      session: makeSession({ startedAt }),
      taskEmbed: null,
      workspace: null,
    });
    fireEvent.click(screen.getByLabelText(DETAILS_CONTROL));
    expect(screen.getByText('(running)')).toBeInTheDocument();
  });

  // --- Retry and Fork buttons ---

  // Retry/Fork moved from unlabeled title-row icons into the rail. Their visibility
  // matrix is covered in `tests/unit/RetryForkButtons.test.tsx`; this pair just pins
  // that the header itself no longer renders them.
  it('no longer renders retry/fork icons in the title row', () => {
    const { container } = renderHeader({ session: makeSession({ taskId: 'task-1' }) });
    const header = container.firstElementChild as HTMLElement;
    expect(header.querySelector('[aria-label="Retry task"]')).toBeNull();
    expect(header.querySelector('[aria-label="Fork session"]')).toBeNull();
    // Liveness: the header rendered its title, so the absences above are real.
    expect(screen.getByText('Test Session')).toBeInTheDocument();
  });

  describe('hasContentBelow prop', () => {
    it('includes bottom rounding and green glow when hasContentBelow is false (default)', () => {
      const { container } = renderHeader();
      const outer = container.firstElementChild as HTMLElement;
      expect(outer.className).toContain('rounded-b-2xl');
      expect(outer.className).toContain('after:');
    });

    it('suppresses bottom rounding and green glow when hasContentBelow is true', () => {
      const { container } = renderHeader({ hasContentBelow: true });
      const outer = container.firstElementChild as HTMLElement;
      expect(outer.className).not.toContain('rounded-b-2xl');
      expect(outer.className).not.toContain('after:');
    });
  });
});
