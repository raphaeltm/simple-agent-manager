/**
 * Switching between chats, driven the way a user does it: a click on a chat in the
 * real session list, through the real router, into the real chat view reading the
 * real query cache. Only the network and the sockets are faked.
 *
 * Every response a switch waits on is a deferred promise, so each test can stop at
 * the point where the switch has happened but the network has not answered — the
 * point the user was complaining about (`.claude/rules/62`).
 *
 * `CommitProbe` records what the DOM showed at every commit the router drives. A
 * switch that paints the previous chat for even one frame is visible to it, where
 * an assertion after `waitFor` would only see the settled screen.
 */
import { DEFAULT_CHAT_SESSION_MESSAGE_LIMIT } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { type ReactNode, useLayoutEffect } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listAgentProfiles: vi.fn(),
  listSkills: vi.fn(),
  listChatSessions: vi.fn(),
  listCredentials: vi.fn(),
  getTrialStatus: vi.fn(),
  getProviderCatalog: vi.fn(),
  listProjectTasks: vi.fn(),
  getChatSession: vi.fn(),
  getReportIssueConfig: vi.fn(),
  listMessageComments: vi.fn(),
  sendFollowUpPrompt: vi.fn(),
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'user@example.com', name: 'Test User' } }),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listAgents: mocks.listAgents,
  listAgentProfiles: mocks.listAgentProfiles,
  listSkills: mocks.listSkills,
  listChatSessions: mocks.listChatSessions,
  listCredentials: mocks.listCredentials,
  getTrialStatus: mocks.getTrialStatus,
  getProviderCatalog: mocks.getProviderCatalog,
  listProjectTasks: mocks.listProjectTasks,
  getChatSession: mocks.getChatSession,
  getReportIssueConfig: mocks.getReportIssueConfig,
  sendFollowUpPrompt: mocks.sendFollowUpPrompt,
  getTranscribeApiUrl: () => 'https://api.test/api/transcribe',
}));

vi.mock('../../../src/lib/api/comments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/comments')>()),
  listMessageComments: mocks.listMessageComments,
}));

vi.mock('../../../src/hooks/useChatWebSocket', () => ({
  useChatWebSocket: () => ({
    connectionState: 'connected',
    wsRef: { current: null },
    retry: vi.fn(),
  }),
}));

vi.mock('../../../src/hooks/useProjectWebSocket', () => ({
  useProjectWebSocket: () => ({ connectionState: 'connected' }),
}));

vi.mock('../../../src/hooks/useAvailableCommands', () => ({
  useAvailableCommands: () => ({ commands: [], isLoading: false, persistCommands: vi.fn() }),
}));

vi.mock('@simple-agent-manager/acp-client', async (importActual) => ({
  ...(await importActual<typeof import('@simple-agent-manager/acp-client')>()),
  VoiceButton: () => null,
  MentionPalette: () => null,
  SlashCommandPalette: () => null,
  MessageBubble: ({ text }: { text: string }) => <div>{text}</div>,
  TypewriterText: ({ text }: { text: string }) => <span>{text}</span>,
}));

vi.mock('react-virtuoso', async () => {
  const { createVirtuosoModuleMock } = await import('../../helpers/virtuoso-mock');
  return createVirtuosoModuleMock();
});

import { ProjectChat } from '../../../src/pages/project-chat';
import { ProjectContext, type ProjectContextValue } from '../../../src/pages/ProjectContext';

const PROJECT_ID = 'proj-switch';
const REPORT_TOOL = 'Report an issue with this session';

function chatSession(id: string, topic: string) {
  return {
    id,
    workspaceId: null,
    topic,
    status: 'active',
    messageCount: 2,
    startedAt: Date.now() - 60_000,
    endedAt: null,
    createdAt: Date.now() - 60_000,
  };
}

const ALPHA = chatSession('sess-alpha', 'Alpha: refactor the parser');
const BRAVO = chatSession('sess-bravo', 'Bravo: fix the flaky test');
const CHARLIE = chatSession('sess-charlie', 'Charlie: write the docs');

/**
 * A persisted user message. User rows each render as their own bubble; assistant
 * rows are streaming chunks that merge into one, which would hide which row a
 * test is looking for.
 */
function row(id: string, sessionId: string, content: string, createdAt: number) {
  return {
    id,
    sessionId,
    role: 'user',
    content,
    toolMetadata: null,
    createdAt,
    sequence: createdAt,
  };
}

function detail(session: ReturnType<typeof chatSession>, messages: ReturnType<typeof row>[]) {
  return {
    session,
    messages,
    hasMore: false,
    state: {
      activity: 'idle',
      activityAt: 1,
      statusError: null,
      currentPlan: null,
      planUpdatedAt: null,
      promptStartedAt: null,
      agentType: null,
      lastStopReason: null,
    },
  };
}

const ALPHA_TRANSCRIPT = detail(ALPHA, [row('a1', ALPHA.id, 'Alpha answer one', 1_000)]);
const BRAVO_TRANSCRIPT = detail(BRAVO, [row('b1', BRAVO.id, 'Bravo cached answer', 2_000)]);

type Transcript = ReturnType<typeof detail>;
type Deferred<T> = ReturnType<typeof deferred<T>>;

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Frame {
  header: string;
  conversation: string;
  reportTool: boolean;
  /** The chat's own loading indicator, shown until an uncached chat's first page arrives. */
  loading: boolean;
}

/** Everything the chat pane showed, captured at each commit the router drives. */
const frames: Frame[] = [];

function CommitProbe() {
  // Subscribing to the location re-renders the probe in the same commit as every
  // navigation, so its layout effect sees exactly what that commit painted.
  useLocation();
  useLayoutEffect(() => {
    frames.push({
      header: document.querySelector('[data-testid="session-header"]')?.textContent ?? '',
      conversation: document.querySelector('[role="log"]')?.textContent ?? '',
      reportTool: document.querySelector(`[aria-label="${REPORT_TOOL}"]`) !== null,
      loading: document.querySelector('[data-testid="chat-loading"]') !== null,
    });
  });
  return null;
}

/**
 * Production's freshness window (`lib/query-client.ts`), so a just-cached chat is
 * as fresh as it is for a user switching back to it within 15 s. The default
 * `gcTime` of 0 stands in for TanStack's 5-minute default: only a query that sets
 * its own `gcTime` survives being left.
 */
function productionLikeClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 15_000, retry: false, gcTime: 0 } },
  });
}

function renderChat(client: QueryClient, sessionId: string) {
  const project: ProjectContextValue = {
    projectId: PROJECT_ID,
    project: null,
    installations: [],
    reload: vi.fn(),
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(
    <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}/chat/${sessionId}`]}>
      <ProjectContext.Provider value={project}>
        <Routes>
          <Route
            path="/projects/:id/chat/:sessionId"
            element={
              <>
                <ProjectChat />
                <CommitProbe />
              </>
            }
          />
        </Routes>
      </ProjectContext.Provider>
    </MemoryRouter>,
    { wrapper }
  );
}

/** Selects a chat the way a user does: a click on its row in the session list. */
function selectChat(topic: string) {
  const rows = screen.getAllByText(topic);
  const inList = rows.find((element) => element.closest('[data-testid="session-header"]') === null);
  fireEvent.click(inList!);
}

function framesSince(start: number): Frame[] {
  return frames.slice(start);
}

/** Lets TanStack's `setTimeout(0)` garbage collection run for queries nobody observes. */
async function flushGarbageCollection() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

describe('Project chat — switching between chats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    frames.length = 0;
    mocks.listAgents.mockResolvedValue({
      agents: [{ id: 'claude-code', name: 'Claude Code', configured: true, supportsAcp: true }],
    });
    mocks.listAgentProfiles.mockResolvedValue([]);
    mocks.listSkills.mockResolvedValue([]);
    mocks.listCredentials.mockResolvedValue([]);
    mocks.getTrialStatus.mockResolvedValue({ available: false });
    mocks.getProviderCatalog.mockResolvedValue({ catalogs: [] });
    mocks.listProjectTasks.mockResolvedValue({ tasks: [], nextCursor: null });
    mocks.listChatSessions.mockResolvedValue({ sessions: [ALPHA, BRAVO, CHARLIE], total: 3 });
    mocks.getReportIssueConfig.mockResolvedValue({ enabled: true });
    mocks.listMessageComments.mockResolvedValue({ comments: [] });
  });

  it('paints a chat visited earlier from cache in the switching commit, then shows what arrived meanwhile', async () => {
    const client = productionLikeClient();
    let bravoRefresh: Deferred<Transcript> | null = null;
    mocks.getChatSession.mockImplementation(
      async (_projectId: string, sessionId: string, params: { after?: string }) => {
        if (sessionId === ALPHA.id) return ALPHA_TRANSCRIPT;
        return params.after && bravoRefresh ? bravoRefresh.promise : BRAVO_TRANSCRIPT;
      }
    );

    // Bravo was open earlier; the user moved on to Alpha a while ago.
    renderChat(client, BRAVO.id);
    await screen.findByText('Bravo cached answer');
    selectChat(ALPHA.topic);
    await screen.findByText('Alpha answer one');
    // Bravo has no observer now. Under the client's default gcTime this is the
    // moment it would be collected; the transcript's own retention must keep it.
    await flushGarbageCollection();

    bravoRefresh = deferred<Transcript>();
    const start = frames.length;
    selectChat(BRAVO.topic);

    // The very commit that switched: Bravo's header and cached transcript, and
    // nothing of Alpha — while Bravo's refresh has not answered yet.
    const [switched] = framesSince(start);
    expect(switched).toBeDefined();
    expect(switched!.header).toContain(BRAVO.topic);
    expect(switched!.header).not.toContain(ALPHA.topic);
    expect(switched!.conversation).toContain('Bravo cached answer');
    expect(switched!.conversation).not.toContain('Alpha answer one');
    expect(screen.queryByText('Alpha answer one')).not.toBeInTheDocument();

    // The cached copy is reconciled in the background, asking only for rows
    // newer than its newest row — even though it is well inside staleTime.
    await waitFor(() =>
      expect(mocks.getChatSession).toHaveBeenCalledWith(
        PROJECT_ID,
        BRAVO.id,
        expect.objectContaining({ after: '[2000,2000,"b1"]' })
      )
    );
    expect(screen.getByText('Bravo cached answer')).toBeInTheDocument();

    const refresh = bravoRefresh as Deferred<Transcript>;
    await act(async () => {
      refresh.resolve(
        detail(BRAVO, [row('b2', BRAVO.id, 'Bravo written while you were away', 3_000)])
      );
      await refresh.promise;
    });
    expect(await screen.findByText('Bravo written while you were away')).toBeInTheDocument();
    expect(screen.getByText('Bravo cached answer')).toBeInTheDocument();
    for (const frame of framesSince(start)) {
      expect(frame.conversation).not.toContain('Alpha answer one');
    }
  });

  it('never shows the previous chat while an uncached chat loads its newest page', async () => {
    const client = productionLikeClient();
    const charlieLoad = deferred<Transcript>();
    mocks.getChatSession.mockImplementation(async (_projectId: string, sessionId: string) =>
      sessionId === CHARLIE.id ? charlieLoad.promise : ALPHA_TRANSCRIPT
    );

    renderChat(client, ALPHA.id);
    await screen.findByText('Alpha answer one');

    const start = frames.length;
    selectChat(CHARLIE.topic);

    const [switched] = framesSince(start);
    expect(switched!.header).toBe('');
    expect(switched!.conversation).toBe('');
    // Not a blank pane: the chat's own loading indicator is what the switch painted.
    expect(switched!.loading).toBe(true);
    expect(screen.queryByText('Alpha answer one')).not.toBeInTheDocument();
    // The cold open asks for one newest page, not the whole conversation.
    await waitFor(() =>
      expect(mocks.getChatSession).toHaveBeenCalledWith(PROJECT_ID, CHARLIE.id, {
        signal: expect.any(AbortSignal),
        limit: DEFAULT_CHAT_SESSION_MESSAGE_LIMIT,
      })
    );

    await act(async () => {
      charlieLoad.resolve(detail(CHARLIE, [row('c1', CHARLIE.id, 'Charlie answer one', 4_000)]));
      await charlieLoad.promise;
    });
    expect(await screen.findByText('Charlie answer one')).toBeInTheDocument();
    const header = screen.getByTestId('session-header');
    expect(within(header).getByText(CHARLIE.topic)).toBeInTheDocument();
    for (const frame of framesSince(start)) {
      expect(frame.header).not.toContain(ALPHA.topic);
      expect(frame.conversation).not.toContain('Alpha answer one');
    }
  });

  it('shows why an uncached chat failed to load, and never the previous chat', async () => {
    const client = productionLikeClient();
    mocks.getChatSession.mockImplementation(async (_projectId: string, sessionId: string) => {
      if (sessionId === CHARLIE.id) throw new Error('Session store unavailable');
      return ALPHA_TRANSCRIPT;
    });

    renderChat(client, ALPHA.id);
    await screen.findByText('Alpha answer one');

    const start = frames.length;
    selectChat(CHARLIE.topic);

    expect(await screen.findByText('Session store unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Alpha answer one')).not.toBeInTheDocument();
    for (const frame of framesSince(start)) {
      expect(frame.header).not.toContain(ALPHA.topic);
      expect(frame.conversation).not.toContain('Alpha answer one');
    }
    // The failure is confined to that chat: the previous one still opens.
    selectChat(ALPHA.topic);
    expect(await screen.findByText('Alpha answer one')).toBeInTheDocument();
    expect(screen.queryByText('Session store unavailable')).not.toBeInTheDocument();
  });

  it('never offers a message still on its way again, and its delivery keeps a newer draft', async () => {
    const client = productionLikeClient();
    mocks.getChatSession.mockImplementation(async (_projectId: string, sessionId: string) =>
      sessionId === BRAVO.id ? BRAVO_TRANSCRIPT : ALPHA_TRANSCRIPT
    );
    const delivery = deferred<void>();
    mocks.sendFollowUpPrompt.mockReturnValue(delivery.promise);
    const composer = () => screen.getByPlaceholderText('Send a message...');

    renderChat(client, ALPHA.id);
    await screen.findByText('Alpha answer one');
    fireEvent.change(composer(), { target: { value: 'Run the migration now' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() =>
      expect(mocks.sendFollowUpPrompt).toHaveBeenCalledWith(
        PROJECT_ID,
        ALPHA.id,
        'Run the migration now'
      )
    );

    selectChat(BRAVO.topic);
    await screen.findByText('Bravo cached answer');
    selectChat(ALPHA.topic);
    await screen.findByText('Alpha answer one');
    // The message is in the conversation, on its way; the composer does not offer
    // it to send a second time.
    expect(screen.getByRole('log', { name: 'Conversation' })).toHaveTextContent(
      'Run the migration now'
    );
    expect(composer()).toHaveValue('');

    fireEvent.change(composer(), { target: { value: 'Then tidy up the old tables' } });
    await act(async () => {
      delivery.resolve();
      await delivery.promise;
    });
    // The delivery belongs to the view that sent it, which is gone; this view's
    // own text is untouched either way.
    expect(composer()).toHaveValue('Then tidy up the old tables');

    // Load-bearing: only a fresh view reads the saved draft, which a delivery that
    // cleared unconditionally would have deleted.
    selectChat(BRAVO.topic);
    await screen.findByText('Bravo cached answer');
    selectChat(ALPHA.topic);
    await screen.findByText('Alpha answer one');
    expect(composer()).toHaveValue('Then tidy up the old tables');
  });

  it('keeps a message whose send failed while the user was away, ready to retry', async () => {
    const client = productionLikeClient();
    mocks.getChatSession.mockImplementation(async (_projectId: string, sessionId: string) =>
      sessionId === BRAVO.id ? BRAVO_TRANSCRIPT : ALPHA_TRANSCRIPT
    );
    const delivery = deferred<void>();
    mocks.sendFollowUpPrompt.mockReturnValue(delivery.promise);
    const composer = () => screen.getByPlaceholderText('Send a message...');

    renderChat(client, ALPHA.id);
    await screen.findByText('Alpha answer one');
    fireEvent.change(composer(), { target: { value: 'Deploy the fix' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(mocks.sendFollowUpPrompt).toHaveBeenCalled());

    selectChat(BRAVO.topic);
    await screen.findByText('Bravo cached answer');
    await act(async () => {
      delivery.reject(new Error('agent unreachable'));
      await delivery.promise.catch(() => {});
    });

    selectChat(ALPHA.topic);
    await screen.findByText('Alpha answer one');
    expect(composer()).toHaveValue('Deploy the fix');
  });

  it("keeps each chat's unsent draft to itself across a switch", async () => {
    const client = productionLikeClient();
    mocks.getChatSession.mockImplementation(async (_projectId: string, sessionId: string) =>
      sessionId === BRAVO.id ? BRAVO_TRANSCRIPT : ALPHA_TRANSCRIPT
    );

    renderChat(client, ALPHA.id);
    await screen.findByText('Alpha answer one');
    fireEvent.change(screen.getByPlaceholderText('Send a message...'), {
      target: { value: 'half-written thought for Alpha' },
    });

    selectChat(BRAVO.topic);
    await screen.findByText('Bravo cached answer');
    expect(screen.getByPlaceholderText('Send a message...')).toHaveValue('');

    selectChat(ALPHA.topic);
    await screen.findByText('Alpha answer one');
    expect(screen.getByPlaceholderText('Send a message...')).toHaveValue(
      'half-written thought for Alpha'
    );
  });

  it('keeps the Report tool on screen through switches without refetching its config', async () => {
    const client = productionLikeClient();
    mocks.getChatSession.mockImplementation(async (_projectId: string, sessionId: string) =>
      sessionId === BRAVO.id ? BRAVO_TRANSCRIPT : ALPHA_TRANSCRIPT
    );

    renderChat(client, ALPHA.id);
    await screen.findByLabelText(REPORT_TOOL);
    selectChat(BRAVO.topic);
    await screen.findByText('Bravo cached answer');

    // Both chats are cached now, so every switch paints a whole view at once —
    // and a view that waited on its own config fetch would paint it without Report.
    const start = frames.length;
    selectChat(ALPHA.topic);
    await screen.findByText('Alpha answer one');
    selectChat(BRAVO.topic);
    await screen.findByText('Bravo cached answer');

    const switches = framesSince(start);
    expect(switches.length).toBeGreaterThanOrEqual(2);
    for (const frame of switches) expect(frame.reportTool).toBe(true);
    expect(mocks.getReportIssueConfig).toHaveBeenCalledTimes(1);
  });
});
