/**
 * The Project Overview, rendered as a page with the network mocked at `fetch`: the task box
 * goes through the real new-chat start path (`useNewChatComposer` → `submitTask` → `request`),
 * so these tests see the real request body and the real response handling. Only the project
 * socket and the voice button are stubbed (no WebSocket or microphone in jsdom).
 */
import type { ProjectOverviewResponse } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../../src/hooks/useToast';
import { API_URL } from '../../../src/lib/api/client';
import { ProjectOverview } from '../../../src/pages/project-overview';
import { ProjectContext } from '../../../src/pages/ProjectContext';

const PROJECT_ID = 'proj-1';

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
    unavailable: [],
    generatedAt: '2026-11-16T00:00:00.000Z',
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
      return json(200, { items: [PROFILE] });
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
  return <div data-testid="location">{location.pathname}</div>;
}

function renderOverview() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const context = { projectId: PROJECT_ID, project: null, reload: async () => {} };
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}/overview`]}>
          <ProjectContext.Provider value={context}>
            <Routes>
              <Route path="/projects/:id/overview" element={<ProjectOverview />} />
              <Route path="/projects/:id/chat/:sessionId" element={<div>chat page</div>} />
            </Routes>
            <LocationProbe />
          </ProjectContext.Provider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
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
});
