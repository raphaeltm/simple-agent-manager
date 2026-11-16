/**
 * The inbox icon (bell slot), its desktop quick view and the nav counts (slice C), through the
 * real components with `fetch` mocked at the edge.
 */
import type { InboxItem } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock('../../../src/hooks/useIsMobile', () => ({ useIsMobile: () => mobile.value }));
vi.mock('../../../src/hooks/usePushSubscription', () => ({
  usePushSubscription: () => ({
    supported: false,
    isLoading: false,
    isSubscribed: false,
    permission: 'default',
  }),
}));
vi.mock('../../../src/hooks/useSamSettings', () => ({
  useSamSettings: () => ({ enabled: false }),
}));
vi.mock('../../../src/components/onboarding', () => ({
  useOnboarding: () => ({ needsOnboarding: false, openOnboarding: vi.fn() }),
}));
vi.mock('../../../src/components/AuthProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/components/AuthProvider')>()),
  useAuth: () => ({ user: { id: 'user-1' }, isSuperadmin: false, isLoading: false }),
}));

const { InboxButton } = await import('../../../src/components/inbox/InboxButton');
const { NavSidebar } = await import('../../../src/components/NavSidebar');

function item(overrides: Partial<InboxItem> & { ref: string }): InboxItem {
  return {
    store: 'ask',
    kind: 'question',
    projectId: 'p1',
    projectName: 'Acme',
    sessionId: 's1',
    topic: 'Chat',
    taskId: 't1',
    stackKey: overrides.ref,
    title: `Title ${overrides.ref}`,
    body: null,
    blocking: true,
    agentState: 'waiting',
    status: 'open',
    createdAt: new Date().toISOString(),
    expiresAt: null,
    dueAt: null,
    answerSpec: { type: 'options', options: ['Yes', 'No'], allowText: false },
    links: [],
    canAct: true,
    untrustedContent: true,
    ...overrides,
  };
}

const ITEMS: InboxItem[] = [
  item({
    ref: 'attention:s1:m1',
    store: 'attention',
    kind: 'permission',
    answerSpec: { type: 'interaction', interactionId: 'int-1', interactionKind: 'permission' },
  }),
  item({ ref: 'ask:short' }),
  item({
    ref: 'ask:many',
    answerSpec: { type: 'options', options: ['a', 'b', 'c', 'd'], allowText: false },
  }),
  item({
    ref: 'ask:long-option',
    answerSpec: {
      type: 'options',
      options: ['Yes', 'A much longer option that needs reading first'],
      allowText: false,
    },
  }),
  item({ ref: 'ask:review', kind: 'review', answerSpec: { type: 'acknowledge' } }),
  item({
    ref: 'secret:x',
    store: 'secret',
    kind: 'secret',
    answerSpec: { type: 'secret', envKey: 'K', requestId: 'x' },
  }),
];

const calls: { method: string; path: string; body: unknown }[] = [];

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  mobile.value = false;
  calls.length = 0;
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
      if (path === '/api/inbox/count') return json(200, { needsYou: 6, blocking: 4 });
      if (path === '/api/projects/p1/inbox/count') return json(200, { needsYou: 2, blocking: 1 });
      if (path === '/api/inbox') return json(200, { items: ITEMS, nextCursor: null, skipped: 0 });
      if (path.endsWith('/interactions/int-1'))
        return json(200, {
          summary: { interactionId: 'int-1', state: 'pending' },
          detail: {
            title: 'Run it',
            options: [
              { id: 'o-allow', name: 'Allow once', kind: 'allow_once' },
              { id: 'o-always', name: 'Always allow', kind: 'allow_always' },
              { id: 'o-deny', name: 'Deny', kind: 'reject_once' },
            ],
          },
        });
      if (path.endsWith('/answer'))
        return json(200, { ref: 'x', outcome: 'answered', agentNotified: true });
      return json(200, {});
    })
  );
});

afterEach(() => vi.unstubAllGlobals());

let location = '';
function Probe() {
  location = `${useLocation().pathname}${useLocation().search}`;
  return null;
}

function renderWith(ui: React.ReactNode, entry = '/dashboard') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                {ui}
                <Probe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Inbox icon', () => {
  it('shows the cross-project count and opens the quick view on desktop', async () => {
    renderWith(<InboxButton />);
    const button = await screen.findByRole('button', { name: 'Inbox, 6 need you' });
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Inbox quick view' });
    await within(dialog).findByText('Title ask:short');
    expect(location).toBe('/dashboard');
  });

  it('offers one tap only where it is safe', async () => {
    renderWith(<InboxButton />);
    fireEvent.click(await screen.findByRole('button', { name: /Inbox, 6/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Inbox quick view' });
    const row = (ref: string) =>
      within(dialog).getByText(`Title ${ref}`).closest('[data-testid="inbox-row"]') as HTMLElement;
    await within(dialog).findByText('Title ask:short');
    // Two short options: one tap.
    expect(within(row('ask:short')).getByRole('button', { name: 'Yes' })).toBeInTheDocument();
    // Four options, or a long one, or a secret: open the item instead.
    expect(within(row('ask:many')).queryByRole('button', { name: 'a' })).not.toBeInTheDocument();
    expect(
      within(row('ask:long-option')).queryByRole('button', { name: 'Yes' })
    ).not.toBeInTheDocument();
    expect(within(row('secret:x')).getAllByRole('button')).toHaveLength(1);
    // Review: "Looks good". Permission: Allow / Deny once, never "always".
    expect(
      within(row('ask:review')).getByRole('button', { name: 'Looks good' })
    ).toBeInTheDocument();
    await within(row('attention:s1:m1')).findByRole('button', { name: 'Allow once' });
    expect(
      within(row('attention:s1:m1')).queryByRole('button', { name: 'Always allow' })
    ).not.toBeInTheDocument();
    fireEvent.click(within(row('attention:s1:m1')).getByRole('button', { name: 'Allow once' }));
    await within(row('attention:s1:m1')).findByText(/Sent “Allow once”/);
    expect(calls.find((c) => c.path.endsWith('/answer'))).toMatchObject({
      path: '/api/projects/p1/inbox/items/attention:s1:m1/answer',
      body: { optionId: 'o-allow' },
    });
  });

  it('opens an item on the Inbox page', async () => {
    renderWith(<InboxButton />);
    fireEvent.click(await screen.findByRole('button', { name: /Inbox, 6/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Inbox quick view' });
    fireEvent.click(await within(dialog).findByRole('button', { name: /Title ask:many/ }));
    await waitFor(() => expect(location).toBe('/inbox?item=ask%3Amany&project=p1'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('on a phone opens the Inbox page instead of a quick view', async () => {
    mobile.value = true;
    renderWith(<InboxButton />);
    fireEvent.click(await screen.findByRole('button', { name: /Inbox, 6/ }));
    await waitFor(() => expect(location).toBe('/inbox'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Inbox nav items', () => {
  it('global nav counts every project', async () => {
    renderWith(<NavSidebar />);
    expect(await screen.findByRole('link', { name: 'Inbox, 6' })).toHaveAttribute('href', '/inbox');
  });

  it('project nav counts that project, and Notifications is gone', async () => {
    renderWith(<NavSidebar projectName="Acme" showGlobalNav={false} />, '/projects/p1/chat');
    const projectNav = screen.getByRole('navigation', { name: 'Project navigation' });
    expect(await within(projectNav).findByRole('link', { name: 'Inbox, 2' })).toHaveAttribute(
      'href',
      '/projects/p1/inbox'
    );
    expect(
      within(projectNav).queryByRole('link', { name: /Notifications/ })
    ).not.toBeInTheDocument();
  });
});
