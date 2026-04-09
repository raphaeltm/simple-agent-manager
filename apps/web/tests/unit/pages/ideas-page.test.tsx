import type { Task, TaskStatus } from '@simple-agent-manager/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  listProjectTasks: vi.fn(),
  listChatSessions: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listProjectTasks: mocks.listProjectTasks,
  listChatSessions: mocks.listChatSessions,
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router');
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  };
});

vi.mock('../../../src/pages/ProjectContext', () => ({
  useProjectContext: () => ({
    projectId: 'proj-test',
    project: { name: 'Test Project' },
    settingsOpen: false,
    setSettingsOpen: vi.fn(),
    infoPanelOpen: false,
    setInfoPanelOpen: vi.fn(),
  }),
}));

vi.mock('../../../src/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

import { IdeasPage } from '../../../src/pages/IdeasPage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> & { id: string; title: string }): Task {
  return {
    projectId: 'proj-test',
    userId: 'user-1',
    parentTaskId: null,
    workspaceId: null,
    description: null,
    status: 'draft' as TaskStatus,
    executionStep: null,
    priority: 0,
    taskMode: 'task',
    dispatchDepth: 0,
    agentProfileHint: null,
    blocked: false,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    outputSummary: null,
    outputBranch: null,
    outputPrUrl: null,
    finalizedAt: null,
    triggeredBy: 'user',
    triggerId: null,
    triggerExecutionId: null,
    createdAt: '2026-03-19T00:00:00Z',
    updatedAt: '2026-03-19T00:00:00Z',
    ...overrides,
  };
}

function renderIdeasPage() {
  return render(
    <MemoryRouter>
      <IdeasPage />
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IdeasPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listProjectTasks.mockResolvedValue({ tasks: [], nextCursor: null });
    mocks.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });
  });

  it('renders the Ideas heading', async () => {
    renderIdeasPage();
    expect(await screen.findByRole('heading', { name: 'Ideas' })).toBeInTheDocument();
  });

  it('does not render any write-action buttons', async () => {
    mocks.listProjectTasks.mockResolvedValue({
      tasks: [makeTask({ id: '1', title: 'Some idea', status: 'draft' })],
      nextCursor: null,
    });

    renderIdeasPage();
    await screen.findByText('Some idea');

    expect(screen.queryByRole('button', { name: /New Idea/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Brainstorm/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Execute/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete idea/i })).not.toBeInTheDocument();
  });

  it('shows empty state when no ideas exist', async () => {
    renderIdeasPage();
    expect(
      await screen.findByText('Ideas emerge from your conversations. Start chatting to explore new ideas.'),
    ).toBeInTheDocument();
  });

  it('displays ideas grouped by status', async () => {
    mocks.listProjectTasks.mockResolvedValue({
      tasks: [
        makeTask({ id: '1', title: 'Explore caching', status: 'draft' }),
        makeTask({ id: '2', title: 'Build auth flow', status: 'in_progress' }),
      ],
      nextCursor: null,
    });

    renderIdeasPage();

    expect(await screen.findByText('Explore caching')).toBeInTheDocument();
    expect(screen.getByText('Build auth flow')).toBeInTheDocument();

    expect(screen.getAllByText('Exploring').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Executing').length).toBeGreaterThan(0);
  });

  it('filters ideas by search query', async () => {
    const user = userEvent.setup();
    mocks.listProjectTasks.mockResolvedValue({
      tasks: [
        makeTask({ id: '1', title: 'Explore caching', status: 'draft' }),
        makeTask({ id: '2', title: 'Build auth flow', status: 'draft' }),
      ],
      nextCursor: null,
    });

    renderIdeasPage();
    await screen.findByText('Explore caching');

    const searchInput = screen.getByPlaceholderText('Search ideas...');
    await user.type(searchInput, 'auth');

    expect(screen.queryByText('Explore caching')).not.toBeInTheDocument();
    expect(screen.getByText('Build auth flow')).toBeInTheDocument();
  });

  it('filters ideas by status', async () => {
    const user = userEvent.setup();
    mocks.listProjectTasks.mockResolvedValue({
      tasks: [
        makeTask({ id: '1', title: 'Draft idea', status: 'draft' }),
        makeTask({ id: '2', title: 'Running idea', status: 'in_progress' }),
      ],
      nextCursor: null,
    });

    renderIdeasPage();
    await screen.findByText('Draft idea');

    const statusSelect = screen.getByRole('combobox');
    await user.selectOptions(statusSelect, 'executing');

    expect(screen.queryByText('Draft idea')).not.toBeInTheDocument();
    expect(screen.getByText('Running idea')).toBeInTheDocument();
  });

  it('shows session count per idea', async () => {
    mocks.listProjectTasks.mockResolvedValue({
      tasks: [makeTask({ id: 'task-1', title: 'Idea with sessions', status: 'draft' })],
      nextCursor: null,
    });
    mocks.listChatSessions.mockResolvedValue({
      sessions: [
        { id: 's1', taskId: 'task-1', topic: 'Session 1', status: 'active', messageCount: 5, startedAt: Date.now(), endedAt: null, createdAt: Date.now(), workspaceId: null },
        { id: 's2', taskId: 'task-1', topic: 'Session 2', status: 'active', messageCount: 3, startedAt: Date.now(), endedAt: null, createdAt: Date.now(), workspaceId: null },
      ],
      total: 2,
    });

    renderIdeasPage();
    const ideaCard = await screen.findByRole('button', { name: /View idea: Idea with sessions/i });
    expect(ideaCard).toHaveTextContent('2');
  });

  it('navigates to idea detail on card click', async () => {
    const user = userEvent.setup();
    mocks.listProjectTasks.mockResolvedValue({
      tasks: [makeTask({ id: 'idea-3', title: 'Click me', status: 'draft' })],
      nextCursor: null,
    });

    renderIdeasPage();
    await screen.findByText('Click me');

    const cardBtn = screen.getByRole('button', { name: /View idea: Click me/i });
    await user.click(cardBtn);

    expect(mocks.navigate).toHaveBeenCalledWith('/projects/proj-test/ideas/idea-3');
  });

  it('expands a collapsed group when clicked', async () => {
    const user = userEvent.setup();
    mocks.listProjectTasks.mockResolvedValue({
      tasks: [makeTask({ id: 'done-1', title: 'Completed idea', status: 'completed' })],
      nextCursor: null,
    });

    renderIdeasPage();

    const doneBtn = await screen.findByRole('button', { name: /Done/i });
    expect(screen.queryByText('Completed idea')).not.toBeInTheDocument();

    await user.click(doneBtn);

    expect(screen.getByText('Completed idea')).toBeInTheDocument();
  });

  it('shows filtered empty state when search has no matches', async () => {
    const user = userEvent.setup();
    mocks.listProjectTasks.mockResolvedValue({
      tasks: [makeTask({ id: '1', title: 'Some idea', status: 'draft' })],
      nextCursor: null,
    });

    renderIdeasPage();
    await screen.findByText('Some idea');

    const searchInput = screen.getByPlaceholderText('Search ideas...');
    await user.type(searchInput, 'nonexistent');

    expect(screen.getByText('No ideas match your search.')).toBeInTheDocument();
  });

  it('displays idea creation time', async () => {
    mocks.listProjectTasks.mockResolvedValue({
      tasks: [makeTask({ id: '1', title: 'Timed idea', status: 'draft', createdAt: new Date().toISOString() })],
      nextCursor: null,
    });

    renderIdeasPage();
    const card = await screen.findByRole('button', { name: /View idea: Timed idea/i });
    expect(card).toHaveTextContent('just now');
  });

  it('shows AUTO badge on trigger-created ideas', async () => {
    mocks.listProjectTasks.mockResolvedValue({
      tasks: [
        makeTask({ id: '1', title: 'Manual idea', status: 'draft', triggeredBy: 'user' }),
        makeTask({ id: '2', title: 'Auto idea', status: 'draft', triggeredBy: 'cron' }),
      ],
      nextCursor: null,
    });

    renderIdeasPage();
    await screen.findByText('Manual idea');

    // The AUTO badge should appear for cron-triggered ideas
    const autoBadges = screen.getAllByText('AUTO');
    expect(autoBadges).toHaveLength(1);

    // The auto badge should be near the 'Auto idea' card
    const autoCard = screen.getByRole('button', { name: /View idea: Auto idea/i });
    expect(autoCard).toHaveTextContent('AUTO');

    // Manual idea should NOT have the badge
    const manualCard = screen.getByRole('button', { name: /View idea: Manual idea/i });
    expect(manualCard).not.toHaveTextContent('AUTO');
  });

  it('shows timeline accent border for status groups', async () => {
    mocks.listProjectTasks.mockResolvedValue({
      tasks: [makeTask({ id: '1', title: 'My idea', status: 'draft' })],
      nextCursor: null,
    });

    renderIdeasPage();
    await screen.findByText('My idea');

    const section = screen.getByText('My idea').closest('button')?.parentElement;
    expect(section).toBeTruthy();
    expect(section?.className).toContain('border-l-2');
  });
});
