/**
 * The Ideas list, rendered, with each Needs-you action performed as a person would.
 *
 * Only the API client is mocked: the grouping, the three-card cap, the mutations and the
 * refresh all run for real, so a button that collects a click and drops it would fail here.
 */
import type { IdeaDerivedStatus, IdeaListItem } from '@simple-agent-manager/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithQuery } from '../../test-utils/query-test-utils';

const mocks = vi.hoisted(() => ({
  listProjectIdeas: vi.fn(),
  setProjectIdeaStatus: vi.fn(),
  keepProjectIdeaOpen: vi.fn(),
  createProjectIdea: vi.fn(),
  navigate: vi.fn(),
  isMobile: false,
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listProjectIdeas: mocks.listProjectIdeas,
  setProjectIdeaStatus: mocks.setProjectIdeaStatus,
  keepProjectIdeaOpen: mocks.keepProjectIdeaOpen,
  createProjectIdea: mocks.createProjectIdea,
}));

// The Start work sheet reads the idea's linked work, and `query-options/links.ts` imports
// `api/links` directly, so the barrel mock above does not intercept it.
vi.mock('../../../src/lib/api/links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/links')>()),
  getIdeaLinks: vi.fn().mockResolvedValue({
    sessions: { items: [], total: 0, truncated: false, totalIsLowerBound: false },
    files: { items: [], total: 0, truncated: false, totalIsLowerBound: false },
    pullRequests: { items: [], total: 0, truncated: false, totalIsLowerBound: false },
    relatedIdeas: { items: [], total: 0, truncated: false, totalIsLowerBound: false },
  }),
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock('../../../src/pages/ProjectContext', () => ({
  useProjectContext: () => ({ projectId: 'proj-1', project: { name: 'Payments API' } }),
}));

vi.mock('../../../src/hooks/useIsMobile', () => ({
  useIsMobile: () => mocks.isMobile,
}));

vi.mock('../../../src/hooks/useQueryScope', () => ({
  useQueryScope: () => 'user-1',
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => mocks.toast,
}));

import { IdeasListPage } from '../../../src/pages/ideas/IdeasListPage';

function derived(overrides: Partial<IdeaDerivedStatus> = {}): IdeaDerivedStatus {
  return {
    state: 'not-started',
    needsYou: null,
    source: { origin: 'none', observedAt: null, stale: false },
    session: null,
    pullRequest: null,
    note: null,
    ...overrides,
  };
}

function idea(overrides: Partial<IdeaListItem> = {}): IdeaListItem {
  return {
    ideaId: 'idea-1',
    title: 'Retry failed webhook deliveries',
    summary: 'Retry with exponential backoff for up to 3 days.',
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    derived: derived(),
    counts: { updates: 0, chats: 0, files: 0, pullRequests: 0 },
    filedByAgent: false,
    filedBy: null,
    viaConnector: null,
    ...overrides,
  };
}

const MERGED = idea({
  ideaId: 'idea-merged',
  title: 'Rate-limit the delivery log',
  derived: derived({
    state: 'merged',
    needsYou: 'merged',
    pullRequest: {
      url: 'https://github.com/acme/payments/pull/482',
      number: 482,
      state: 'merged',
      isDraft: false,
      title: 'Rate limits',
      checksState: 'success',
      mergedAt: '2026-10-23T08:00:00.000Z',
      updatedAt: '2026-10-23T08:00:00.000Z',
      stale: false,
    },
  }),
});

const STUCK = idea({
  ideaId: 'idea-stuck',
  title: 'Backfill the delivery index',
  derived: derived({
    state: 'stuck',
    needsYou: 'stuck',
    note: 'the suite went red',
    session: {
      sessionId: 'sess-failed',
      topic: 'Backfilling',
      sessionStatus: 'stopped',
      taskId: 'task-1',
      taskStatus: 'failed',
      agentLabel: 'Codex',
      lastActivityAt: '2026-10-23T10:00:00.000Z',
    },
  }),
});

const QUESTION = idea({
  ideaId: 'idea-question',
  title: 'Retry schedule',
  derived: derived({
    state: 'question',
    needsYou: 'question',
    note: 'Cap retries at 3 days?',
    session: {
      sessionId: 'sess-asking',
      topic: 'Deciding the window',
      sessionStatus: 'active',
      taskId: 'task-2',
      taskStatus: 'in_progress',
      agentLabel: 'Opus 5.5',
      lastActivityAt: '2026-10-23T11:58:00.000Z',
    },
  }),
});

function respondWith(items: IdeaListItem[], overrides: Record<string, unknown> = {}) {
  mocks.listProjectIdeas.mockResolvedValue({
    items,
    truncated: false,
    totals: { open: items.length, done: 0, parked: 0 },
    ...overrides,
  });
}

function renderPage() {
  return renderWithQuery(
    <MemoryRouter>
      <IdeasListPage />
    </MemoryRouter>
  );
}

describe('IdeasListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isMobile = false;
    respondWith([]);
    mocks.setProjectIdeaStatus.mockResolvedValue({});
    mocks.keepProjectIdeaOpen.mockResolvedValue({});
  });

  it('invites you to file the first idea when there are none', async () => {
    renderPage();
    expect(await screen.findByText('No ideas yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'File your first idea' })).toBeInTheDocument();
  });

  it('shows what needs you first, above everything else', async () => {
    respondWith([
      idea({ ideaId: 'idea-fresh', title: 'Something not started' }),
      STUCK,
      idea({
        ideaId: 'idea-working',
        title: 'Being built',
        derived: derived({ state: 'working' }),
      }),
    ]);
    renderPage();

    const needsYou = await screen.findByTestId('ideas-needs-you');
    expect(within(needsYou).getByText(/^Work stopped/)).toBeInTheDocument();
    expect(within(needsYou).getByText('the suite went red')).toBeInTheDocument();

    const headings = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
    expect(headings[0]).toContain('Needs you');
    expect(headings.join(' ')).toContain('In progress');
    expect(headings.join(' ')).toContain('Not started');
  });

  it('shows at most three cards, then offers the rest without hiding them', async () => {
    const extra = Array.from({ length: 4 }, (_, index) =>
      idea({
        ideaId: `idea-stuck-${index}`,
        title: `Stopped work ${index}`,
        derived: derived({
          state: 'stuck',
          needsYou: 'stuck',
          note: `Step ${index} failed. The suite went red and nothing else is running.`,
        }),
      })
    );
    respondWith(extra);
    renderPage();

    const needsYou = await screen.findByTestId('ideas-needs-you');
    const headlines = within(needsYou).getAllByText(/^Work stopped/);
    expect(headlines).toHaveLength(3);
    // A bad day stacks these up, so each one has to say what stopped. Three identical
    // headlines would be unscannable, which is what shipped before.
    expect(new Set(headlines.map((node) => node.textContent)).size).toBe(3);
    const more = within(needsYou).getByRole('button', { name: /1 more need you/i });

    await userEvent.click(more);
    expect(within(needsYou).getAllByText(/^Work stopped/)).toHaveLength(4);
  });

  it('Answer opens the chat that asked', async () => {
    respondWith([QUESTION]);
    renderPage();

    const answer = await screen.findByRole('link', { name: 'Answer' });
    expect(answer).toHaveAttribute('href', '/projects/proj-1/chat/sess-asking');
  });

  it('leads a stopped run with See what happened, and offers Try again beside it', async () => {
    respondWith([STUCK]);
    renderPage();

    const card = await screen.findByTestId('ideas-needs-you');
    const read = await within(card).findByRole('link', { name: 'See what happened' });
    const retry = within(card).getByRole('button', { name: 'Try again…' });

    // Order matters: reading the failure comes before retrying it.
    expect(read.compareDocumentPosition(retry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(read).toHaveAttribute('href', '/projects/proj-1/chat/sess-failed');
  });

  /*
   * Try again is a `start-work` action, and this is the surface that proves the dead link is
   * gone. It used to be a `<Link>` to `/chat?executeIdea=<id>`, whose reader had already been
   * removed with the Start work sheet — so the retry a person pressed on a stopped idea
   * silently dropped the idea and opened an empty chat. The old test asserted that href and
   * passed throughout.
   */
  it('opens the Start work sheet from Try again, rather than linking to a dropped parameter', async () => {
    respondWith([STUCK]);
    renderPage();

    const card = await screen.findByTestId('ideas-needs-you');
    const retry = within(card).getByRole('button', { name: 'Try again…' });
    expect(retry).not.toHaveAttribute('href');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await userEvent.click(retry);

    const sheet = await screen.findByRole('dialog', { name: /Start work|Talk it through/i });
    // The sheet must name the idea being retried, not merely open.
    expect(within(sheet).getByText('Backfill the delivery index')).toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('Mark done tells the server, and refreshes the list rather than reloading', async () => {
    respondWith([MERGED]);
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Mark done' }));

    await waitFor(() =>
      expect(mocks.setProjectIdeaStatus).toHaveBeenCalledWith('proj-1', 'idea-merged', 'completed')
    );
    expect(mocks.toast.success).toHaveBeenCalledWith('Marked done');
    // The list is read again; nothing navigates and nothing reloads.
    await waitFor(() => expect(mocks.listProjectIdeas.mock.calls.length).toBeGreaterThan(1));
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('Keep open records the answer without changing the status', async () => {
    respondWith([MERGED]);
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Keep open' }));

    await waitFor(() =>
      expect(mocks.keepProjectIdeaOpen).toHaveBeenCalledWith('proj-1', 'idea-merged')
    );
    expect(mocks.setProjectIdeaStatus).not.toHaveBeenCalled();
    expect(mocks.toast.success).toHaveBeenCalledWith('Kept open');
  });

  it('says so when a decision could not be recorded, and leaves the card up', async () => {
    respondWith([MERGED]);
    mocks.setProjectIdeaStatus.mockRejectedValue(new Error('Idea not found in this project'));
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Mark done' }));

    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith('Idea not found in this project')
    );
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeInTheDocument();
  });

  it('links every row to its own idea', async () => {
    respondWith([idea({ ideaId: 'idea-fresh', title: 'Something not started' })]);
    renderPage();

    const row = await screen.findByTestId('idea-row');
    expect(row).toHaveAttribute('href', '/projects/proj-1/ideas/idea-fresh');
    expect(within(row).getByText('Something not started')).toBeInTheDocument();
  });

  it('folds agent-filed ideas away, and keeps them reachable', async () => {
    respondWith([
      idea({ ideaId: 'idea-fresh', title: 'A human idea' }),
      idea({
        ideaId: 'idea-incident',
        title: 'TypeError in the delivery worker',
        filedByAgent: true,
        filedBy: 'incident',
      }),
    ]);
    renderPage();

    await screen.findByText('A human idea');
    expect(screen.queryByText('TypeError in the delivery worker')).not.toBeVisible();
    const disclosure = screen.getByTestId('ideas-filed-by-agents');
    expect(within(disclosure).getByText(/Filed by agents · 1/)).toBeInTheDocument();
  });

  it('filters by what you type, and says when nothing matches', async () => {
    respondWith([
      idea({ ideaId: 'idea-a', title: 'Retry failed webhook deliveries' }),
      idea({ ideaId: 'idea-b', title: 'Rotate the signing key', summary: null }),
    ]);
    renderPage();

    await screen.findByText('Retry failed webhook deliveries');
    await userEvent.type(screen.getByRole('searchbox', { name: /search ideas/i }), 'signing');

    await waitFor(() =>
      expect(screen.queryByText('Retry failed webhook deliveries')).not.toBeInTheDocument()
    );
    expect(screen.getByText('Rotate the signing key')).toBeInTheDocument();

    await userEvent.clear(screen.getByRole('searchbox', { name: /search ideas/i }));
    await userEvent.type(screen.getByRole('searchbox', { name: /search ideas/i }), 'kubernetes');
    expect(await screen.findByText(/No ideas match/)).toBeInTheDocument();
  });

  it('files a new idea and opens it', async () => {
    respondWith([idea()]);
    mocks.createProjectIdea.mockResolvedValue({ ideaId: 'idea-new' });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /new idea/i }));
    await userEvent.type(
      screen.getByRole('textbox', { name: /what do you want done/i }),
      'Rotate the signing key'
    );
    await userEvent.click(screen.getByRole('button', { name: 'File it' }));

    await waitFor(() =>
      expect(mocks.createProjectIdea).toHaveBeenCalledWith('proj-1', {
        title: 'Rotate the signing key',
        content: undefined,
      })
    );
    expect(mocks.navigate).toHaveBeenCalledWith('/projects/proj-1/ideas/idea-new');
  });

  it('will not file an idea with no title', async () => {
    respondWith([idea()]);
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /new idea/i }));
    expect(screen.getByRole('button', { name: 'File it' })).toBeDisabled();
    expect(mocks.createProjectIdea).not.toHaveBeenCalled();
  });

  it('keeps the list on screen while it refreshes, instead of flashing a spinner', async () => {
    // Driven through the real trigger: marking an idea done invalidates the list, so a
    // refetch is genuinely in flight while the page is rendered (rules 48, 62).
    respondWith([MERGED]);
    renderPage();
    await screen.findByText('Rate-limit the delivery log');

    let release: (value: unknown) => void = () => {};
    const inFlight = new Promise((resolve) => {
      release = resolve;
    });
    mocks.listProjectIdeas.mockReturnValueOnce(inFlight as Promise<never>);

    await userEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(mocks.listProjectIdeas.mock.calls.length).toBeGreaterThan(1));

    // The refetch has not landed yet, and the list is still there.
    expect(screen.getByText('Rate-limit the delivery log')).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading ideas')).not.toBeInTheDocument();

    release({
      items: [MERGED],
      truncated: false,
      totals: { open: 1, done: 0, parked: 0 },
    });
    await waitFor(() => expect(screen.getByText('Rate-limit the delivery log')).toBeVisible());
  });

  it('offers a retry when the list cannot be read at all', async () => {
    mocks.listProjectIdeas.mockRejectedValue(new Error('network down'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load your ideas/);
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(mocks.listProjectIdeas.mock.calls.length).toBeGreaterThan(1));
  });

  it('on a phone, the side column folds into disclosures instead of disappearing', async () => {
    mocks.isMobile = true;
    respondWith([
      idea({ ideaId: 'idea-fresh', title: 'A human idea' }),
      idea({ ideaId: 'idea-done', title: 'Already shipped', derived: derived({ state: 'done' }) }),
    ]);
    renderPage();

    await screen.findByText('A human idea');
    expect(screen.getByTestId('ideas-done-recently')).toBeInTheDocument();
    expect(screen.queryByText('Ideas move on their own')).not.toBeInTheDocument();
  });
});
