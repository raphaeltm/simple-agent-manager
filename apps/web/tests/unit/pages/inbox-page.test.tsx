/**
 * The Inbox page (slice C) driven through its real components, with the network mocked at the
 * edge (`fetch`), so URL building, request bodies and response handling are all exercised.
 *
 * Covers: answering each kind, archive with and without Undo (and a pending archive flushed on
 * unmount), a failed answer keeping the item, stale items closing themselves, the last item of a
 * stack landing on the next stack, the last item overall landing on the empty state, and a
 * refetch never unmounting the open item.
 */
import type { InboxItem } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock('../../../src/hooks/useIsMobile', () => ({ useIsMobile: () => mobile.value }));
vi.mock('../../../src/components/AuthProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/components/AuthProvider')>()),
  useAuth: () => ({ user: { id: 'user-1' }, isSuperadmin: false, isLoading: false }),
}));

const { InboxPage } = await import('../../../src/pages/inbox/InboxPage');
const { INBOX_ARCHIVE_UNDO_MS } = await import('../../../src/components/inbox/useInbox');

function item(overrides: Partial<InboxItem> & { ref: string }): InboxItem {
  return {
    store: 'ask',
    kind: 'question',
    projectId: 'p1',
    projectName: 'Acme',
    sessionId: 's1',
    topic: 'Ship billing',
    taskId: 't1',
    stackKey: overrides.ref,
    title: `Title ${overrides.ref}`,
    body: 'Why the agent asks',
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
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
  keepalive: boolean;
}

interface Server {
  items: InboxItem[];
  calls: Call[];
  /** Override a response: return undefined to fall through. */
  override?: (method: string, path: string) => { status: number; body: unknown } | undefined;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(server: Server) {
  const closed = new Set<string>();
  const archived = new Set<string>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = decodeURIComponent(url.pathname);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      server.calls.push({ method, path, body, keepalive: init?.keepalive === true });
      const forced = server.override?.(method, path);
      if (forced) return json(forced.status, forced.body);
      const open = server.items.filter((candidate) => !closed.has(candidate.ref));
      if (method === 'GET' && /\/inbox\/count$/.test(path))
        return json(200, {
          needsYou: open.length,
          blocking: open.filter((i) => i.blocking).length,
        });
      if (method === 'GET' && /\/inbox$/.test(path)) {
        if (url.searchParams.get('filter') === 'archived')
          return json(200, {
            items: server.items
              .filter((candidate) => archived.has(candidate.ref))
              .map((candidate) => ({ ...candidate, status: 'archived' })),
            nextCursor: null,
            skipped: 0,
          });
        return json(200, { items: open, nextCursor: null, skipped: 0 });
      }
      const itemMatch = path.match(/\/inbox\/items\/(.+?)(\/answer|\/archive)?$/);
      if (itemMatch) {
        const ref = itemMatch[1]!;
        const found = server.items.find((candidate) => candidate.ref === ref);
        if (!found) return json(404, { error: 'NOT_FOUND', message: 'Inbox item not found' });
        if (itemMatch[2]) {
          closed.add(ref);
          if (itemMatch[2] === '/archive') archived.add(ref);
          return json(200, {
            ref,
            outcome: itemMatch[2] === '/archive' ? 'archived' : 'answered',
            agentNotified: true,
          });
        }
        return json(200, {
          item: found,
          context: { before: [], since: { messages: [], activityCount: 0, truncated: false } },
        });
      }
      if (/\/interactions\/int-1$/.test(path))
        return json(200, {
          summary: { interactionId: 'int-1', state: 'pending' },
          detail: {
            title: 'Run pnpm db:migrate',
            description: 'Adds a nullable column.',
            options: [
              { id: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { id: 'deny', name: 'Deny', kind: 'reject_once' },
            ],
          },
        });
      if (/\/secret-requests\/sr-1$/.test(path))
        return json(200, {
          request: {
            id: 'sr-1',
            projectId: 'p1',
            envKey: 'STRIPE_KEY',
            reason: 'Needed for webhooks',
            ttlSeconds: null,
            status: 'pending',
            requestingTaskId: 't1',
            requestingChatSessionId: 's1',
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            createdAt: new Date().toISOString(),
            resolvedAt: null,
            resolvedByName: null,
            secretExpiresAt: null,
          },
          existing: null,
          canResolve: true,
        });
      if (/\/secret-requests\/sr-1\/fulfill$/.test(path)) {
        closed.add('secret:sr-1');
        return json(200, {
          request: { id: 'sr-1', envKey: 'STRIPE_KEY', status: 'fulfilled' },
          agentNotified: true,
        });
      }
      if (path.startsWith('/api/notifications'))
        return json(200, { notifications: [], unreadCount: 0, nextCursor: null });
      return json(200, {});
    })
  );
}

let location = '';
function LocationProbe() {
  const current = useLocation();
  location = `${current.pathname}${current.search}`;
  return null;
}

type Entry = string | { pathname: string; search?: string; state?: unknown };

function renderInbox(entry: Entry | Entry[] = '/inbox') {
  const entries = Array.isArray(entry) ? entry : [entry];
  const client = new QueryClient({
    // Same focus default as the app's client (`lib/query-client.ts`): inbox queries must opt in.
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <Routes>
          <Route
            path="/inbox"
            element={
              <>
                <InboxPage projectId={null} />
                <LocationProbe />
              </>
            }
          />
          <Route
            path="/projects/:id/inbox"
            element={
              <>
                <InboxPage projectId="p1" projectName="Acme" />
                <LocationProbe />
              </>
            }
          />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...view, client };
}

function openUrl(ref: string, project = 'p1') {
  return `/inbox?${new URLSearchParams({ item: ref, project }).toString()}`;
}

const itemPane = () => screen.getByRole('region', { name: 'Inbox item' });
const answerCalls = (server: Server) => server.calls.filter((c) => c.path.endsWith('/answer'));
const archiveCalls = (server: Server) => server.calls.filter((c) => c.path.endsWith('/archive'));

let server: Server;

beforeEach(() => {
  mobile.value = false;
  server = { items: [], calls: [] };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('InboxPage — answering', () => {
  it('answers a question, shows a receipt and moves straight to the next item', async () => {
    server.items = [item({ ref: 'ask:a' }), item({ ref: 'ask:b' })];
    installFetch(server);
    renderInbox();
    await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('heading', {
      name: 'Title ask:a',
    });
    fireEvent.click(within(itemPane()).getByRole('button', { name: 'Yes' }));
    await within(itemPane()).findByRole('heading', { name: 'Title ask:b' });
    expect(screen.getByTestId('inbox-receipt')).toHaveTextContent('Sent “Yes”');
    expect(answerCalls(server)).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/api/projects/p1/inbox/items/ask:a/answer',
        body: { answer: 'Yes' },
      }),
    ]);
    await waitFor(() => expect(location).toContain('item=ask%3Ab'));
  });

  it('answers a permission with the option the agent supplied', async () => {
    server.items = [
      item({
        ref: 'attention:s1:m1',
        store: 'attention',
        kind: 'permission',
        answerSpec: { type: 'interaction', interactionId: 'int-1', interactionKind: 'permission' },
      }),
    ];
    installFetch(server);
    renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: 'Allow once' }));
    await screen.findByText('Nothing needs you');
    expect(answerCalls(server)[0]).toMatchObject({
      path: '/api/projects/p1/inbox/items/attention:s1:m1/answer',
      body: { optionId: 'allow-once' },
    });
    // The command stays in the body; only the buttons were pinned.
    expect(server.calls.some((c) => /\/sessions\/s1\/interactions\/int-1$/.test(c.path))).toBe(
      true
    );
  });

  it('supplies a secret through the secret form', async () => {
    server.items = [
      item({
        ref: 'secret:sr-1',
        store: 'secret',
        kind: 'secret',
        answerSpec: { type: 'secret', envKey: 'STRIPE_KEY', requestId: 'sr-1' },
      }),
    ];
    installFetch(server);
    renderInbox();
    fireEvent.change(await screen.findByPlaceholderText('Paste the secret value'), {
      target: { value: 'sk_live_x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    await screen.findByText('Nothing needs you');
    expect(screen.getByTestId('inbox-receipt')).toHaveTextContent('Saved STRIPE_KEY');
    const fulfil = server.calls.find((c) => c.path.endsWith('/secret-requests/sr-1/fulfill'));
    expect(fulfil?.body).toMatchObject({ value: 'sk_live_x' });
  });

  it('decides an approval', async () => {
    server.items = [
      item({
        ref: 'approval:ap1',
        store: 'approval',
        kind: 'approval',
        answerSpec: {
          type: 'approval',
          action: 'restart_vm_agent',
          targetType: 'node',
          targetId: 'n1',
        },
      }),
    ];
    installFetch(server);
    renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await screen.findByText('Nothing needs you');
    expect(answerCalls(server)[0]?.body).toEqual({ decision: 'approve' });
  });

  it('marks a review "Looks good"', async () => {
    server.items = [
      item({ ref: 'ask:r', kind: 'review', blocking: false, answerSpec: { type: 'acknowledge' } }),
    ];
    installFetch(server);
    renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: 'Looks good' }));
    await screen.findByText('Nothing needs you');
    expect(answerCalls(server)[0]?.body).toEqual({});
  });

  it('marks a result "Got it", and a result can be answered with a reply', async () => {
    server.items = [
      item({
        ref: 'ask:res',
        kind: 'result',
        blocking: false,
        title: 'The flaky login test is fixed',
        answerSpec: { type: 'acknowledge' },
      }),
    ];
    installFetch(server);
    renderInbox();
    expect(await screen.findByText('Result')).toBeTruthy();
    // A result is acknowledged, never "Looks good".
    expect(screen.queryByRole('button', { name: 'Looks good' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Got it' }));
    await screen.findByText('Nothing needs you');
    expect(answerCalls(server)[0]?.body).toEqual({});
  });

  it('a result from a finished agent offers Open chat instead of Reply', async () => {
    server.items = [
      item({
        ref: 'ask:res',
        kind: 'result',
        blocking: false,
        agentState: 'finished',
        answerSpec: { type: 'acknowledge' },
      }),
    ];
    installFetch(server);
    renderInbox();
    // Liveness: the result's controls rendered.
    expect(await screen.findByRole('button', { name: 'Got it' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Open chat' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
  });

  it('replies to a result', async () => {
    server.items = [
      item({
        ref: 'ask:res',
        kind: 'result',
        blocking: false,
        answerSpec: { type: 'acknowledge' },
      }),
    ];
    installFetch(server);
    renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
    fireEvent.change(screen.getByLabelText('Your reply'), {
      target: { value: 'Do production next week.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await screen.findByText('Nothing needs you');
    expect(answerCalls(server)[0]?.body).toEqual({ answer: 'Do production next week.' });
  });

  it('types a different answer beside the options', async () => {
    server.items = [
      item({ ref: 'ask:a', answerSpec: { type: 'options', options: ['Yes'], allowText: true } }),
    ];
    installFetch(server);
    renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: /Type a different answer/ }));
    fireEvent.change(screen.getByLabelText('Your answer'), {
      target: { value: 'Only on Fridays' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await screen.findByText('Nothing needs you');
    expect(answerCalls(server)[0]?.body).toEqual({ answer: 'Only on Fridays' });
  });

  it('keeps the item and shows the error when an answer fails', async () => {
    server.items = [item({ ref: 'ask:a' }), item({ ref: 'ask:b' })];
    server.override = (method, path) =>
      method === 'POST' && path.endsWith('/answer')
        ? { status: 500, body: { error: 'INTERNAL', message: 'Agent store unavailable' } }
        : undefined;
    installFetch(server);
    renderInbox();
    fireEvent.click(
      await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('button', {
        name: 'Yes',
      })
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent store unavailable');
    expect(within(itemPane()).getByRole('heading', { name: 'Title ask:a' })).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-receipt')).not.toBeInTheDocument();
  });
});

describe('InboxPage — the walk', () => {
  it('answering the last item of a stack lands on the next stack', async () => {
    server.items = [
      item({ ref: 'ask:s1', stackKey: 'chat-1' }),
      item({ ref: 'ask:s2', stackKey: 'chat-1' }),
      item({ ref: 'ask:other', stackKey: 'chat-2', topic: 'Other chat' }),
    ];
    installFetch(server);
    renderInbox(openUrl('ask:s2'));
    expect(await screen.findByTestId('inbox-stack-counter')).toHaveTextContent('2 of 2 from');
    fireEvent.click(within(itemPane()).getByRole('button', { name: 'Yes' }));
    await within(itemPane()).findByRole('heading', { name: 'Title ask:other' });
    await waitFor(() => expect(location).toContain('item=ask%3Aother'));
  });

  it('answering the last item overall lands on the empty state', async () => {
    server.items = [item({ ref: 'ask:only' })];
    installFetch(server);
    renderInbox(openUrl('ask:only'));
    fireEvent.click(
      await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('button', {
        name: 'Yes',
      })
    );
    await screen.findByText('Nothing needs you');
    expect(screen.getByText('You are all caught up.')).toBeInTheDocument();
    await waitFor(() => expect(location).toBe('/inbox'));
  });

  it('on a phone, answering the last item returns to the empty list', async () => {
    mobile.value = true;
    server.items = [item({ ref: 'ask:only' })];
    installFetch(server);
    renderInbox(openUrl('ask:only'));
    fireEvent.click(
      await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('button', {
        name: 'Yes',
      })
    );
    await screen.findByText('Nothing needs you');
    await waitFor(() => expect(location).toBe('/inbox'));
    expect(screen.getByTestId('inbox-receipt')).toHaveTextContent('Sent “Yes”');
  });

  it('closes an item that was answered elsewhere when it opens', async () => {
    server.items = [item({ ref: 'ask:gone' }), item({ ref: 'ask:next' })];
    server.override = (method, path) =>
      method === 'GET' && path.endsWith('/items/ask:gone')
        ? { status: 409, body: { error: 'CONFLICT', message: 'already answered' } }
        : undefined;
    installFetch(server);
    renderInbox(openUrl('ask:gone'));
    await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('heading', {
      name: 'Title ask:next',
    });
    expect(screen.getByTestId('inbox-receipt')).toHaveTextContent('Already handled somewhere else');
    expect(answerCalls(server)).toHaveLength(0);
  });

  it('closes an item whose answer finds it already closed', async () => {
    server.items = [item({ ref: 'ask:a' }), item({ ref: 'ask:b' })];
    server.override = (method, path) =>
      method === 'POST' && path.endsWith('/ask:a/answer')
        ? { status: 409, body: { error: 'CONFLICT', message: 'already answered' } }
        : undefined;
    installFetch(server);
    renderInbox();
    fireEvent.click(
      await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('button', {
        name: 'Yes',
      })
    );
    await within(itemPane()).findByRole('heading', { name: 'Title ask:b' });
    expect(screen.getByTestId('inbox-receipt')).toHaveTextContent('Already handled somewhere else');
  });

  it('a refetch keeps the open item mounted', async () => {
    server.items = [item({ ref: 'ask:a' }), item({ ref: 'ask:b' })];
    installFetch(server);
    const { client } = renderInbox();
    const heading = await within(
      await screen.findByRole('region', { name: 'Inbox item' })
    ).findByRole('heading', {
      name: 'Title ask:a',
    });
    const before = server.calls.length;
    await act(async () => {
      await client.invalidateQueries();
    });
    await waitFor(() => expect(server.calls.length).toBeGreaterThan(before));
    expect(within(itemPane()).getByRole('heading', { name: 'Title ask:a' })).toBe(heading);
  });
});

describe('InboxPage — archive', () => {
  it('Undo inside the window sends nothing and brings the item back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    server.items = [item({ ref: 'ask:a' }), item({ ref: 'ask:b' })];
    installFetch(server);
    renderInbox();
    await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('heading', {
      name: 'Title ask:a',
    });
    fireEvent.click(screen.getByRole('button', { name: /^Archive/ }));
    await within(itemPane()).findByRole('heading', { name: 'Title ask:b' });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await within(itemPane()).findByRole('heading', { name: 'Title ask:a' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INBOX_ARCHIVE_UNDO_MS + 1_000);
    });
    expect(archiveCalls(server)).toHaveLength(0);
  });

  it('sends the archive when the window ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    server.items = [item({ ref: 'ask:a' }), item({ ref: 'ask:b' })];
    installFetch(server);
    renderInbox();
    await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('heading', {
      name: 'Title ask:a',
    });
    fireEvent.click(screen.getByRole('button', { name: /^Archive/ }));
    expect(screen.getByTestId('inbox-receipt')).toHaveTextContent('Archived');
    expect(archiveCalls(server)).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INBOX_ARCHIVE_UNDO_MS + 100);
    });
    await waitFor(() => expect(archiveCalls(server)).toHaveLength(1));
    expect(archiveCalls(server)[0]).toMatchObject({
      method: 'POST',
      path: '/api/projects/p1/inbox/items/ask:a/archive',
    });
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('a pending archive is still sent when the page unmounts', async () => {
    server.items = [item({ ref: 'ask:a' })];
    installFetch(server);
    const { unmount } = renderInbox();
    await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('heading', {
      name: 'Title ask:a',
    });
    fireEvent.click(screen.getByRole('button', { name: /^Archive/ }));
    expect(archiveCalls(server)).toHaveLength(0);
    unmount();
    await waitFor(() => expect(archiveCalls(server)).toHaveLength(1));
    expect(archiveCalls(server)[0]?.keepalive).toBe(true);
  });

  it('a pending archive is sent when the tab is closed (pagehide)', async () => {
    server.items = [item({ ref: 'ask:a' })];
    installFetch(server);
    renderInbox();
    await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('heading', {
      name: 'Title ask:a',
    });
    fireEvent.click(screen.getByRole('button', { name: /^Archive/ }));
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await waitFor(() => expect(archiveCalls(server)).toHaveLength(1));
    expect(archiveCalls(server)[0]?.keepalive).toBe(true);
  });

  it('a failed archive brings the item back with the error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    server.items = [item({ ref: 'ask:a' }), item({ ref: 'ask:b' })];
    server.override = (method, path) =>
      method === 'POST' && path.endsWith('/archive')
        ? { status: 403, body: { error: 'FORBIDDEN', message: 'Agent wake not allowed' } }
        : undefined;
    installFetch(server);
    renderInbox();
    await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('heading', {
      name: 'Title ask:a',
    });
    fireEvent.click(screen.getByRole('button', { name: /^Archive/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INBOX_ARCHIVE_UNDO_MS + 100);
    });
    expect(await screen.findByTestId('inbox-receipt')).toHaveTextContent('Agent wake not allowed');
    expect(screen.getByRole('button', { name: /Title ask:a/ })).toBeInTheDocument();
  });
});

describe('InboxPage — navigation, filters and freshness', () => {
  it('steps with previous / next and goes back to the list on a phone', async () => {
    mobile.value = true;
    server.items = [item({ ref: 'ask:a' }), item({ ref: 'ask:b' }), item({ ref: 'ask:c' })];
    installFetch(server);
    renderInbox(openUrl('ask:b'));
    await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('heading', {
      name: 'Title ask:b',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next item' }));
    await within(itemPane()).findByRole('heading', { name: 'Title ask:c' });
    expect(screen.getByRole('button', { name: 'Next item' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Previous item' }));
    await within(itemPane()).findByRole('heading', { name: 'Title ask:b' });
    fireEvent.click(screen.getByRole('button', { name: 'Back to inbox' }));
    await waitFor(() => expect(location).toBe('/inbox'));
    expect(answerCalls(server)).toHaveLength(0);
  });

  it('a chip filters the list on the server', async () => {
    server.items = [item({ ref: 'ask:a' })];
    installFetch(server);
    renderInbox();
    await screen.findByRole('button', { name: /Title ask:a/ });
    fireEvent.click(screen.getByRole('button', { name: /^Blocking/ }));
    await waitFor(() => expect(location).toBe('/inbox?filter=blocking'));
    await waitFor(() =>
      expect(server.calls.some((c) => c.path === '/api/inbox' && c.method === 'GET')).toBe(true)
    );
    expect(screen.getByRole('button', { name: /^Blocking/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('an item archived this session is listed under Archived (⋯ menu)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    server.items = [item({ ref: 'ask:a' }), item({ ref: 'ask:b' })];
    installFetch(server);
    renderInbox();
    await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('heading', {
      name: 'Title ask:a',
    });
    fireEvent.click(screen.getByRole('button', { name: /^Archive/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INBOX_ARCHIVE_UNDO_MS + 100);
    });
    await waitFor(() => expect(archiveCalls(server)).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'More filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    expect(await screen.findByRole('button', { name: /Title ask:a/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Archived/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it("keeps the page's purpose behind the ? instead of a subtitle", async () => {
    server.items = [item({ ref: 'ask:a' })];
    installFetch(server);
    renderInbox('/projects/p1/inbox');
    await screen.findByRole('button', { name: /Title ask:a/ });
    // Liveness: the header rendered its title and chips while the explanation stays hidden.
    expect(screen.getAllByRole('heading', { level: 1, name: 'Inbox' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('group', { name: 'Inbox filters' })).toBeInTheDocument();
    const purpose = 'What your agents need from you in Acme.';
    expect(screen.queryByText(purpose)).not.toBeInTheDocument();

    const help = screen.getByRole('button', { name: 'About the inbox' });
    expect(help).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(help);
    expect(help).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('note')).toHaveTextContent(purpose);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText(purpose)).not.toBeInTheDocument();
    expect(help).toHaveFocus();

    fireEvent.click(help);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText(purpose)).not.toBeInTheDocument();

    // Focus moving into the note keeps it open; tabbing on to the chips closes it.
    fireEvent.click(help);
    const note = screen.getByRole('note');
    fireEvent.blur(help, { relatedTarget: note });
    expect(screen.getByRole('note')).toHaveTextContent(purpose);
    fireEvent.blur(help, { relatedTarget: screen.getByRole('button', { name: /^Needs you/ }) });
    expect(screen.queryByText(purpose)).not.toBeInTheDocument();
  });

  it('refreshes on window focus, without polling', async () => {
    server.items = [item({ ref: 'ask:a' })];
    installFetch(server);
    renderInbox();
    await screen.findByRole('button', { name: /Title ask:a/ });
    const countCalls = () => server.calls.filter((c) => c.path === '/api/inbox/count').length;
    const before = countCalls();
    act(() => {
      // TanStack's focus manager listens for `visibilitychange` on window.
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(countCalls()).toBeGreaterThan(before));
    const { inboxCountQueryOptions, inboxListQueryOptions, inboxItemQueryOptions } =
      await import('../../../src/lib/query-options');
    expect(inboxCountQueryOptions('u', null).refetchInterval).toBeUndefined();
    expect(inboxListQueryOptions('u', null, 'needs_you').refetchInterval).toBeUndefined();
    expect(inboxItemQueryOptions('u', 'p', 'r').refetchInterval).toBeUndefined();
  });

  it('a refetch keeps the list rows mounted', async () => {
    server.items = [item({ ref: 'ask:a' }), item({ ref: 'ask:b' })];
    installFetch(server);
    const { client } = renderInbox();
    const row = await screen.findByRole('button', { name: /Title ask:b/ });
    await act(async () => {
      await client.invalidateQueries();
    });
    expect(screen.getByRole('button', { name: /Title ask:b/ })).toBe(row);
  });

  it('closes an item whose fresh read says it is no longer open', async () => {
    server.items = [item({ ref: 'ask:a' }), item({ ref: 'ask:b' })];
    server.override = (method, path) =>
      method === 'GET' && path.endsWith('/items/ask:a')
        ? {
            status: 200,
            body: { item: item({ ref: 'ask:a', status: 'answered' }), context: null },
          }
        : undefined;
    installFetch(server);
    renderInbox(openUrl('ask:a'));
    await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('heading', {
      name: 'Title ask:b',
    });
    expect(screen.getByTestId('inbox-receipt')).toHaveTextContent('Already handled somewhere else');
  });
});

describe('InboxPage — focus', () => {
  it('moves focus to the next item after answering, and to the row after Back on a phone', async () => {
    mobile.value = true;
    server.items = [item({ ref: 'ask:a' }), item({ ref: 'ask:b' })];
    installFetch(server);
    renderInbox(openUrl('ask:a'));
    const first = await within(
      await screen.findByRole('region', { name: 'Inbox item' })
    ).findByRole('heading', { name: 'Title ask:a' });
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.click(within(itemPane()).getByRole('button', { name: 'Yes' }));
    const next = await within(itemPane()).findByRole('heading', { name: 'Title ask:b' });
    await waitFor(() => expect(document.activeElement).toBe(next));
    fireEvent.click(screen.getByRole('button', { name: 'Back to inbox' }));
    await waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.dataset.inboxRefs).toBe('ask:b')
    );
  });

  it("does not steal focus for desktop's default first item", async () => {
    server.items = [item({ ref: 'ask:a' })];
    installFetch(server);
    renderInbox();
    await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('heading', {
      name: 'Title ask:a',
    });
    expect(document.activeElement).toBe(document.body);
  });
});

describe('InboxPage — error items and malformed rows', () => {
  const errorItem = () =>
    item({
      ref: 'ask:err',
      kind: 'error',
      blocking: false,
      agentState: 'not_started',
      // Slice E's answer spec, read at runtime (older shared types do not name it).
      answerSpec: {
        type: 'actions',
        actions: [
          { id: 'retry', label: 'Retry' },
          { id: 'open_chat', label: 'Open chat' },
        ],
      } as unknown as InboxItem['answerSpec'],
    });

  it('runs the primary action through the answer route', async () => {
    server.items = [errorItem()];
    installFetch(server);
    renderInbox();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    await screen.findByText('Nothing needs you');
    expect(answerCalls(server)[0]).toMatchObject({
      path: '/api/projects/p1/inbox/items/ask:err/answer',
      body: { action: 'retry' },
    });
  });

  it('opens the chat without calling the server for Open chat', async () => {
    server.items = [errorItem()];
    installFetch(server);
    renderInbox();
    const pinned = await screen.findByTestId('inbox-pinned-controls');
    fireEvent.click(within(pinned).getByRole('button', { name: 'Open chat' }));
    await waitFor(() => expect(location).toBe('/projects/p1/chat/s1'));
    expect(answerCalls(server)).toHaveLength(0);
  });

  it('skips a malformed row and keeps the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    server.items = [
      { ref: 'ask:broken', title: 42 } as unknown as InboxItem,
      item({ ref: 'ask:ok' }),
    ];
    installFetch(server);
    renderInbox();
    expect(await screen.findByRole('button', { name: /Title ask:ok/ })).toBeInTheDocument();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('InboxPage — opened from the Project Overview (slice F2)', () => {
  const fromOverview = (ref: string) =>
    `/projects/p1/inbox?${new URLSearchParams({ item: ref, from: 'overview' }).toString()}`;

  it('on a phone, Back from the item returns to the Overview, not the inbox list (fresh tab: replace)', async () => {
    mobile.value = true;
    server.items = [item({ ref: 'ask:a' }), item({ ref: 'ask:b' })];
    installFetch(server);
    renderInbox(fromOverview('ask:a'));
    await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('heading', {
      name: 'Title ask:a',
    });
    expect(screen.queryByRole('button', { name: 'Back to inbox' })).not.toBeInTheDocument();
    // The item pane's arrow (the header, with its own button, is hidden by CSS on a phone).
    fireEvent.click(within(itemPane()).getByRole('button', { name: 'Back to Overview' }));
    await waitFor(() => expect(location).toBe('/projects/p1/overview'));
  });

  it('answering moves to the next item and keeps the way back to the Overview', async () => {
    mobile.value = true;
    server.items = [item({ ref: 'ask:a' }), item({ ref: 'ask:b' })];
    installFetch(server);
    renderInbox(fromOverview('ask:a'));
    await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('heading', {
      name: 'Title ask:a',
    });
    fireEvent.click(within(itemPane()).getByRole('button', { name: 'Yes' }));
    await within(itemPane()).findByRole('heading', { name: 'Title ask:b' });
    expect(screen.getByTestId('inbox-receipt')).toHaveTextContent('Sent “Yes”');
    await waitFor(() => expect(location).toContain('from=overview'));
    fireEvent.click(within(itemPane()).getByRole('button', { name: 'Back to Overview' }));
    await waitFor(() => expect(location).toBe('/projects/p1/overview'));
  });

  it('on desktop, the header offers the way back beside the list (fresh tab: replace)', async () => {
    server.items = [item({ ref: 'ask:a' })];
    installFetch(server);
    renderInbox(fromOverview('ask:a'));
    await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('heading', {
      name: 'Title ask:a',
    });
    fireEvent.click(
      within(screen.getByRole('banner')).getByRole('button', { name: 'Back to Overview' })
    );
    await waitFor(() => expect(location).toBe('/projects/p1/overview'));
  });

  /** The Overview's entry, then the item the Overview pushed (with the state it pushes). */
  const pushedFromOverview = (ref: string): Entry[] => [
    '/projects/p1/overview?entry=overview',
    {
      pathname: '/projects/p1/inbox',
      search: `?${new URLSearchParams({ item: ref, from: 'overview' }).toString()}`,
      state: { samOverviewBehind: true },
    },
  ];

  it('pops back to the Overview entry it came from, even after answering moved on', async () => {
    mobile.value = true;
    server.items = [item({ ref: 'ask:a' }), item({ ref: 'ask:b' })];
    installFetch(server);
    renderInbox(pushedFromOverview('ask:a'));
    await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('heading', {
      name: 'Title ask:a',
    });
    fireEvent.click(within(itemPane()).getByRole('button', { name: 'Yes' }));
    await within(itemPane()).findByRole('heading', { name: 'Title ask:b' });
    await waitFor(() => expect(location).toContain('item=ask%3Ab'));
    fireEvent.click(within(itemPane()).getByRole('button', { name: 'Back to Overview' }));
    // The marker query exists only on the original Overview entry: this was a pop, not a push.
    await waitFor(() => expect(location).toBe('/projects/p1/overview?entry=overview'));
  });

  it('on desktop, after opening another row, Back goes to the Overview, not the first item', async () => {
    server.items = [item({ ref: 'ask:a' }), item({ ref: 'ask:b' })];
    installFetch(server);
    renderInbox(pushedFromOverview('ask:a'));
    await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('heading', {
      name: 'Title ask:a',
    });
    // Opening a row pushes a new entry, whose previous entry is item a, not the Overview.
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Inbox list' })).getByRole('button', {
        name: /Title ask:b/,
      })
    );
    await within(itemPane()).findByRole('heading', { name: 'Title ask:b' });
    const header = screen.getByRole('banner');
    fireEvent.click(within(header).getByRole('button', { name: 'Back to Overview' }));
    await waitFor(() => expect(location).toBe('/projects/p1/overview'));
  });

  it('browsing by chip drops the way back: Back returns to the list again', async () => {
    server.items = [item({ ref: 'ask:a' })];
    installFetch(server);
    renderInbox(fromOverview('ask:a'));
    await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('heading', {
      name: 'Title ask:a',
    });
    expect(
      within(screen.getByRole('banner')).getByRole('button', { name: 'Back to Overview' })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Blocking/ }));
    await waitFor(() => expect(location).toContain('filter=blocking'));
    expect(location).not.toContain('from=');
    expect(screen.queryByRole('button', { name: 'Back to Overview' })).not.toBeInTheDocument();
  });

  it('the cross-project inbox never offers Back to Overview', async () => {
    server.items = [item({ ref: 'ask:a' })];
    installFetch(server);
    renderInbox(
      `/inbox?${new URLSearchParams({ item: 'ask:a', project: 'p1', from: 'overview' }).toString()}`
    );
    await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('heading', {
      name: 'Title ask:a',
    });
    expect(screen.queryByRole('button', { name: 'Back to Overview' })).not.toBeInTheDocument();
  });

  it('answering marks the Overview read stale, so Running now is fresh on the way back', async () => {
    mobile.value = true;
    server.items = [item({ ref: 'ask:a' }), item({ ref: 'ask:b' })];
    installFetch(server);
    const { client } = renderInbox(fromOverview('ask:a'));
    const overviewKey = ['auth', 'user-1', 'project-overview', 'p1'];
    client.setQueryData(overviewKey, { projectId: 'p1' });
    await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('heading', {
      name: 'Title ask:a',
    });
    expect(client.getQueryState(overviewKey)?.isInvalidated).toBe(false);
    fireEvent.click(within(itemPane()).getByRole('button', { name: 'Yes' }));
    await within(itemPane()).findByRole('heading', { name: 'Title ask:b' });
    expect(client.getQueryState(overviewKey)?.isInvalidated).toBe(true);
  });

  it('opened from the inbox itself, Back stays in the inbox (control)', async () => {
    mobile.value = true;
    server.items = [item({ ref: 'ask:a' })];
    installFetch(server);
    renderInbox(`/projects/p1/inbox?item=ask%3Aa`);
    await within(await screen.findByRole('region', { name: 'Inbox item' })).findByRole('heading', {
      name: 'Title ask:a',
    });
    expect(screen.queryByRole('button', { name: 'Back to Overview' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to inbox' }));
    await waitFor(() => expect(location).toBe('/projects/p1/inbox'));
  });
});
