/**
 * The Project Overview, rendered as a page with the network mocked at `fetch`: the task box
 * goes through the real new-chat start path (`useNewChatComposer` → `submitTask` → `request`),
 * so these tests see the real request body and the real response handling. Only the project
 * socket and the voice button are stubbed (no WebSocket or microphone in jsdom).
 */
import type { ProjectOverviewResponse } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../../src/hooks/useToast';
import { API_URL } from '../../../src/lib/api/client';
import { ProjectOverview } from '../../../src/pages/project-overview';
import { ProjectContext } from '../../../src/pages/ProjectContext';

const PROJECT_ID = 'proj-1';

const viewport = vi.hoisted(() => ({ isMobile: false }));
vi.mock('../../../src/hooks/useIsMobile', () => ({ useIsMobile: () => viewport.isMobile }));

const socket = vi.hoisted(() => ({
  onSessionEvent: null as
    ((event: { type: string; payload: Record<string, unknown> }) => void) | null,
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'user@example.com', name: 'Test User' } }),
}));

vi.mock('../../../src/hooks/useProjectWebSocket', () => ({
  useProjectWebSocket: ({
    onSessionEvent,
  }: {
    onSessionEvent?: (event: { type: string; payload: Record<string, unknown> }) => void;
  }) => {
    socket.onSessionEvent = onSessionEvent ?? null;
    return { connectionState: 'connected' };
  },
}));

vi.mock('@simple-agent-manager/acp-client', async (importActual) => ({
  ...(await importActual<typeof import('@simple-agent-manager/acp-client')>()),
  VoiceButton: () => null,
  MentionPalette: () => null,
  SlashCommandPalette: () => null,
}));

const PROFILE = {
  id: 'prof-build',
  projectId: PROJECT_ID,
  userId: 'user-1',
  name: 'Opus 5.5 Build',
  description: null,
  agentType: 'claude-code',
  model: null,
  permissionMode: null,
  systemPromptAppend: null,
  maxTurns: null,
  timeoutMinutes: null,
  vmSizeOverride: null,
  provider: null,
  vmLocation: null,
  workspaceProfile: null,
  devcontainerConfigName: null,
  taskMode: null,
  runtime: null,
  isBuiltin: false,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
};

function overview(items: ProjectOverviewResponse['running']['items']): ProjectOverviewResponse {
  return {
    projectId: PROJECT_ID,
    running: {
      items,
      total: items.length,
      waitingOnViewerTotal: items.filter((item) => item.waitingOnViewer).length,
    },
    recent: { ideas: [], mergedPullRequests: [] },
    brief: null,
    unavailable: [],
    generatedAt: '2026-11-16T00:00:00.000Z',
  };
}

/** A brief naming an inbox item, a chat, an automation and a pull request (inbox slice I). */
function briefOf(overrides: Partial<NonNullable<ProjectOverviewResponse['brief']>> = {}) {
  return {
    sentences: [
      {
        parts: [
          { ref: { kind: 'ask' as const, id: 'ask-deploy', label: 'Pick a deploy target' } },
          { text: ' is holding up ' },
          {
            ref: {
              kind: 'chat' as const,
              id: 'sess-existing',
              label: 'Fix rounding in tax totals',
            },
          },
          { text: '.' },
        ],
      },
      {
        parts: [
          {
            ref: {
              kind: 'automation' as const,
              id: 'trg-nightly',
              label: 'Nightly <script>alert(1)</script> build',
            },
          },
          { text: ' keeps failing.' },
        ],
      },
      {
        parts: [
          {
            ref: {
              kind: 'pullRequest' as const,
              id: '2771',
              label: 'Round tax totals',
              url: 'https://github.com/acme/billing/pull/2771',
            },
          },
          { text: ' landed.' },
        ],
      },
    ],
    generatedAt: new Date(Date.now() - 25 * 60_000).toISOString(),
    stale: false,
    refreshing: false,
    ...overrides,
  };
}

const EXISTING = {
  sessionId: 'sess-existing',
  taskId: 'task-existing',
  topic: 'Fix rounding in tax totals',
  state: 'working' as const,
  waitingOnViewer: false,
  startedAt: Date.now() - 3_600_000,
  lastActivityAt: Date.now() - 60_000,
  profile: { id: PROFILE.id, name: PROFILE.name },
  createdByUserId: 'user-1',
};

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

let recorded: Recorded[];
let submitResponse: { status: number; body: unknown };
let overviewBody: ProjectOverviewResponse;
/** Extra GET routes a test serves (automation lists, members), keyed by path. */
let extraRoutes: Record<string, unknown>;
/** This project's open inbox items for the viewer, in server (inbox) order. */
let inboxItems: Record<string, unknown>[];
/** The inbox list's next cursor: set when there are more pages than the Overview reads. */
let inboxNextCursor: string | null;
/** When set, the next inbox list read waits on this promise (controlled refetch ordering). */
let inboxGate: Promise<void> | null;
/** When set, the profile list read waits on this promise; `profileItems` is what it returns. */
let profilesGate: Promise<void> | null;
let profileItems: unknown[];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The network edge: every request the page makes lands here. */
function route(path: string, method: string): Response {
  if (method === 'POST' && path === `/api/projects/${PROJECT_ID}/tasks/submit`) {
    return json(submitResponse.status, submitResponse.body);
  }
  if (method === 'PATCH' && path === `/api/projects/${PROJECT_ID}/triggers/trg-deps`) {
    return json(200, { ...FAILING_TRIGGER, status: 'active' });
  }
  const extra = Object.entries(extraRoutes).find(([prefix]) => path.startsWith(prefix));
  if (method === 'GET' && extra) return json(200, extra[1]);
  switch (path) {
    case '/api/agents':
      return json(200, {
        agents: [{ id: 'claude-code', name: 'Claude Code', configured: true, supportsAcp: true }],
      });
    case `/api/projects/${PROJECT_ID}/agent-profiles`:
      return json(200, { items: profileItems });
    case `/api/projects/${PROJECT_ID}/agent-profiles/picker`:
      return json(200, { usage: [], hiddenProfileIds: [], usageWindowDays: 30 });
    case `/api/projects/${PROJECT_ID}/skills`:
      return json(200, { items: [] });
    case '/api/credentials':
      return json(200, []);
    case '/api/trial-status':
      return json(200, { available: false, hasInfraCredential: true });
    case `/api/projects/${PROJECT_ID}/overview`:
      return json(200, overviewBody);
    case `/api/projects/${PROJECT_ID}/inbox`:
      return json(200, { items: inboxItems, nextCursor: inboxNextCursor, skipped: 0 });
    case `/api/projects/${PROJECT_ID}/inbox/count`:
      return json(200, {
        needsYou: inboxItems.length,
        blocking: inboxItems.filter((item) => item.blocking).length,
      });
    default:
      // Reads this test does not cover (accounts, automations, commands) fail like an
      // unreachable API would; the page must still work around them.
      return json(404, { error: 'NOT_FOUND', message: `No mock for ${method} ${path}` });
  }
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const FAILING_TRIGGER = {
  id: 'trg-deps',
  projectId: PROJECT_ID,
  userId: 'user-1',
  name: 'Nightly dependency audit',
  description: null,
  status: 'paused',
  sourceType: 'cron',
  cronExpression: '30 2 * * *',
  cronHumanReadable: 'Every day at 2:30 AM',
  cronTimezone: 'UTC',
  skipIfRunning: true,
  promptTemplate: 'Audit the dependencies.',
  agentProfileId: PROFILE.id,
  skillId: null,
  taskMode: 'task',
  vmSizeOverride: null,
  resourceRequirementsJson: null,
  maxConcurrent: 1,
  lastTriggeredAt: iso(-26 * 3_600_000),
  triggerCount: 11,
  nextFireAt: null,
  createdAt: iso(-40 * 86_400_000),
  updatedAt: iso(-86_400_000),
};
const NEXT_TRIGGER = {
  ...FAILING_TRIGGER,
  id: 'trg-morning',
  name: 'Morning pull request summary',
  status: 'active',
  nextFireAt: iso(3 * 3_600_000),
  lastTriggeredAt: null,
};
function failedRun(id: string, agoHours: number) {
  return {
    id,
    triggerId: 'trg-deps',
    projectId: PROJECT_ID,
    status: 'failed',
    skipReason: null,
    taskId: `task-${id}`,
    eventType: 'cron',
    renderedPrompt: null,
    errorMessage: 'The GitHub token for this project expired.',
    scheduledAt: iso(-agoHours * 3_600_000),
    startedAt: iso(-agoHours * 3_600_000),
    completedAt: iso(-agoHours * 3_600_000 + 240_000),
    sequenceNumber: 1,
    createdAt: iso(-agoHours * 3_600_000),
  };
}
const AUTOMATION_ROUTES = {
  [`/api/projects/${PROJECT_ID}/triggers/trg-deps/executions`]: {
    executions: [failedRun('r3', 26), failedRun('r2', 50), failedRun('r1', 74)],
    nextCursor: null,
  },
  [`/api/projects/${PROJECT_ID}/triggers/trg-morning/executions`]: {
    executions: [],
    nextCursor: null,
  },
  [`/api/projects/${PROJECT_ID}/triggers`]: { triggers: [FAILING_TRIGGER, NEXT_TRIGGER] },
  [`/api/projects/${PROJECT_ID}/schedules`]: { schedules: [], nextCursor: null },
  [`/api/projects/${PROJECT_ID}/standing-watches`]: { watches: [], nextCursor: null },
  [`/api/projects/${PROJECT_ID}/members`]: {
    members: [
      {
        userId: 'user-1',
        name: 'Test User',
        email: 'user@example.com',
        avatarUrl: null,
        role: 'owner',
        status: 'active',
        joinedAt: '2026-10-01T00:00:00Z',
      },
    ],
    inviteLinks: [],
    accessRequests: [],
  },
};

function LocationProbe() {
  const location = useLocation();
  return (
    <>
      <div data-testid="location">{location.pathname}</div>
      <div data-testid="location-search">{location.search}</div>
    </>
  );
}

/** One open inbox item, the shape `GET /api/projects/:id/inbox` returns. */
function inboxItem(ref: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref,
    store: 'ask',
    kind: 'question',
    projectId: PROJECT_ID,
    projectName: 'Acme Billing',
    sessionId: `sess-${ref}`,
    topic: `Chat for ${ref}`,
    taskId: `task-${ref}`,
    stackKey: `stack-${ref}`,
    title: `Question ${ref}?`,
    body: null,
    blocking: true,
    agentState: 'waiting',
    status: 'open',
    createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    expiresAt: null,
    dueAt: null,
    answerSpec: { type: 'options', options: ['Yes', 'No'], allowText: false },
    links: [],
    canAct: true,
    untrustedContent: true,
    ...fields,
  };
}

/** Stands in for the inbox item view: its Back is the browser's. */
function InboxStub() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      inbox page back
    </button>
  );
}

function renderOverview() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const context = { projectId: PROJECT_ID, project: null, reload: async () => {} };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}/overview`]}>
          <ProjectContext.Provider value={context}>
            <Routes>
              <Route path="/projects/:id/overview" element={<ProjectOverview />} />
              <Route path="/projects/:id/chat/:sessionId" element={<div>chat page</div>} />
              <Route path="/projects/:id/inbox" element={<InboxStub />} />
            </Routes>
            <LocationProbe />
          </ProjectContext.Provider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
  return { ...view, queryClient };
}

async function typeAndSend(text: string) {
  const box = await screen.findByPlaceholderText('Start a task…');
  // The profile is resolved before the first send, as on the chat page.
  await screen.findByText('Opus 5.5 Build', { selector: 'button *' }).catch(() => undefined);
  fireEvent.change(box, { target: { value: text } });
  const send = screen.getByRole('button', { name: /send/i });
  await waitFor(() => expect(send).not.toBeDisabled());
  await act(async () => {
    fireEvent.click(send);
  });
}

describe('Project Overview', () => {
  beforeEach(() => {
    recorded = [];
    extraRoutes = {};
    inboxItems = [];
    inboxNextCursor = null;
    inboxGate = null;
    profilesGate = null;
    profileItems = [PROFILE];
    viewport.isMobile = false;
    overviewBody = overview([EXISTING]);
    submitResponse = {
      status: 200,
      body: {
        taskId: 'task-new',
        sessionId: 'sess-new',
        branchName: 'sam/pause-subscription',
        status: 'queued',
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://localhost');
        const path = url.pathname.replace(
          new URL(API_URL || 'http://localhost').pathname.replace(/\/$/, ''),
          ''
        );
        const method = init?.method ?? 'GET';
        recorded.push({
          method,
          path,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        });
        if (profilesGate && path === `/api/projects/${PROJECT_ID}/agent-profiles`) {
          await profilesGate;
        }
        if (inboxGate && path === `/api/projects/${PROJECT_ID}/inbox`) {
          const gate = inboxGate;
          inboxGate = null;
          await gate;
        }
        return route(path, method);
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows what is running from the aggregated read, each row linking to its chat', async () => {
    renderOverview();
    const running = await screen.findByRole('region', { name: 'Running now' });
    const row = await within(running).findByRole('link', { name: /Fix rounding in tax totals/ });
    expect(row).toHaveAttribute('href', `/projects/${PROJECT_ID}/chat/sess-existing`);
    expect(within(running).getByText(/Opus 5\.5 Build/)).toBeInTheDocument();
    expect(within(running).getByRole('link', { name: /Chats/ })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/chat`
    );
  });

  it('starts a task without leaving the page: box cleared, receipt shown, task in Running now', async () => {
    renderOverview();
    await screen.findByRole('link', { name: /Fix rounding in tax totals/ });

    await typeAndSend(
      'Add a pause subscription option\nCustomers on Pro can pause for 1-3 months.'
    );

    // The real submit request went out with the typed task and the resolved profile.
    await waitFor(() =>
      expect(recorded.some((r) => r.method === 'POST' && r.path.endsWith('/tasks/submit'))).toBe(
        true
      )
    );
    const submit = recorded.find((r) => r.method === 'POST' && r.path.endsWith('/tasks/submit'));
    expect(submit?.body).toMatchObject({
      message: 'Add a pause subscription option\nCustomers on Pro can pause for 1-3 months.',
      agentProfileId: PROFILE.id,
    });

    // No navigation.
    expect(screen.getByTestId('location')).toHaveTextContent(`/projects/${PROJECT_ID}/overview`);
    expect(screen.queryByText('chat page')).not.toBeInTheDocument();

    // The receipt names the task and links to its chat.
    const receipt = await screen.findByTestId('overview-start-receipt');
    expect(receipt).toHaveTextContent('Started: Add a pause subscription option');
    expect(within(receipt).getByRole('link', { name: 'Open chat' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/chat/sess-new`
    );

    // The box is empty again.
    expect(screen.getByPlaceholderText('Start a task…')).toHaveValue('');

    // The new task is in Running now beside the existing one, before the server lists it.
    const running = screen.getByRole('region', { name: 'Running now' });
    const newRow = within(running).getByRole('link', { name: /Add a pause subscription option/ });
    expect(newRow).toHaveAttribute('href', `/projects/${PROJECT_ID}/chat/sess-new`);
    expect(within(newRow).getByText('Starting')).toBeInTheDocument();
    expect(within(running).getByRole('link', { name: /Fix rounding/ })).toBeInTheDocument();
    expect(within(running).getByRole('heading', { name: /Running now\s*2/ })).toBeInTheDocument();
  });

  it('keeps the new task once the server lists it, without showing it twice', async () => {
    renderOverview();
    await screen.findByRole('link', { name: /Fix rounding in tax totals/ });
    // From now on the server's read includes the new chat, with its real topic.
    overviewBody = overview([
      {
        ...EXISTING,
        sessionId: 'sess-new',
        taskId: 'task-new',
        topic: 'Pause subscriptions in the customer portal',
        state: 'working',
        startedAt: Date.now(),
      },
      EXISTING,
    ]);

    await typeAndSend('Add a pause subscription option');

    const running = screen.getByRole('region', { name: 'Running now' });
    await within(running).findByRole('link', {
      name: /Pause subscriptions in the customer portal/,
    });
    expect(
      within(running).queryByRole('link', { name: /^Add a pause subscription option/ })
    ).not.toBeInTheDocument();
    expect(within(running).getAllByTestId('overview-running-row')).toHaveLength(2);
  });

  it('shows a failed start in the receipt line and keeps the typed task', async () => {
    submitResponse = {
      status: 503,
      body: { error: 'PROVISIONING_UNAVAILABLE', message: 'No machine is available right now' },
    };
    renderOverview();
    await screen.findByRole('link', { name: /Fix rounding in tax totals/ });

    await typeAndSend('Add a pause subscription option');

    const receipt = await screen.findByTestId('overview-start-receipt');
    expect(receipt).toHaveTextContent('Couldn’t start: No machine is available right now');
    expect(screen.getByTestId('location')).toHaveTextContent(`/projects/${PROJECT_ID}/overview`);
    expect(screen.getByPlaceholderText('Start a task…')).toHaveValue(
      'Add a pause subscription option'
    );
    const running = screen.getByRole('region', { name: 'Running now' });
    expect(within(running).getAllByTestId('overview-running-row')).toHaveLength(1);
  });

  it('refreshes Running now when the project socket reports a session change', async () => {
    renderOverview();
    await screen.findByRole('link', { name: /Fix rounding in tax totals/ });
    const reads = () => recorded.filter((r) => r.path.endsWith('/overview')).length;
    const before = reads();
    overviewBody = overview([]);
    act(() => socket.onSessionEvent?.({ type: 'session.agent_completed', payload: {} }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before), { timeout: 4000 });
    await screen.findByText('Nothing is running.');
  });

  it('shows each failing automation as one line with its fix, and the next run', async () => {
    extraRoutes = AUTOMATION_ROUTES;
    renderOverview();
    const automations = await screen.findByRole('region', { name: 'Automations' });
    const line = await within(automations).findByTestId('automation-attention-line');
    expect(line).toHaveTextContent('Nightly dependency audit');
    expect(line).toHaveTextContent('Paused · its last 3 runs failed');
    expect(within(automations).getByText('1 failing')).toBeInTheDocument();
    expect(within(automations).getByTestId('overview-automation-next')).toHaveTextContent(
      'Morning pull request summary'
    );
    // The fix is the Automation page's own: Resume turns the trigger back on.
    await act(async () => {
      fireEvent.click(within(line).getByRole('button', { name: 'Resume' }));
    });
    await waitFor(() =>
      expect(
        recorded.find((r) => r.method === 'PATCH' && r.path.endsWith('/triggers/trg-deps'))?.body
      ).toEqual({ status: 'active' })
    );
  });

  it('links recent ideas to their pages and merged pull requests to GitHub', async () => {
    overviewBody = {
      ...overview([EXISTING]),
      recent: {
        ideas: [
          {
            ideaId: 'idea-pause',
            title: 'Pause subscriptions',
            summary: 'Let customers pause.',
            createdAt: '2026-11-01T00:00:00Z',
            updatedAt: '2026-11-16T00:00:00Z',
            derived: {
              state: 'not-started',
              needsYou: null,
              source: { origin: 'none', observedAt: null, stale: false },
              session: null,
              pullRequest: null,
              note: null,
            },
            counts: { updates: 0, chats: 0, files: 0, pullRequests: 0, atLeast: [] },
            filedByAgent: false,
            filedBy: null,
            viaConnector: null,
          } as never,
        ],
        mergedPullRequests: [
          {
            number: 2771,
            url: 'https://github.com/acme/billing/pull/2771',
            title: 'Round tax totals per line',
            repository: 'acme/billing',
            mergedAt: new Date().toISOString(),
          },
        ],
      },
    };
    renderOverview();
    const recently = await screen.findByRole('region', { name: 'Recently' });
    expect(
      await within(recently).findByRole('link', { name: /Pause subscriptions/ })
    ).toHaveAttribute('href', `/projects/${PROJECT_ID}/ideas/idea-pause`);
    const pr = within(recently).getByRole('link', { name: /Round tax totals per line/ });
    expect(pr).toHaveAttribute('href', 'https://github.com/acme/billing/pull/2771');
    expect(pr).toHaveAttribute('target', '_blank');
  });

  it('says how many more are waiting on you when they do not all fit', async () => {
    const waiting = (i: number) => ({
      ...EXISTING,
      sessionId: `sess-wait-${i}`,
      topic: `Question ${i}`,
      state: 'waiting' as const,
      waitingOnViewer: true,
    });
    overviewBody = overview([1, 2, 3, 4, 5].map(waiting));
    overviewBody.running.total = 9;
    overviewBody.running.waitingOnViewerTotal = 7;
    renderOverview();
    const running = await screen.findByRole('region', { name: 'Running now' });
    await within(running).findByRole('link', { name: /Question 1/ });
    expect(
      within(running).getByRole('link', { name: /4 more running\s?· 2 waiting on you/ })
    ).toHaveAttribute('href', `/projects/${PROJECT_ID}/chat`);
  });

  it('does not refetch on socket events while the tab is hidden, and catches up when shown', async () => {
    renderOverview();
    await screen.findByRole('link', { name: /Fix rounding in tax totals/ });
    const reads = () => recorded.filter((r) => r.path.endsWith('/overview')).length;
    const before = reads();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => socket.onSessionEvent?.({ type: 'session.activity', payload: {} }));
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(reads()).toBe(before);
    hidden.mockReturnValue(false);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    hidden.mockRestore();
  });
  describe('Needs you (inbox slice F2)', () => {
    const seven = () =>
      Array.from({ length: 7 }, (_, i) =>
        inboxItem(`ask:q${i + 1}`, { title: `Question ${i + 1}?` })
      );

    it('lists the first five items in inbox order, with the count and a link to the project inbox', async () => {
      inboxItems = seven();
      renderOverview();
      // The quiet "checking" line stands in until the list loads, then the section replaces it.
      await screen.findByTestId('overview-needs-you-list');
      const section = screen.getByRole('region', { name: 'Needs you' });
      const rows = within(section).getAllByTestId('inbox-row');
      expect(rows).toHaveLength(5);
      // Server order is the inbox order: the first five, in order, and nothing past the cap.
      expect(rows.map((row) => row.textContent)).toEqual(
        [1, 2, 3, 4, 5].map((n) => expect.stringContaining(`Question ${n}?`))
      );
      expect(within(section).queryByText('Question 6?')).not.toBeInTheDocument();
      expect(await within(section).findByRole('link', { name: /All 7/ })).toHaveAttribute(
        'href',
        `/projects/${PROJECT_ID}/inbox`
      );
    });

    it('shows three rows on a phone', async () => {
      viewport.isMobile = true;
      inboxItems = seven();
      renderOverview();
      // The quiet "checking" line stands in until the list loads, then the section replaces it.
      await screen.findByTestId('overview-needs-you-list');
      const section = screen.getByRole('region', { name: 'Needs you' });
      expect(within(section).getAllByTestId('inbox-row')).toHaveLength(3);
    });

    it('opens a tapped item in the project inbox item view, remembering it came from here', async () => {
      inboxItems = seven();
      renderOverview();
      await screen.findByTestId('overview-needs-you-list');
      const section = screen.getByRole('region', { name: 'Needs you' });
      fireEvent.click(within(section).getByRole('button', { name: /Question 2\?/ }));
      await waitFor(() =>
        expect(screen.getByTestId('location')).toHaveTextContent(`/projects/${PROJECT_ID}/inbox`)
      );
      const search = new URLSearchParams(screen.getByTestId('location-search').textContent ?? '');
      expect(search.get('item')).toBe('ask:q2');
      expect(search.get('from')).toBe('overview');
    });

    it('is one quiet line when nothing needs you, not an empty panel', async () => {
      inboxItems = [];
      renderOverview();
      const quiet = await screen.findByTestId('overview-needs-you-quiet');
      await within(quiet).findByText('Nothing needs you.');
      expect(within(quiet).getByRole('link', { name: 'Open the project inbox' })).toHaveAttribute(
        'href',
        `/projects/${PROJECT_ID}/inbox`
      );
      expect(screen.queryByTestId('overview-needs-you-list')).not.toBeInTheDocument();
      // Liveness: the rest of the page rendered.
      expect(await screen.findByRole('region', { name: 'Running now' })).toBeInTheDocument();
    });

    it('words a chat paused on your item "Paused on this" in Running now, whatever the read says', async () => {
      // The read says working (the agent is blocked mid-turn on a secret request), the inbox says
      // the agent is paused on the viewer's item: the page follows the inbox.
      overviewBody = overview([
        EXISTING,
        { ...EXISTING, sessionId: 'sess-other', topic: 'Someone else is asked', state: 'waiting' },
      ]);
      inboxItems = [
        inboxItem('secret:sr-1', {
          store: 'secret',
          kind: 'secret',
          sessionId: 'sess-existing',
          title: 'STRIPE_KEY',
          answerSpec: { type: 'secret', envKey: 'STRIPE_KEY', requestId: 'sr-1' },
        }),
      ];
      renderOverview();
      const running = await screen.findByRole('region', { name: 'Running now' });
      const paused = await within(running).findByRole('link', {
        name: /Fix rounding in tax totals/,
      });
      await within(paused).findByText('Paused on this');
      expect(within(paused).getByText('Paused on this')).toHaveClass('text-warning-fg');
      // Control: a chat waiting on someone else is not worded as yours.
      const other = within(running).getByRole('link', { name: /Someone else is asked/ });
      expect(within(other).getByText('Waiting for an answer')).not.toHaveClass('text-warning-fg');
      // And its item is in Needs you.
      const section = await screen.findByRole('region', { name: 'Needs you' });
      expect(within(section).getByText('STRIPE_KEY')).toBeInTheDocument();
    });
    it('keeps the read\'s "waiting on you" while the inbox has pages it did not fetch', async () => {
      // More open items than one page: the chat's paused item may be past the first page.
      overviewBody = overview([
        {
          ...EXISTING,
          sessionId: 'sess-deep',
          topic: 'Paused past page one',
          state: 'waiting',
          waitingOnViewer: true,
        },
      ]);
      inboxItems = [inboxItem('ask:other')];
      inboxNextCursor = 'page-2';
      renderOverview();
      await screen.findByTestId('overview-needs-you-list');
      const running = screen.getByRole('region', { name: 'Running now' });
      const row = await within(running).findByRole('link', { name: /Paused past page one/ });
      expect(within(row).getByText('Paused on this')).toHaveClass('text-warning-fg');
    });

    it('trusts the complete inbox over the read: no item for the chat, not worded as yours', async () => {
      overviewBody = overview([
        {
          ...EXISTING,
          sessionId: 'sess-deep',
          topic: 'Read says waiting',
          state: 'waiting',
          waitingOnViewer: true,
        },
        // An item that is not paused (the agent is still working) does not make a chat paused.
        { ...EXISTING, sessionId: 'sess-task', topic: 'Has a task for you' },
      ]);
      inboxItems = [
        inboxItem('ask:task', {
          kind: 'task',
          blocking: false,
          agentState: 'working',
          sessionId: 'sess-task',
          answerSpec: { type: 'acknowledge' },
        }),
      ];
      renderOverview();
      await screen.findByTestId('overview-needs-you-list');
      const running = screen.getByRole('region', { name: 'Running now' });
      const waiting = await within(running).findByRole('link', { name: /Read says waiting/ });
      expect(within(waiting).getByText('Waiting for an answer')).not.toHaveClass('text-warning-fg');
      const task = within(running).getByRole('link', { name: /Has a task for you/ });
      expect(within(task).queryByText('Paused on this')).not.toBeInTheDocument();
    });

    it('a refetch keeps the rows mounted (no unmount, no spinner)', async () => {
      inboxItems = [inboxItem('ask:q1', { title: 'Question 1?' }), inboxItem('ask:q2')];
      const { queryClient } = renderOverview();
      await screen.findByTestId('overview-needs-you-list');
      const before = screen.getAllByTestId('inbox-row')[0];
      let release = () => {};
      inboxGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await act(async () => {
        void queryClient.invalidateQueries({ queryKey: ['auth', 'user-1', 'inbox'] });
      });
      // Mid-refetch: the same row node is still on the page.
      await waitFor(() => expect(inboxGate).toBeNull());
      expect(screen.getAllByTestId('inbox-row')[0]).toBe(before);
      expect(screen.queryByTestId('overview-needs-you-quiet')).not.toBeInTheDocument();
      inboxItems = [inboxItem('ask:q1', { title: 'Question 1?' })];
      await act(async () => {
        release();
      });
      await waitFor(() => expect(screen.getAllByTestId('inbox-row')).toHaveLength(1));
      expect(screen.getAllByTestId('inbox-row')[0]).toBe(before);
    });

    it('coming back while the list refetches: focus follows to the section when the row leaves', async () => {
      inboxItems = [
        inboxItem('ask:q1', { title: 'Question 1?' }),
        inboxItem('ask:q2', { title: 'Question 2?' }),
      ];
      const { queryClient } = renderOverview();
      await screen.findByTestId('overview-needs-you-list');
      fireEvent.click(screen.getByRole('button', { name: /Question 2\?/ }));
      await screen.findByRole('button', { name: 'inbox page back' });
      // The person answered item 2; its refetch is held open while they come back.
      inboxItems = [inboxItem('ask:q1', { title: 'Question 1?' })];
      let release = () => {};
      inboxGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await act(async () => {
        void queryClient.invalidateQueries({ queryKey: ['auth', 'user-1', 'inbox'] });
      });
      fireEvent.click(screen.getByRole('button', { name: 'inbox page back' }));
      // Cached rows first: the answered row is still listed and takes focus for now.
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('button', { name: /Question 2\?/ }))
      );
      await act(async () => {
        release();
      });
      await waitFor(() => expect(screen.getAllByTestId('inbox-row')).toHaveLength(1));
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Needs you' }))
      );
    });

    it('coming back from an item puts focus on its row', async () => {
      inboxItems = [
        inboxItem('ask:q1', { title: 'Question 1?' }),
        inboxItem('ask:q2', { title: 'Question 2?' }),
      ];
      renderOverview();
      await screen.findByTestId('overview-needs-you-list');
      fireEvent.click(screen.getByRole('button', { name: /Question 2\?/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'inbox page back' }));
      await screen.findByTestId('overview-needs-you-list');
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('button', { name: /Question 2\?/ }))
      );
    });

    it('the task box does not offer to create a profile while the profiles are still loading', async () => {
      let release = () => {};
      profilesGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      renderOverview();
      // Liveness: the page and the box are up, the agents are known.
      await screen.findByRole('region', { name: 'Running now' });
      await screen.findByPlaceholderText(/Start a task/);
      expect(screen.queryByText('Create a profile to start')).not.toBeInTheDocument();
      await act(async () => {
        release();
      });
      await screen.findByText('Opus 5.5 Build', { selector: 'button *' });
      expect(screen.queryByText('Create a profile to start')).not.toBeInTheDocument();
    });

    it('still offers to create a profile when the project really has none (control)', async () => {
      profileItems = [];
      renderOverview();
      expect(await screen.findByText('Create a profile to start')).toBeInTheDocument();
    });
  });

  describe('the generated brief (inbox slice I)', () => {
    it('shows three sentences on desktop, above Needs you, each item a link SAM builds from its id', async () => {
      overviewBody = { ...overview([EXISTING]), brief: briefOf() };
      renderOverview();
      const brief = await screen.findByRole('region', { name: 'Project brief' });
      expect(within(brief).getByRole('link', { name: 'Pick a deploy target' })).toHaveAttribute(
        'href',
        `/projects/${PROJECT_ID}/inbox?item=ask%3Aask-deploy&from=overview`
      );
      expect(
        within(brief).getByRole('link', { name: 'Fix rounding in tax totals' })
      ).toHaveAttribute('href', `/projects/${PROJECT_ID}/chat/sess-existing`);
      const automation = within(brief).getByRole('link', { name: /Nightly/ });
      expect(automation).toHaveAttribute(
        'href',
        `/projects/${PROJECT_ID}/automation/trigger/trg-nightly`
      );
      // Agent-written text is rendered as text, never markup.
      expect(automation.textContent).toBe('Nightly <script>alert(1)</script> build');
      expect(brief.querySelector('script')).toBeNull();
      const pr = within(brief).getByRole('link', { name: /Round tax totals/ });
      expect(pr).toHaveAttribute('href', 'https://github.com/acme/billing/pull/2771');
      expect(pr).toHaveAttribute('rel', 'noopener noreferrer');
      expect(within(brief).queryByTestId('overview-brief-toggle')).toBeNull();
      // The age line is always there, so a stale brief never changes the pane's height.
      expect(within(brief).getByTestId('overview-brief-age')).toHaveTextContent(
        'Written 25 min ago'
      );
      expect(within(pr).getByText('(opens in a new tab)')).toBeInTheDocument();
      // Desktop DOM order: the brief comes before Needs you.
      const main = screen.getByTestId('overview-main');
      const regions = within(main)
        .getAllByRole('region')
        .map((r) => r.getAttribute('aria-label'));
      expect(regions.indexOf('Project brief')).toBeLessThan(regions.indexOf('Needs you'));
    });

    it('folds to one sentence on a phone; tapping the line opens it in place, and only then are names links', async () => {
      viewport.isMobile = true;
      overviewBody = { ...overview([EXISTING]), brief: briefOf() };
      renderOverview();
      const brief = await screen.findByRole('region', { name: 'Project brief' });
      // Folded: the line is one button named by its sentence; names are not links yet.
      const line = within(brief).getByRole('button', { name: /Pick a deploy target/ });
      expect(line).toHaveAttribute('aria-expanded', 'false');
      expect(within(brief).queryByRole('link')).toBeNull();
      expect(within(brief).queryByText(/Nightly/)).toBeNull();
      fireEvent.click(within(brief).getByText('Pick a deploy target'));
      const toggle = within(brief).getByRole('button', { name: 'Project brief details' });
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(within(brief).getByRole('link', { name: 'Pick a deploy target' })).toBeInTheDocument();
      expect(within(brief).getByRole('link', { name: /Nightly/ })).toBeInTheDocument();
      expect(within(brief).queryByRole('link', { name: /Round tax totals/ })).toBeNull();
      // Focus follows the control the person pressed, both ways.
      expect(toggle).toHaveFocus();
      fireEvent.click(toggle);
      const folded = within(brief).getByRole('button', { name: /Pick a deploy target/ });
      expect(folded).toHaveAttribute('aria-expanded', 'false');
      expect(folded).toHaveFocus();
    });

    it('keeps a stale brief visible, dimmed with its age, and refetches to catch up', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        overviewBody = { ...overview([EXISTING]), brief: briefOf({ stale: true }) };
        renderOverview();
        const text = await screen.findByTestId('overview-brief-text');
        expect(text).toHaveAttribute('data-stale', 'true');
        expect(screen.getByTestId('overview-brief-age')).toHaveTextContent('Written 25 min ago');
        const reads = () =>
          recorded.filter((r) => r.path === `/api/projects/${PROJECT_ID}/overview`).length;
        const before = reads();
        overviewBody = { ...overview([EXISTING]), brief: briefOf() };
        await act(async () => {
          await vi.advanceTimersByTimeAsync(9_000);
        });
        await waitFor(() => expect(reads()).toBe(before + 1));
        await waitFor(() =>
          expect(screen.getByTestId('overview-brief-text')).toHaveAttribute('data-stale', 'false')
        );
        // Current again: no further catch-up reads.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(reads()).toBe(before + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('renders nothing when there is no brief or its read failed, and the page is just the tiles', async () => {
      overviewBody = { ...overview([EXISTING]), brief: null };
      renderOverview();
      expect(await screen.findByRole('region', { name: 'Running now' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Project brief' })).toBeNull();
    });

    it('ignores a stored brief when the read reports the brief section unavailable', async () => {
      overviewBody = { ...overview([EXISTING]), brief: briefOf(), unavailable: ['brief'] };
      renderOverview();
      expect(await screen.findByRole('region', { name: 'Running now' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Project brief' })).toBeNull();
    });
  });
});
