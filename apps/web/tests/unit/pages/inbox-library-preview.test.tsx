/**
 * A Library file linked from an inbox item opens over the inbox, not on the Library page
 * (Raphaël, 2026-11-20: "when they click the x, they should see the inbox, not the library").
 *
 * Driven through the real inbox page, the real link chip, the app's `LibraryPreviewProvider` and
 * the Library's own viewer, with the network mocked at `fetch`. The router is a memory router, so
 * "Back" is the router going back one entry, exactly what a phone's Back button does.
 */
import type { InboxItem } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  MemoryRouter,
  type NavigateFunction,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock('../../../src/hooks/useIsMobile', () => ({ useIsMobile: () => mobile.value }));
vi.mock('../../../src/components/AuthProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/components/AuthProvider')>()),
  useAuth: () => ({ user: { id: 'user-1' }, isSuperadmin: false, isLoading: false }),
}));

const { InboxPage } = await import('../../../src/pages/inbox/InboxPage');
const { LibraryPreviewProvider, LIBRARY_PREVIEW_STATE_KEY } =
  await import('../../../src/components/library/LibraryPreviewProvider');

const FILE_ID = 'F1';
const FILENAME = 'quarterly-roadmap-screenshot.png';

function inboxItem(): InboxItem {
  return {
    store: 'ask',
    kind: 'question',
    projectId: 'p1',
    projectName: 'Acme',
    sessionId: 's1',
    topic: 'Roadmap',
    taskId: 't1',
    stackKey: 'ask:a',
    ref: 'ask:a',
    title: 'Does this roadmap look right?',
    body: 'I drafted it from the planning notes.',
    blocking: true,
    agentState: 'waiting',
    status: 'open',
    createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    expiresAt: null,
    dueAt: null,
    answerSpec: { type: 'text' },
    links: [
      { kind: 'file', id: FILE_ID, label: 'Roadmap screenshot' },
      { kind: 'idea', id: 'idea-1', label: 'Roadmap idea' },
    ],
    canAct: true,
    untrustedContent: true,
  };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let requests: string[];

function installFetch() {
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = decodeURIComponent(url.pathname);
      requests.push(`${method} ${path}`);
      const item = inboxItem();
      if (/\/inbox\/count$/.test(path)) return json(200, { needsYou: 1, blocking: 1 });
      if (/\/inbox$/.test(path)) return json(200, { items: [item], nextCursor: null, skipped: 0 });
      if (/\/inbox\/items\//.test(path))
        return json(200, {
          item,
          context: { before: [], since: { messages: [], activityCount: 0, truncated: false } },
        });
      if (path === `/api/projects/p1/library/${FILE_ID}`)
        return json(200, {
          file: {
            id: FILE_ID,
            projectId: 'p1',
            filename: FILENAME,
            directory: '/',
            mimeType: 'image/png',
            sizeBytes: 4_200_000,
            description: null,
            uploadedBy: 'user-1',
            uploadSource: 'agent',
            uploadSessionId: null,
            uploadTaskId: null,
            replacedAt: null,
            replacedBy: null,
            status: 'ready',
            extractedTextPreview: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          tags: [],
        });
      if (path.startsWith('/api/notifications'))
        return json(200, { notifications: [], unreadCount: 0, nextCursor: null });
      return json(404, { error: 'NOT_FOUND', message: 'Not found' });
    })
  );
}

let location = { pathname: '', search: '', state: null as unknown };
let navigate: NavigateFunction = () => undefined;
function RouterProbe() {
  const current = useLocation();
  location = { pathname: current.pathname, search: current.search, state: current.state };
  navigate = useNavigate();
  return null;
}

/** The app's layout: the provider sits above every routed page (`App.tsx` `ProtectedLayout`). */
function Layout() {
  return (
    <LibraryPreviewProvider>
      <Outlet />
      <RouterProbe />
    </LibraryPreviewProvider>
  );
}

type Entry = string | { pathname: string; search?: string; state?: unknown };

function renderInbox(entries: Entry[] = ['/inbox?item=ask%3Aa&project=p1']) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/inbox" element={<InboxPage projectId={null} />} />
            <Route path="/projects/:id/library" element={<h1>Library page</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const fileChip = () => screen.findByRole('link', { name: /Roadmap screenshot/ });
const previewDialog = () => screen.findByRole('dialog', { name: FILENAME });

beforeEach(() => {
  mobile.value = false;
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Library references in the inbox open in place', () => {
  it('opens the preview over the inbox, keeps the URL and returns focus to the chip on close', async () => {
    renderInbox();
    const chip = await fileChip();
    const pane = screen.getByRole('region', { name: 'Inbox item' });
    // Half-typed text in the answer box must survive the preview.
    const answerBox = within(pane).getByRole('textbox');
    fireEvent.change(answerBox, { target: { value: 'Mostly, but' } });

    chip.focus();
    fireEvent.click(chip);

    const dialog = await previewDialog();
    // The Library's own viewer shows the file (its image stays hidden until it loads).
    await waitFor(() =>
      expect(dialog.querySelector(`img[alt="${FILENAME}"]`)).toHaveAttribute(
        'src',
        expect.stringContaining(`/library/${FILE_ID}/preview`)
      )
    );
    // The URL is still the inbox item, not the Library.
    expect(location.pathname).toBe('/inbox');
    expect(location.search).toBe('?item=ask%3Aa&project=p1');
    // The inbox is still rendered underneath: same pane, same text box, same text.
    expect(screen.getByRole('region', { name: 'Inbox item' })).toBe(pane);
    expect(within(pane).getByRole('textbox')).toBe(answerBox);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close preview' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(location.pathname).toBe('/inbox');
    expect(document.activeElement).toBe(chip);
    expect(within(pane).getByRole('textbox')).toHaveValue('Mostly, but');
    expect(screen.getByRole('region', { name: 'Inbox item' })).toBe(pane);
  });

  it('Back closes the preview and stays on the inbox item', async () => {
    renderInbox();
    fireEvent.click(await fileChip());
    await previewDialog();

    act(() => navigate(-1));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(location.pathname).toBe('/inbox');
    expect(location.search).toBe('?item=ask%3Aa&project=p1');
    expect(screen.getByRole('heading', { name: 'Does this roadmap look right?' })).toBeVisible();
  });

  it('Escape closes the preview', async () => {
    renderInbox();
    fireEvent.click(await fileChip());
    await previewDialog();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(location.pathname).toBe('/inbox');
  });

  it('Escape closes an open comments panel before the preview, and never a typed answer', async () => {
    renderInbox();
    fireEvent.click(await fileChip());
    const dialog = await previewDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show comments' }));
    expect(await screen.findByRole('complementary', { name: 'File comments' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'File comments' })).not.toBeInTheDocument()
    );
    expect(screen.getByRole('dialog', { name: FILENAME })).toBeInTheDocument();

    // Focus in a field with text: Escape leaves everything open.
    const box = document.createElement('textarea');
    box.value = 'half a comment';
    dialog.appendChild(box);
    box.focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: FILENAME })).toBeInTheDocument();
    box.remove();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('on a phone the preview is full screen with a visible close control', async () => {
    mobile.value = true;
    renderInbox();
    fireEvent.click(await fileChip());
    const dialog = await previewDialog();

    const root = dialog.closest('[data-testid="library-preview-root"]');
    expect(root).toHaveAttribute('data-presentation', 'screen');
    expect(within(dialog).getByRole('button', { name: 'Close preview' })).toBeVisible();
  });

  it('on desktop the preview floats over the page', async () => {
    renderInbox();
    fireEvent.click(await fileChip());
    const dialog = await previewDialog();

    const root = dialog.closest('[data-testid="library-preview-root"]');
    expect(root).toHaveAttribute('data-presentation', 'overlay');
  });

  it('"Open in Library" goes to the Library on that file', async () => {
    renderInbox();
    fireEvent.click(await fileChip());
    const dialog = await previewDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Open in Library' }));

    expect(await screen.findByRole('heading', { name: 'Library page' })).toBeInTheDocument();
    expect(location.pathname).toBe('/projects/p1/library');
    expect(location.search).toBe(`?preview=${FILE_ID}`);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the page own history state while open, and removes only the preview on close', async () => {
    renderInbox([
      { pathname: '/inbox', search: '?item=ask%3Aa&project=p1', state: { pageKey: true } },
    ]);
    fireEvent.click(await fileChip());
    await previewDialog();
    expect(location.state).toMatchObject({ pageKey: true, [LIBRARY_PREVIEW_STATE_KEY]: {} });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(location.state).toEqual({ pageKey: true });
  });

  it('a preview restored on the first entry of a tab closes without leaving the page', async () => {
    renderInbox([
      {
        pathname: '/inbox',
        search: '?item=ask%3Aa&project=p1',
        state: { [LIBRARY_PREVIEW_STATE_KEY]: { projectId: 'p1', fileId: FILE_ID } },
      },
    ]);
    const dialog = await previewDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close preview' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(location.pathname).toBe('/inbox');
    expect(location.state).toBeNull();
    expect(screen.getByRole('region', { name: 'Inbox item' })).toBeInTheDocument();
  });

  it('a modified click is left to the browser (a new tab on the Library)', async () => {
    renderInbox();
    const chip = await fileChip();
    expect(chip).toHaveAttribute('href', `/projects/p1/library?preview=${FILE_ID}`);

    fireEvent.click(chip, { ctrlKey: true });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(location.pathname).toBe('/inbox');
    // Liveness: the inbox item is rendered, so the absence above is not a blank page.
    expect(screen.getByRole('heading', { name: 'Does this roadmap look right?' })).toBeVisible();
  });

  it('other link kinds still navigate', async () => {
    renderInbox();
    const ideaChip = await screen.findByRole('link', { name: /Roadmap idea/ });
    expect(ideaChip).not.toHaveAttribute('aria-haspopup');
    expect(ideaChip.getAttribute('href')).toContain('/ideas/idea-1');
  });
});
