/**
 * Behavioural tests for the chat's linked work, against the REAL `ProjectMessageView`.
 *
 * Every case here reaches the feature the way a user does: it clicks the rail's Related
 * button, not a state setter, and reads the header chip out of the rendered header rather than
 * out of the hook (`.claude/rules/62-tests-must-observe-the-real-trigger.md`). The wake-progress
 * incident that rule records was a feature found dead four times because every test hand-fed
 * the value it asserted on.
 */
import type { SessionContext } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectMessageView } from '../../../../src/components/project-message-view';

// ---------------------------------------------------------------------------
// Mocks — the chat shell's dependencies, plus the one endpoint under test.
// ---------------------------------------------------------------------------

const mockGetSessionLinks = vi.fn();
const mockGetChatSession = vi.fn();
const mockGetWorkspace = vi.fn();
const mockGetNode = vi.fn();

vi.mock('../../../../src/lib/api/links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/api/links')>()),
  getSessionLinks: (...args: unknown[]) => mockGetSessionLinks(...args),
}));

vi.mock('../../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/api')>()),
  getChatSession: (...args: unknown[]) => mockGetChatSession(...args),
  getWorkspace: (...args: unknown[]) => mockGetWorkspace(...args),
  getNode: (...args: unknown[]) => mockGetNode(...args),
  getTerminalToken: vi.fn().mockResolvedValue({ token: 'test-token' }),
  resetIdleTimer: vi.fn().mockResolvedValue({ cleanupAt: Date.now() + 1_800_000 }),
  sendFollowUpPrompt: vi.fn(),
  cancelAgentPrompt: vi.fn(),
  resumeChatSessionAgent: vi.fn(),
  updateProjectTaskStatus: vi.fn(),
  deleteWorkspace: vi.fn(),
  saveCachedCommands: vi.fn().mockResolvedValue({ cached: 0 }),
  getTranscribeApiUrl: () => 'https://api.example.com/transcribe',
  getTtsApiUrl: () => 'https://api.example.com/tts',
}));

vi.mock('../../../../src/lib/api/comments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/api/comments')>()),
  listMessageComments: vi.fn().mockResolvedValue({ comments: [] }),
}));

vi.mock('../../../../src/components/AuthProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/components/AuthProvider')>()),
  useAuth: () => ({ user: { id: 'user-1' }, isSuperadmin: false, isLoading: false }),
}));

vi.mock('../../../../src/hooks/useChatWebSocket', () => ({
  useChatWebSocket: () => ({
    connectionState: 'connected',
    wsRef: { current: null },
    retry: vi.fn(),
  }),
}));

vi.mock('../../../../src/hooks/useWorkspacePorts', () => ({
  useWorkspacePorts: () => ({ ports: [], loading: false }),
}));

vi.mock('../../../../src/lib/error-reporter', () => ({ reportError: vi.fn() }));

vi.mock('@simple-agent-manager/acp-client', () => ({
  useAcpSession: vi.fn(),
  useAcpMessages: vi.fn(),
  VoiceButton: () => null,
  MessageBubble: () => null,
  ToolCallCard: () => null,
  ThinkingBlock: () => null,
  PlanView: () => null,
  RawFallbackView: () => null,
  mapToolCallContent: vi.fn(),
  TypewriterText: ({ text }: { text: string }) => text,
  UserMessageFade: ({ text }: { text: string }) => text,
}));

vi.mock('react-virtuoso', () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => ReactNode;
  }) => (
    <div data-testid="virtuoso">
      {data?.map((item, index) => (
        <div key={index}>{itemContent(index, item)}</div>
      ))}
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-1';
const SESSION_ID = 'sess-1';
const PR_URL = 'https://github.com/owner/repo/pull/2425';

function cappedList<T>(
  items: T[],
  overrides: Partial<{ total: number; truncated: boolean; totalIsLowerBound: boolean }> = {}
) {
  return {
    items,
    total: overrides.total ?? items.length,
    truncated: overrides.truncated ?? false,
    totalIsLowerBound: overrides.totalIsLowerBound ?? false,
  };
}

function emptyContext(): SessionContext {
  return { ideas: cappedList([]), files: cappedList([]), pullRequests: cappedList([]) };
}

function richContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    ideas: cappedList([
      {
        ideaId: 'idea-1',
        title: 'Linked work program',
        status: 'draft',
        relations: ['works_on', 'read'],
      },
      {
        ideaId: 'idea-2',
        title: 'Ideas on the Account Map',
        status: 'draft',
        relations: ['created'],
      },
    ]),
    files: cappedList([
      {
        fileId: 'file-1',
        filename: 'report.md',
        directory: '/engineering/research',
        relations: ['uploaded'],
        bySessionId: SESSION_ID,
      },
    ]),
    pullRequests: cappedList(
      [
        {
          url: PR_URL,
          number: 2425,
          source: 'task_output' as const,
          bySessionId: SESSION_ID,
          state: null,
        },
      ],
      { total: 1, truncated: true, totalIsLowerBound: true }
    ),
    ...overrides,
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    status: 'active',
    topic: 'Show links on chats and library files',
    workspaceId: 'ws-1',
    agentSessionId: 'agent-1',
    taskId: 'task-1',
    isIdle: false,
    agentCompletedAt: null,
    cleanupAt: null,
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 60_000,
    endedAt: null,
    stoppedAt: null,
    messageCount: 1,
    isMine: true,
    viewerAccess: 'owner',
    task: {
      id: 'task-1',
      status: 'in_progress',
      title: 'Show links',
      outputBranch: 'sam/t4',
      outputPrUrl: PR_URL,
      errorMessage: null,
      outputSummary: null,
      taskMode: 'conversation',
    },
    ...overrides,
  };
}

function render(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
  return rtlRender(ui, { wrapper: Wrapper });
}

async function renderChat() {
  render(<ProjectMessageView projectId={PROJECT_ID} sessionId={SESSION_ID} />);
  // Liveness: the rail rendered, so the page did not crash. Without this every "is absent"
  // assertion below would also pass on a blank page.
  return screen.findByTestId('session-tool-related');
}

/** Opens the Related panel through the production control, never through state. */
async function openRelated() {
  fireEvent.click(await screen.findByTestId('session-tool-related'));
  return screen.findByTestId('session-linked-work-drawer');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetChatSession.mockResolvedValue({
    session: makeSession(),
    messages: [
      {
        id: 'msg-1',
        sessionId: SESSION_ID,
        role: 'user',
        content: 'Hello',
        toolMetadata: null,
        createdAt: Date.now() - 10_000,
      },
    ],
    hasMore: false,
  });
  mockGetWorkspace.mockResolvedValue({ id: 'ws-1', nodeId: 'node-1' });
  mockGetNode.mockResolvedValue({ id: 'node-1', name: 'test-node' });
  mockGetSessionLinks.mockResolvedValue(richContext());
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chat linked work — the Related panel', () => {
  it('reads the chat its own id, and lists each group with the relation in plain words', async () => {
    await renderChat();
    await waitFor(() => expect(mockGetSessionLinks).toHaveBeenCalled());
    // The canonical identifiers, not a broader heuristic.
    expect(mockGetSessionLinks.mock.calls[0]?.slice(0, 2)).toEqual([PROJECT_ID, SESSION_ID]);

    const drawer = await openRelated();
    expect(within(drawer).getByText('Linked work program')).toBeInTheDocument();
    expect(within(drawer).getByText('Working on · Read')).toBeInTheDocument();
    expect(within(drawer).getByText('Created')).toBeInTheDocument();
    expect(within(drawer).getByText('report.md')).toBeInTheDocument();
    expect(within(drawer).getByText('Uploaded · /engineering/research')).toBeInTheDocument();
    expect(within(drawer).getByText('Pull request #2425')).toBeInTheDocument();
  });

  it('points each row at the right destination', async () => {
    await renderChat();
    const drawer = await openRelated();

    expect(within(drawer).getAllByTestId('linked-work-idea')[0]).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/ideas/idea-1`
    );
    expect(within(drawer).getByTestId('linked-work-file')).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/library?preview=file-1`
    );
    const pr = within(drawer).getByTestId('linked-work-pr');
    expect(pr).toHaveAttribute('href', PR_URL);
    expect(pr).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('opens the panel without issuing a second read', async () => {
    await renderChat();
    await waitFor(() => expect(mockGetSessionLinks).toHaveBeenCalledTimes(1));
    await openRelated();
    // The header chip, the rail badge and the panel share one query entry.
    expect(mockGetSessionLinks).toHaveBeenCalledTimes(1);
  });

  it('renders "N+" when the server could only establish a minimum, and a plain count when not', async () => {
    await renderChat();
    const drawer = await openRelated();
    // Pull requests: total 1, flagged as a lower bound.
    expect(within(drawer).getByText('1+')).toBeInTheDocument();
    // Ideas: an exact 2.
    expect(within(drawer).getByText('2', { exact: true })).toBeInTheDocument();
    // And the rail badge totals all three the same way: 2 + 1 + 1.
    expect(screen.getByTestId('session-tool-related')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('4 or more items')
    );
  });

  it('renders a plain count on the rail when nothing is bounded', async () => {
    // The discriminating half of the pair: with no lower bound the badge must NOT say "or more".
    mockGetSessionLinks.mockResolvedValue({
      ...richContext(),
      pullRequests: cappedList([], { total: 0 }),
    });
    await renderChat();
    await waitFor(() =>
      expect(screen.getByTestId('session-tool-related')).toHaveAttribute(
        'aria-label',
        expect.stringContaining('3 items')
      )
    );
    expect(screen.getByTestId('session-tool-related').getAttribute('aria-label')).not.toContain(
      'or more'
    );
  });

  it('explains what links are when nothing is linked', async () => {
    mockGetSessionLinks.mockResolvedValue(emptyContext());
    await renderChat();
    const drawer = await openRelated();

    expect(within(drawer).getByTestId('linked-work-empty')).toBeInTheDocument();
    expect(within(drawer).getByText('Nothing related yet')).toBeInTheDocument();
    // Paired absence assertions: no rows, and no badge on the rail.
    expect(within(drawer).queryByTestId('linked-work-idea')).toBeNull();
    expect(screen.getByTestId('session-tool-related').textContent).not.toMatch(/\d/);
  });

  it('offers a retry when the read fails, and leaves the conversation alone', async () => {
    mockGetSessionLinks.mockRejectedValue(new Error('boom'));
    await renderChat();
    const drawer = await openRelated();

    const retry = within(drawer).getByRole('button', { name: 'Try again' });
    expect(retry).toBeInTheDocument();
    // Liveness: the chat itself still rendered.
    expect(screen.getByTestId('session-floating-header')).toBeInTheDocument();

    mockGetSessionLinks.mockResolvedValue(richContext());
    fireEvent.click(retry);
    expect(await within(drawer).findByText('Linked work program')).toBeInTheDocument();
  });
});

describe('chat linked work — the header', () => {
  it('names the idea the chat works on and opens it', async () => {
    await renderChat();
    const chip = await screen.findByTestId('session-working-on-chip');
    expect(chip).toHaveTextContent('Working on');
    expect(chip).toHaveTextContent('Linked work program');
    expect(chip).toHaveAttribute('href', `/projects/${PROJECT_ID}/ideas/idea-1`);
  });

  it('says "Discussing" when the chat only discussed the idea', async () => {
    mockGetSessionLinks.mockResolvedValue({
      ...emptyContext(),
      ideas: cappedList([
        {
          ideaId: 'idea-9',
          title: 'Something mentioned',
          status: 'draft',
          relations: ['discusses'],
        },
      ]),
    });
    await renderChat();
    const chip = await screen.findByTestId('session-working-on-chip');
    expect(chip).toHaveTextContent('Discussing');
    expect(chip).toHaveTextContent('Something mentioned');
  });

  it('prefers the idea it works on over one it only discussed', async () => {
    // Both relations present at once — without this case the precedence in `pickWorkingOn`
    // is unobservable, and reversing it leaves every other test green.
    mockGetSessionLinks.mockResolvedValue({
      ...emptyContext(),
      ideas: cappedList([
        { ideaId: 'idea-chat', title: 'Only discussed', status: 'draft', relations: ['discusses'] },
        { ideaId: 'idea-work', title: 'The real work', status: 'draft', relations: ['works_on'] },
      ]),
    });
    await renderChat();
    const chip = await screen.findByTestId('session-working-on-chip');
    expect(chip).toHaveTextContent('Working on');
    expect(chip).toHaveTextContent('The real work');
    expect(chip).not.toHaveTextContent('Only discussed');
    expect(chip).toHaveAttribute('href', `/projects/${PROJECT_ID}/ideas/idea-work`);
  });

  it('shows no chip for an idea the chat merely read', async () => {
    mockGetSessionLinks.mockResolvedValue({
      ...emptyContext(),
      ideas: cappedList([
        { ideaId: 'idea-8', title: 'Only read', status: 'draft', relations: ['read'] },
      ]),
    });
    await renderChat();
    // Positive control for the absence: the panel still lists the idea, so the data arrived.
    const drawer = await openRelated();
    expect(within(drawer).getByText('Only read')).toBeInTheDocument();
    expect(screen.queryByTestId('session-working-on-chip')).toBeNull();
  });

  it('shows the pull request with no state pill until SAM has recorded one', async () => {
    await renderChat();
    fireEvent.click(await screen.findByTestId('session-tool-details'));

    const viewPr = await screen.findByTestId('session-view-pr');
    expect(viewPr).toHaveTextContent('View PR #2425');
    expect(viewPr).toHaveAttribute('href', PR_URL);
    // The pre-PR-tracking shape: a link, and no claim about its state.
    expect(screen.queryByTestId('pr-state-badge')).toBeNull();
  });

  it('shows the state and checks once they arrive, with no other change', async () => {
    mockGetSessionLinks.mockResolvedValue({
      ...richContext(),
      pullRequests: cappedList([
        {
          url: PR_URL,
          number: 2425,
          source: 'task_output' as const,
          bySessionId: SESSION_ID,
          state: {
            state: 'merged' as const,
            isDraft: false,
            title: 'feat: linked work',
            checksState: 'success' as const,
            mergedAt: '2026-10-24T00:00:00Z',
            updatedAt: '2026-10-24T00:00:00Z',
            stale: false,
          },
        },
      ]),
    });
    await renderChat();
    fireEvent.click(await screen.findByTestId('session-tool-details'));

    expect(await screen.findByTestId('session-view-pr')).toHaveTextContent('View PR #2425');
    const badge = (await screen.findAllByTestId('pr-state-badge'))[0];
    expect(badge).toHaveTextContent('Merged');
    expect(badge).toHaveAttribute('data-state', 'merged');
    expect(screen.getAllByTestId('pr-checks-state')[0]).toHaveTextContent('Checks passed');
  });

  it('keeps the link for a pull request URL it cannot parse, with no invented number', async () => {
    // A GitLab merge request, or a pull request on another host. Dropping the link here would
    // hide work the header used to show.
    mockGetChatSession.mockResolvedValue({
      session: makeSession({
        task: {
          ...makeSession().task,
          outputPrUrl: 'https://gitlab.com/owner/repo/-/merge_requests/7',
        },
      }),
      messages: [],
      hasMore: false,
    });
    mockGetSessionLinks.mockResolvedValue(emptyContext());
    await renderChat();
    fireEvent.click(await screen.findByTestId('session-tool-details'));

    const viewPr = await screen.findByTestId('session-view-pr');
    expect(viewPr).toHaveTextContent('View PR');
    expect(viewPr).not.toHaveTextContent('#');
    expect(viewPr).toHaveAttribute('href', 'https://gitlab.com/owner/repo/-/merge_requests/7');
  });

  it('refuses to make a javascript: pull-request URL a live link', async () => {
    // `tasks.output_pr_url` is agent-reported. The server canonicalises explicit links, but a
    // stored hostile value must not become an href on the way out.
    mockGetChatSession.mockResolvedValue({
      session: makeSession({
        // eslint-disable-next-line no-script-url -- the hostile value is the fixture
        task: { ...makeSession().task, outputPrUrl: 'javascript:alert(document.cookie)' },
      }),
      messages: [],
      hasMore: false,
    });
    mockGetSessionLinks.mockResolvedValue(emptyContext());
    await renderChat();
    fireEvent.click(await screen.findByTestId('session-tool-details'));

    const viewPr = await screen.findByTestId('session-view-pr');
    expect(viewPr).toHaveAttribute('href', '#');
  });

  it('refuses to make a javascript: linked pull request a live row', async () => {
    mockGetSessionLinks.mockResolvedValue({
      ...emptyContext(),
      pullRequests: cappedList([
        {
          // eslint-disable-next-line no-script-url -- the hostile value is the fixture
          url: 'javascript:alert(1)',
          number: 9,
          source: 'explicit_link' as const,
          bySessionId: SESSION_ID,
          state: null,
        },
      ]),
    });
    await renderChat();
    const drawer = await openRelated();
    expect(within(drawer).getByTestId('linked-work-pr')).toHaveAttribute('href', '#');
  });

  it('falls back to a pull request only the link store knows about', async () => {
    mockGetChatSession.mockResolvedValue({
      session: makeSession({ task: { ...makeSession().task, outputPrUrl: null } }),
      messages: [],
      hasMore: false,
    });
    await renderChat();
    fireEvent.click(await screen.findByTestId('session-tool-details'));
    expect(await screen.findByTestId('session-view-pr')).toHaveTextContent('View PR #2425');
  });
});
