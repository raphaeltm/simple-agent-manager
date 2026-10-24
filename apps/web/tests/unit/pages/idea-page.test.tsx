/**
 * The idea page, rendered, with every state-dependent action performed as a person would.
 *
 * The rule the old page broke is the one asserted hardest here: there is exactly one primary
 * action, and it follows the state instead of staying "Execute" forever.
 */
import type { IdeaDerivedStatus } from '@simple-agent-manager/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdeaDetail } from '../../../src/lib/api';
import { renderWithQuery } from '../../test-utils/query-test-utils';

const mocks = vi.hoisted(() => ({
  getProjectIdea: vi.fn(),
  setProjectIdeaStatus: vi.fn(),
  keepProjectIdeaOpen: vi.fn(),
  listIdeaUpdates: vi.fn(),
  postIdeaUpdate: vi.fn(),
  getIdeaLinks: vi.fn(),
  updateProjectTask: vi.fn(),
  navigate: vi.fn(),
  isMobile: false,
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getProjectIdea: mocks.getProjectIdea,
  setProjectIdeaStatus: mocks.setProjectIdeaStatus,
  keepProjectIdeaOpen: mocks.keepProjectIdeaOpen,
  listIdeaUpdates: mocks.listIdeaUpdates,
  postIdeaUpdate: mocks.postIdeaUpdate,
  updateProjectTask: mocks.updateProjectTask,
}));

/*
 * `query-options/links.ts` imports `api/links` directly, as T4's chat and library surfaces
 * do, so the barrel mock above does not intercept this read. Mocking the barrel alone left
 * the real `request()` running and the Related section rendering its error state, which the
 * assertions below would not have noticed.
 */
vi.mock('../../../src/lib/api/links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/links')>()),
  getIdeaLinks: mocks.getIdeaLinks,
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useParams: () => ({ taskId: 'idea-1' }),
    useNavigate: () => mocks.navigate,
  };
});

vi.mock('../../../src/pages/ProjectContext', () => ({
  useProjectContext: () => ({ projectId: 'proj-1', project: { name: 'Payments API' } }),
}));
vi.mock('../../../src/hooks/useIsMobile', () => ({ useIsMobile: () => mocks.isMobile }));
vi.mock('../../../src/hooks/useQueryScope', () => ({ useQueryScope: () => 'user-1' }));
vi.mock('../../../src/hooks/useToast', () => ({ useToast: () => mocks.toast }));

import { IdeaPage } from '../../../src/pages/ideas/IdeaPage';

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

const SESSION = {
  sessionId: 'sess-live',
  topic: 'Building retries',
  sessionStatus: 'active',
  taskId: 'task-1',
  taskStatus: 'in_progress',
  agentLabel: 'Opus 5.5',
  lastActivityAt: '2026-10-23T11:58:00.000Z',
};

const PULL_REQUEST = {
  url: 'https://github.com/acme/payments/pull/482',
  number: 482,
  state: 'open' as const,
  isDraft: false,
  title: 'Retry failed webhook deliveries',
  checksState: 'success' as const,
  mergedAt: null,
  updatedAt: '2026-10-23T11:58:00.000Z',
  stale: false,
};

function idea(overrides: Partial<IdeaDetail> = {}): IdeaDetail {
  return {
    ideaId: 'idea-1',
    title: 'Retry failed webhook deliveries',
    content: '# What we want\n\n- Retry with exponential backoff for up to 3 days.',
    summary: 'Retry with exponential backoff for up to 3 days.',
    status: 'draft',
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    derived: derived(),
    counts: { updates: 0, chats: 0, files: 0, pullRequests: 0 },
    filedByAgent: false,
    filedBy: null,
    sessions: [],
    pullRequests: [],
    ...overrides,
  };
}

function renderPage() {
  return renderWithQuery(
    <MemoryRouter>
      <IdeaPage />
    </MemoryRouter>
  );
}

describe('IdeaPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isMobile = false;
    mocks.getProjectIdea.mockResolvedValue(idea());
    mocks.listIdeaUpdates.mockResolvedValue({ updates: [], nextCursor: null });
    mocks.getIdeaLinks.mockResolvedValue({
      sessions: { items: [], total: 0, truncated: false },
      files: { items: [], total: 0, truncated: false },
      pullRequests: { items: [], total: 0, truncated: false },
      relatedIdeas: { items: [], total: 0, truncated: false },
    });
    mocks.setProjectIdeaStatus.mockResolvedValue(idea({ status: 'completed' }));
    mocks.keepProjectIdeaOpen.mockResolvedValue(idea());
    mocks.postIdeaUpdate.mockResolvedValue({ update: {} });
    mocks.updateProjectTask.mockResolvedValue({});
  });

  it('shows the plan as the plan, not as a history of what happened', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'The idea' })).toBeInTheDocument();
    expect(screen.getByText('Always the current plan')).toBeInTheDocument();
    // The markdown is rendered, not shown raw, and the list keeps its bullet.
    const plan = screen.getByRole('region', { name: 'The idea' });
    expect(within(plan).getByRole('heading', { name: 'What we want' })).toBeInTheDocument();
    const bullets = within(plan).getByRole('list');
    expect(bullets.style.listStyleType).toBe('disc');
    expect(
      within(bullets).getByText('Retry with exponential backoff for up to 3 days.')
    ).toBeInTheDocument();
  });

  describe('the one primary action follows the state', () => {
    /*
     * Start work opens the sheet; it is not a link anywhere.
     *
     * It briefly WAS one, to `/chat?executeIdea=<id>`, and this assertion pinned that URL —
     * while the branch that read the parameter had already been removed with the sheet. The
     * href was present, the test was green, and pressing the button landed the person in an
     * empty new chat with the idea dropped. So the assertion is on the outcome a person gets.
     * `components/start-work-sheet.test.tsx` drives the rest of the flow from this page.
     */
    it('opens the Start work sheet when nothing has happened, rather than linking anywhere', async () => {
      renderPage();
      const button = await screen.findByRole('button', { name: 'Start work' });
      expect(button).not.toHaveAttribute('href');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      await userEvent.click(button);

      const sheet = await screen.findByRole('dialog', { name: /Start work|Talk it through/i });
      // The sheet asks the person to confirm work on a NAMED idea, so it must carry the title.
      expect(within(sheet).getByText('Retry failed webhook deliveries')).toBeInTheDocument();
      // Nothing navigated: starting work is the sheet's job, not the button's.
      expect(mocks.navigate).not.toHaveBeenCalled();
    });

    it('opens the chat while work is running', async () => {
      mocks.getProjectIdea.mockResolvedValue(
        idea({ derived: derived({ state: 'working', session: SESSION }) })
      );
      renderPage();
      expect(await screen.findByRole('link', { name: 'Open the chat' })).toHaveAttribute(
        'href',
        '/projects/proj-1/chat/sess-live'
      );
      expect(screen.queryByRole('button', { name: 'Start work' })).not.toBeInTheDocument();
    });

    it('answers the question while one is open, and says who asked', async () => {
      mocks.getProjectIdea.mockResolvedValue(
        idea({
          derived: derived({
            state: 'question',
            needsYou: 'question',
            session: SESSION,
            note: 'Cap retries at 3 days?',
            source: { origin: 'agent', observedAt: '2026-10-23T11:59:00.000Z', stale: false },
          }),
        })
      );
      renderPage();
      expect(await screen.findByRole('link', { name: 'Answer' })).toHaveAttribute(
        'href',
        '/projects/proj-1/chat/sess-live'
      );
      expect(screen.getByText('Waiting for you')).toBeInTheDocument();
      expect(screen.getByText(/From the agent/)).toBeInTheDocument();
    });

    it('reviews the pull request while one is open, in a new tab', async () => {
      mocks.getProjectIdea.mockResolvedValue(
        idea({ derived: derived({ state: 'review', pullRequest: PULL_REQUEST }) })
      );
      renderPage();
      const link = await screen.findByRole('link', { name: 'Review PR #482' });
      expect(link).toHaveAttribute('href', PULL_REQUEST.url);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    });

    it('asks you to decide once a pull request merged, with both answers', async () => {
      mocks.getProjectIdea.mockResolvedValue(
        idea({
          derived: derived({
            state: 'merged',
            needsYou: 'merged',
            pullRequest: { ...PULL_REQUEST, state: 'merged', mergedAt: '2026-10-23T08:00:00.000Z' },
          }),
        })
      );
      renderPage();
      expect(await screen.findByRole('button', { name: 'Mark done' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Keep open' })).toBeInTheDocument();
    });

    it('offers follow-up work on a done idea', async () => {
      mocks.getProjectIdea.mockResolvedValue(idea({ derived: derived({ state: 'done' }) }));
      renderPage();
      // Also a `start-work` action, so also the sheet rather than a link.
      expect(
        await screen.findByRole('button', { name: 'Start follow-up work' })
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
    });
  });

  it('marks the idea done through the server and refreshes rather than reloading', async () => {
    mocks.getProjectIdea.mockResolvedValue(
      idea({ derived: derived({ state: 'merged', needsYou: 'merged', pullRequest: PULL_REQUEST }) })
    );
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Mark done' }));

    await waitFor(() =>
      expect(mocks.setProjectIdeaStatus).toHaveBeenCalledWith('proj-1', 'idea-1', 'completed')
    );
    expect(mocks.toast.success).toHaveBeenCalledWith('Marked done');
    await waitFor(() => expect(mocks.getProjectIdea.mock.calls.length).toBeGreaterThan(1));
  });

  // Each of these clicks the real button and asserts the status it actually sends. The three
  // of them are one `keep-open` typo apart, and a mislabelled one shipped: "Park" on a
  // not-started idea marked it done, because nothing had ever clicked it.
  it('parks an idea nobody has started, rather than marking it done', async () => {
    mocks.getProjectIdea.mockResolvedValue(idea({ derived: derived({ state: 'not-started' }) }));
    mocks.setProjectIdeaStatus.mockResolvedValue(idea({ status: 'cancelled' }));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Park' }));

    await waitFor(() =>
      expect(mocks.setProjectIdeaStatus).toHaveBeenCalledWith('proj-1', 'idea-1', 'cancelled')
    );
    expect(mocks.toast.success).toHaveBeenCalledWith('Parked');
    // The control: Start work is still the obvious step beside it.
    expect(screen.getByRole('button', { name: 'Start work' })).toBeInTheDocument();
  });

  it('reopens a parked idea instead of only acknowledging a merge', async () => {
    mocks.getProjectIdea.mockResolvedValue(
      idea({ status: 'cancelled', derived: derived({ state: 'parked' }) })
    );
    mocks.setProjectIdeaStatus.mockResolvedValue(idea({ status: 'draft' }));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Reopen' }));

    await waitFor(() =>
      expect(mocks.setProjectIdeaStatus).toHaveBeenCalledWith('proj-1', 'idea-1', 'draft')
    );
    expect(mocks.keepProjectIdeaOpen).not.toHaveBeenCalled();
  });

  it('reopens a done idea instead of only acknowledging a merge', async () => {
    mocks.getProjectIdea.mockResolvedValue(
      idea({ status: 'completed', derived: derived({ state: 'done' }) })
    );
    mocks.setProjectIdeaStatus.mockResolvedValue(idea({ status: 'draft' }));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Reopen' }));

    await waitFor(() =>
      expect(mocks.setProjectIdeaStatus).toHaveBeenCalledWith('proj-1', 'idea-1', 'draft')
    );
    expect(mocks.keepProjectIdeaOpen).not.toHaveBeenCalled();
  });

  it('keeps the idea open without changing its status', async () => {
    mocks.getProjectIdea.mockResolvedValue(
      idea({ derived: derived({ state: 'merged', needsYou: 'merged', pullRequest: PULL_REQUEST }) })
    );
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Keep open' }));

    await waitFor(() => expect(mocks.keepProjectIdeaOpen).toHaveBeenCalledWith('proj-1', 'idea-1'));
    expect(mocks.setProjectIdeaStatus).not.toHaveBeenCalled();
  });

  describe('Work', () => {
    it('lists each chat with who worked and what came of it', async () => {
      mocks.getProjectIdea.mockResolvedValue(
        idea({
          sessions: [
            {
              sessionId: 'sess-failed',
              topic: 'First attempt',
              strong: true,
              sessionStatus: 'stopped',
              taskId: 'task-1',
              taskStatus: 'failed',
              taskErrorMessage: 'the suite went red',
              agentLabel: 'Codex',
              lastActivityAt: Date.parse('2026-10-23T09:00:00.000Z'),
              needsInput: null,
            },
          ],
          pullRequests: [PULL_REQUEST],
        })
      );
      renderPage();

      const work = await screen.findByRole('region', { name: 'Work' });
      expect(within(work).getByText('First attempt')).toBeInTheDocument();
      expect(within(work).getByText('Codex')).toBeInTheDocument();
      expect(within(work).getByText('the suite went red')).toBeInTheDocument();
      expect(within(work).getByRole('link', { name: /First attempt/ })).toHaveAttribute(
        'href',
        '/projects/proj-1/chat/sess-failed'
      );
      /*
       * The pull request's state is the shared `PullRequestStateBadge` now, not a sentence
       * this page spells out — so "Open" and "checks passed" are their own pills beside
       * "PR #482" rather than one run of text.
       */
      expect(within(work).getByText('PR #482')).toBeInTheDocument();
      expect(within(work).getByText('Open')).toBeInTheDocument();
      expect(within(work).getByText('Checks passed')).toBeInTheDocument();
      // External, and routed through the shared row so the agent-reported URL is sanitised.
      const prRow = within(work).getByRole('link', { name: /Retry failed webhook deliveries/ });
      expect(prRow).toHaveAttribute('href', 'https://github.com/acme/payments/pull/482');
      expect(prRow).toHaveAttribute('target', '_blank');
    });

    it('says plainly when nothing has worked on the idea yet', async () => {
      renderPage();
      const work = await screen.findByRole('region', { name: 'Work' });
      expect(within(work).getByText(/Nothing has worked on this yet/)).toBeInTheDocument();
    });
  });

  describe('Updates', () => {
    it('shows who wrote each note, the chat it came from, and the line it answers', async () => {
      mocks.listIdeaUpdates.mockResolvedValue({
        updates: [
          {
            id: 'u-1',
            ideaId: 'idea-1',
            authorKind: 'user',
            authorUserId: 'user-1',
            authorName: 'Marcus Chen',
            sessionId: null,
            sessionTopic: null,
            body: 'Stripe gives up after 3 days, not after 5 attempts.',
            quote: 'cap retries at 5 attempts',
            createdAt: '2026-10-21T00:00:00.000Z',
            editedAt: null,
          },
          {
            id: 'u-2',
            ideaId: 'idea-1',
            authorKind: 'agent',
            authorUserId: null,
            authorName: 'Brainstormer',
            sessionId: 'sess-research',
            sessionTopic: 'Comparing retry schedules',
            body: 'Compared how Stripe and Adyen retry webhooks.',
            quote: null,
            createdAt: '2026-10-18T00:00:00.000Z',
            editedAt: null,
          },
        ],
        nextCursor: null,
      });
      renderPage();

      const updates = await screen.findByRole('region', { name: 'Updates' });
      expect(within(updates).getByText('Marcus Chen')).toBeInTheDocument();
      expect(within(updates).getByText('cap retries at 5 attempts')).toBeInTheDocument();
      expect(
        within(updates).getByRole('link', { name: 'Comparing retry schedules' })
      ).toHaveAttribute('href', '/projects/proj-1/chat/sess-research');
    });

    it('posts a note through the real endpoint and clears the composer', async () => {
      renderPage();
      const composer = await screen.findByRole('textbox', { name: 'Add an update' });
      expect(screen.getByRole('button', { name: 'Post update' })).toBeDisabled();

      await userEvent.type(composer, 'Matching Stripe sounds right.');
      await userEvent.click(screen.getByRole('button', { name: 'Post update' }));

      await waitFor(() =>
        expect(mocks.postIdeaUpdate).toHaveBeenCalledWith('proj-1', 'idea-1', {
          body: 'Matching Stripe sounds right.',
        })
      );
      expect(composer).toHaveValue('');
      await waitFor(() => expect(mocks.listIdeaUpdates.mock.calls.length).toBeGreaterThan(1));
    });

    it('offers a retry when the updates cannot be read, without hiding the rest', async () => {
      mocks.listIdeaUpdates.mockRejectedValue(new Error('not found'));
      renderPage();

      const updates = await screen.findByRole('region', { name: 'Updates' });
      await waitFor(() =>
        expect(within(updates).getByText('Could not load the updates.')).toBeInTheDocument()
      );
      // The rest of the page is still there.
      expect(screen.getByRole('heading', { name: 'The idea' })).toBeInTheDocument();
    });
  });

  it('lists the files and ideas that linked themselves', async () => {
    mocks.getIdeaLinks.mockResolvedValue({
      sessions: { items: [], total: 0, truncated: false },
      files: {
        items: [
          {
            fileId: 'file-1',
            filename: 'retry-schedules.md',
            directory: '/research/',
            relations: ['uploaded'],
            bySessionId: 'sess-research',
          },
        ],
        total: 1,
        truncated: false,
      },
      pullRequests: { items: [], total: 0, truncated: false },
      relatedIdeas: {
        items: [
          {
            ideaId: 'idea-2',
            title: 'Rate-limit the delivery log',
            status: 'draft',
            relations: ['related'],
          },
        ],
        total: 1,
        truncated: false,
      },
    });
    renderPage();

    const related = await screen.findByRole('region', { name: 'Related' });
    expect(within(related).getByText('retry-schedules.md')).toBeInTheDocument();
    /*
     * The shared row carries the relation in plain words beside the title, so the link's
     * accessible name is the whole row rather than the title alone.
     */
    expect(
      within(related).getByRole('link', { name: /Rate-limit the delivery log/ })
    ).toHaveAttribute('href', '/projects/proj-1/ideas/idea-2');
    expect(within(related).getByText('Related')).toBeInTheDocument();
    // The file row links to the file, which it did not before: it was inert text.
    expect(within(related).getByRole('link', { name: /retry-schedules\.md/ })).toHaveAttribute(
      'href',
      '/projects/proj-1/library?preview=file-1'
    );
  });

  it('edits the plan through the task route and refreshes the page', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    const plan = screen.getByRole('textbox', { name: /the plan/i });
    await userEvent.clear(plan);
    await userEvent.type(plan, 'Retry for three days, then park the event.');
    await userEvent.click(screen.getByRole('button', { name: 'Save the plan' }));

    await waitFor(() =>
      expect(mocks.updateProjectTask).toHaveBeenCalledWith('proj-1', 'idea-1', {
        title: 'Retry failed webhook deliveries',
        description: 'Retry for three days, then park the event.',
      })
    );
    expect(mocks.toast.success).toHaveBeenCalledWith('Plan saved');
    await waitFor(() => expect(mocks.getProjectIdea.mock.calls.length).toBeGreaterThan(1));
  });

  it('will not save a plan with no title', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await userEvent.clear(screen.getByRole('textbox', { name: /what do you want done/i }));
    expect(screen.getByRole('button', { name: 'Save the plan' })).toBeDisabled();
    expect(mocks.updateProjectTask).not.toHaveBeenCalled();
  });

  it('links back to the Ideas list', async () => {
    renderPage();
    expect(await screen.findByRole('link', { name: 'Ideas' })).toHaveAttribute(
      'href',
      '/projects/proj-1/ideas'
    );
  });

  it('offers a retry when the idea itself cannot be read', async () => {
    mocks.getProjectIdea.mockRejectedValue(new Error('Idea not found in this project'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load this idea/);
  });

  it('on a phone, the status card comes first and its buttons are full width', async () => {
    mocks.isMobile = true;
    renderPage();

    const status = await screen.findByRole('region', { name: 'Status' });
    expect(within(status).getByRole('button', { name: 'Start work' })).toHaveClass('w-full');
    const regions = screen.getAllByRole('region').map((node) => node.getAttribute('aria-label'));
    expect(regions.indexOf('Status')).toBeLessThan(regions.indexOf('The idea'));
  });
});
