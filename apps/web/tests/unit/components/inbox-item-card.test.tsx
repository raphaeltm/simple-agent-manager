/**
 * The `inbox_write` chat card (inbox slice D): it reads the filed item from the inbox route and
 * answers it through the same inbox route, so the card and the inbox are two views of one record.
 * Real components; `fetch` is mocked at the edge and asserted on.
 */
import type { ToolCallItem } from '@simple-agent-manager/acp-client';
import type { InboxItem } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/components/AuthProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/components/AuthProvider')>()),
  useAuth: () => ({ user: { id: 'user-1' }, isSuperadmin: false, isLoading: false }),
}));

const { InboxItemCard } = await import(
  '../../../src/components/project-message-view/tool-cards/InboxItemCard'
);

function inboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    ref: 'ask:01ASK',
    store: 'ask',
    kind: 'review',
    projectId: 'p1',
    projectName: 'Acme',
    sessionId: 's1',
    topic: 'Chat',
    taskId: 't1',
    stackKey: 's1',
    title: 'Please review the pricing page',
    body: 'The header changed; check it on a phone.',
    blocking: false,
    agentState: 'working',
    status: 'open',
    createdAt: new Date().toISOString(),
    expiresAt: null,
    dueAt: null,
    answerSpec: { type: 'acknowledge' },
    links: [{ kind: 'pr', id: 'https://github.com/acme/one/pull/9', label: 'PR 9' }],
    canAct: true,
    untrustedContent: true,
    ...overrides,
  };
}

function toolCall(result: unknown, status: ToolCallItem['status'] = 'completed'): ToolCallItem {
  return {
    kind: 'tool_call',
    id: 'tc-1',
    toolCallId: 'call-1',
    title: 'mcp__sam-mcp__inbox_write',
    toolName: 'mcp__sam-mcp__inbox_write',
    toolKind: 'other',
    status,
    content: [],
    locations: [],
    rawOutput: [{ type: 'text', text: JSON.stringify(result) }],
    timestamp: Date.now(),
  } as unknown as ToolCallItem;
}

const FILED = { inboxItem: { ref: 'ask:01ASK', id: '01ASK', sessionId: 's1' } };
const calls: { method: string; path: string; body: unknown }[] = [];
let current: InboxItem | null = inboxItem();

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  calls.length = 0;
  current = inboxItem();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const path = decodeURIComponent(url.pathname);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({
        method,
        path,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (path === '/api/projects/p1/inbox/items/ask:01ASK' && method === 'GET') {
        return current
          ? json(200, { item: current, context: null })
          : json(404, { error: 'NOT_FOUND', message: 'Inbox item not found' });
      }
      if (path.endsWith('/answer')) {
        current = current ? { ...current, status: 'answered', canAct: false } : null;
        return json(200, { ref: 'ask:01ASK', outcome: 'answered', agentNotified: true });
      }
      return json(200, {});
    })
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderCard(item: ToolCallItem, projectId: string | undefined = 'p1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <InboxItemCard item={item} projectId={projectId} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('InboxItemCard', () => {
  it('shows the filed review from the inbox and answers it through the inbox route', async () => {
    renderCard(toolCall(FILED));
    expect(await screen.findByText('Please review the pricing page')).toBeTruthy();
    expect(screen.getByText('Review requested')).toBeTruthy();
    expect(screen.getByText('Waiting for your review')).toBeTruthy();
    expect(screen.getByText('PR 9')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open in inbox' }).getAttribute('href')).toBe(
      '/inbox?item=ask%3A01ASK&project=p1'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Looks good' }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && call.path.endsWith('/answer'))).toBe(
        true
      )
    );
    const answer = calls.find((call) => call.method === 'POST')!;
    expect(answer.path).toBe('/api/projects/p1/inbox/items/ask:01ASK/answer');
    expect(answer.body).toEqual({});
    expect(await screen.findByText(/Looks good/)).toBeTruthy();
  });

  it('shows a blocking question with its options and the answered state once settled', async () => {
    current = inboxItem({
      kind: 'question',
      blocking: true,
      title: 'Deploy to staging first?',
      body: null,
      answerSpec: { type: 'options', options: ['Yes', 'No'], allowText: false },
      links: [],
    });
    const { unmount } = renderCard(toolCall(FILED));
    expect(await screen.findByText('Question for you')).toBeTruthy();
    expect(screen.getByText(/agent paused on this/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
    unmount();

    current = { ...current, status: 'answered', canAct: false };
    renderCard(toolCall(FILED));
    expect(await screen.findByText('Answered')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Yes' })).toBeNull();
  });

  it('says the agent withdrew a cancelled item', async () => {
    current = inboxItem({ status: 'cancelled', canAct: false });
    renderCard(toolCall(FILED));
    expect(await screen.findByText('Withdrawn by the agent')).toBeTruthy();
  });

  it('points to the inbox when the item is not in this reader’s inbox, with Retry', async () => {
    current = null;
    renderCard(toolCall(FILED));
    expect(await screen.findByText(/not in your inbox/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('renders nothing without a filed item reference (an update or cancel result)', () => {
    const { container } = renderCard(toolCall({ ref: 'ask:01ASK', status: 'cancelled' }));
    expect(container.textContent).toBe('');
    expect(calls).toEqual([]);
  });
});
