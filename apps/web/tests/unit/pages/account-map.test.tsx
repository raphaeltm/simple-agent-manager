/**
 * Rendered tests for the Account Map page: real QueryClient, real model, the API mocked.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAccountMap: vi.fn(),
  isMobile: false,
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getAccountMap: mocks.getAccountMap,
}));

vi.mock('../../../src/hooks/useIsMobile', () => ({
  useIsMobile: () => mocks.isMobile,
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user_123', email: 'dev@example.com', name: 'Dev User' } }),
}));

import { AccountMap } from '../../../src/pages/AccountMap';
import { accountMapFixture } from '../components/account-map/fixtures';

// jsdom has no ResizeObserver; the columns only need it to exist.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

function renderAccountMap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/account-map']}>
        <AccountMap />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const pathBar = () => screen.getByRole('list', { name: 'How this connects' });

describe('AccountMap page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isMobile = false;
    mocks.getAccountMap.mockResolvedValue(accountMapFixture());
  });

  it('shows a spinner before the first response', () => {
    mocks.getAccountMap.mockReturnValue(new Promise(() => {}));
    renderAccountMap();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('asks for active work by default', async () => {
    renderAccountMap();
    await screen.findByText('How it all connects');
    expect(mocks.getAccountMap).toHaveBeenCalledWith({ activeOnly: true });
  });

  it('draws projects, chats and tasks, and machines in their own columns', async () => {
    renderAccountMap();
    const columns = await screen.findByTestId('account-map-columns');
    const projects = columns.querySelector('[data-column="projects"]') as HTMLElement;
    const work = columns.querySelector('[data-column="work"]') as HTMLElement;
    const machines = columns.querySelector('[data-column="machines"]') as HTMLElement;
    expect(within(projects).getByText('SAM')).toBeInTheDocument();
    expect(within(work).getByText('Show wake progress')).toBeInTheDocument();
    expect(within(work).getByText('Fix subtitle drift')).toBeInTheDocument();
    expect(within(machines).getByText('sam-fsn1-01')).toBeInTheDocument();
    expect(within(machines).getByText('Not responding')).toBeInTheDocument();
    expect(within(machines).getByText('No machine')).toBeInTheDocument();
    // The quiet project waits behind its toggle.
    expect(within(projects).queryByText('Quiet project')).not.toBeInTheDocument();
    await userEvent.click(within(projects).getByRole('button', { name: 'Show 1 quiet projects' }));
    expect(within(projects).getByText('Quiet project')).toBeInTheDocument();
  });

  it('opens on the chat waiting for you and spells out its path with real links', async () => {
    renderAccountMap();
    await screen.findByTestId('account-map-columns');
    expect(screen.getByRole('button', { name: /Show wake progress/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    const bar = pathBar();
    expect(within(bar).getByRole('link', { name: 'SAM' })).toHaveAttribute(
      'href',
      '/projects/p-sam'
    );
    expect(within(bar).getByRole('link', { name: 'Wake progress you can see' })).toHaveAttribute(
      'href',
      '/projects/p-sam/ideas/i-1'
    );
    expect(
      within(bar).getByRole('link', { name: /Show wake progress: Which branch should I use\?/ })
    ).toHaveAttribute('href', '/projects/p-sam/chat/s-1');
    expect(within(bar).getByText('sam/wake-progress')).toBeInTheDocument();
    expect(within(bar).getByRole('link', { name: /sam-fsn1-01/ })).toHaveAttribute(
      'href',
      '/nodes/n-1'
    );
    const pr = within(bar).getByRole('link', { name: '#12' });
    expect(pr).toHaveAttribute('href', 'https://github.com/o/r/pull/12');
    expect(pr).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('picking another item moves the selection and its path; picking it again clears it', async () => {
    const user = userEvent.setup();
    renderAccountMap();
    await screen.findByTestId('account-map-columns');
    const task = screen.getByRole('button', { name: /Fix subtitle drift/ });
    await user.click(task);
    expect(task).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Show wake progress/ })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    // A task without a chat links to the task route.
    expect(within(pathBar()).getByRole('link', { name: 'Fix subtitle drift' })).toHaveAttribute(
      'href',
      '/projects/p-ttv/tasks/t-2'
    );
    await user.click(task);
    expect(task).toHaveAttribute('aria-pressed', 'false');
    expect(
      screen.getByText('Pick a chat, project or machine to see how it connects.')
    ).toBeInTheDocument();
  });

  it('picking a machine fades what does not run on it', async () => {
    const user = userEvent.setup();
    renderAccountMap();
    await screen.findByTestId('account-map-columns');
    await user.click(screen.getByRole('button', { name: /sam-fsn1-01/ }));
    expect(screen.getByText(/sam-fsn1-01 runs 2 workspaces/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fix subtitle drift/ }).className).not.toContain(
      'opacity-40'
    );
    expect(screen.getByRole('button', { name: /Lobby drops players/ }).className).toContain(
      'opacity-40'
    );
  });

  it('filters to what needs you, and search narrows further', async () => {
    const user = userEvent.setup();
    renderAccountMap();
    await screen.findByTestId('account-map-columns');
    const show = screen.getByRole('group', { name: 'Show' });
    await user.click(within(show).getByRole('button', { name: 'Needs you, 2' }));
    const work = screen
      .getByTestId('account-map-columns')
      .querySelector('[data-column="work"]') as HTMLElement;
    expect(
      within(work)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual([
      expect.stringContaining('Show wake progress'),
      expect.stringContaining('Retire stale nodes'),
    ]);
    await user.click(within(show).getByRole('button', { name: 'Everything, 6' }));
    await user.type(screen.getByRole('textbox', { name: 'Search the map' }), 'subtitle');
    expect(within(work).getAllByRole('button')).toHaveLength(1);
    expect(within(work).getByText('Fix subtitle drift')).toBeInTheDocument();
  });

  it('"Show finished" asks for everything and keeps the current map on screen meanwhile', async () => {
    const user = userEvent.setup();
    renderAccountMap();
    await screen.findByTestId('account-map-columns');
    let release: (value: unknown) => void = () => {};
    mocks.getAccountMap.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    await user.click(screen.getByRole('button', { name: 'Show finished' }));
    expect(mocks.getAccountMap).toHaveBeenLastCalledWith({ activeOnly: false });
    // Mid-fetch: the previous map is still there.
    expect(screen.getByText('Show wake progress')).toBeInTheDocument();
    release(accountMapFixture({ sessions: [], tasks: [], workspaces: [], nodes: [] }));
    await screen.findByText('Nothing to connect yet');
    expect(screen.getByRole('button', { name: 'Hide finished' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('shows the truncation notice when the server left things out', async () => {
    const data = accountMapFixture();
    mocks.getAccountMap.mockResolvedValue({
      ...data,
      truncation: { ...data.truncation, ideas: true, sessions: true },
    });
    renderAccountMap();
    expect(
      await screen.findByText(
        'Only the 100 newest ideas were checked for chat links. Some chats were omitted. Open a project or idea for its full history.'
      )
    ).toBeInTheDocument();
  });

  it('shows the error with a working retry', async () => {
    mocks.getAccountMap.mockRejectedValueOnce(new Error('Network error'));
    renderAccountMap();
    expect(await screen.findByText('Network error')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('account-map-columns')).toBeInTheDocument();
  });

  it("on phones, groups by project and opens the picked chat's path inline", async () => {
    mocks.isMobile = true;
    const user = userEvent.setup();
    renderAccountMap();
    const sam = await screen.findByRole('region', { name: 'SAM' });
    expect(screen.queryByTestId('account-map-columns')).not.toBeInTheDocument();
    // The waiting chat starts open; others show where they run.
    expect(within(sam).getByRole('list', { name: 'How this connects' })).toBeInTheDocument();
    expect(within(sam).getByText('on sam-hel1-02 · not responding')).toBeInTheDocument();
    const ttv = screen.getByRole('region', { name: 'TTV' });
    await user.click(within(ttv).getByRole('button', { name: /Pick a voice/ }));
    expect(within(ttv).getByRole('list', { name: 'How this connects' })).toBeInTheDocument();
    expect(within(sam).queryByRole('list', { name: 'How this connects' })).not.toBeInTheDocument();
  });
});
