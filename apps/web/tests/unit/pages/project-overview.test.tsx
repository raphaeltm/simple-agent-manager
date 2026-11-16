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

import { API_URL } from '../../../src/lib/api/client';
import { ProjectContext } from '../../../src/pages/ProjectContext';
import { ProjectOverview } from '../../../src/pages/project-overview';

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
    running: { items, total: items.length },
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
      <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}/overview`]}>
        <ProjectContext.Provider value={context}>
          <Routes>
            <Route path="/projects/:id/overview" element={<ProjectOverview />} />
            <Route path="/projects/:id/chat/:sessionId" element={<div>chat page</div>} />
          </Routes>
          <LocationProbe />
        </ProjectContext.Provider>
      </MemoryRouter>
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
});
