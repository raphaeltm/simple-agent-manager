import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Task, TaskStatus } from '@simple-agent-manager/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  listProjectTasks: vi.fn(),
  listChatSessions: vi.fn(),
  createProjectTask: vi.fn(),
  updateProjectTaskStatus: vi.fn(),
  deleteProjectTask: vi.fn(),
  runProjectTask: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  listProjectTasks: mocks.listProjectTasks,
  listChatSessions: mocks.listChatSessions,
  createProjectTask: mocks.createProjectTask,
  updateProjectTaskStatus: mocks.updateProjectTaskStatus,
  deleteProjectTask: mocks.deleteProjectTask,
  runProjectTask: mocks.runProjectTask,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
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

  it('renders the Ideas heading and New Idea button', async () => {
    renderIdeasPage();
    expect(await screen.findByRole('heading', { name: 'Ideas' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New Idea/i })).toBeInTheDocument();
  });

  it('shows empty state when no ideas exist', async () => {
    renderIdeasPage();
    expect(await screen.findByText(/No ideas yet/i)).toBeInTheDocument();
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

    // Wait for ideas to load
    expect(await screen.findByText('Explore caching')).toBeInTheDocument();
    expect(screen.getByText('Build auth flow')).toBeInTheDocument();

    // Status group headers are visible (Done/Parked groups are collapsed by default)
    // "Exploring" appears in both badges and group headers, so just check count
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

  it('opens new idea dialog and creates an idea', async () => {
    const user = userEvent.setup();
    mocks.createProjectTask.mockResolvedValue(
      makeTask({ id: 'new-1', title: 'My new idea' }),
    );

    renderIdeasPage();
    await screen.findByRole('heading', { name: 'Ideas' });

    // Open dialog
    await user.click(screen.getByRole('button', { name: /New Idea/i }));

    // Fill form
    const titleInput = screen.getByLabelText('Title');
    await user.type(titleInput, 'My new idea');

    const descInput = screen.getByLabelText(/Description/);
    await user.type(descInput, 'Some description');

    // Submit
    await user.click(screen.getByRole('button', { name: /Create Idea/i }));

    expect(mocks.createProjectTask).toHaveBeenCalledWith('proj-test', {
      title: 'My new idea',
      description: 'Some description',
    });
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
    expect(await screen.findByText('2 sessions')).toBeInTheDocument();
  });

  it('navigates to chat on brainstorm action', async () => {
    const user = userEvent.setup();
    mocks.listProjectTasks.mockResolvedValue({
      tasks: [makeTask({ id: 'idea-1', title: 'Brainstorm me', status: 'draft' })],
      nextCursor: null,
    });

    renderIdeasPage();
    await screen.findByText('Brainstorm me');

    // Hover to show actions (simulate by finding the button)
    const brainstormBtn = screen.getByRole('button', { name: 'Brainstorm' });
    await user.click(brainstormBtn);

    expect(mocks.navigate).toHaveBeenCalledWith(
      '/projects/proj-test/chat',
      expect.objectContaining({
        state: expect.objectContaining({
          brainstormIdea: expect.objectContaining({
            taskId: 'idea-1',
            title: 'Brainstorm me',
          }),
        }),
      }),
    );
  });

  it('executes an idea by promoting to ready and running', async () => {
    const user = userEvent.setup();
    mocks.listProjectTasks.mockResolvedValue({
      tasks: [makeTask({ id: 'idea-2', title: 'Execute me', status: 'draft' })],
      nextCursor: null,
    });
    mocks.updateProjectTaskStatus.mockResolvedValue({});
    mocks.runProjectTask.mockResolvedValue({ taskId: 'idea-2', status: 'queued' });

    renderIdeasPage();
    await screen.findByText('Execute me');

    const executeBtn = screen.getByRole('button', { name: 'Execute' });
    await user.click(executeBtn);

    // Should transition draft → ready, then run
    expect(mocks.updateProjectTaskStatus).toHaveBeenCalledWith('proj-test', 'idea-2', {
      toStatus: 'ready',
    });
    expect(mocks.runProjectTask).toHaveBeenCalledWith('proj-test', 'idea-2');
    expect(mocks.navigate).toHaveBeenCalledWith('/projects/proj-test/chat');
  });

  it('navigates to idea detail on card click', async () => {
    const user = userEvent.setup();
    mocks.listProjectTasks.mockResolvedValue({
      tasks: [makeTask({ id: 'idea-3', title: 'Click me', status: 'draft' })],
      nextCursor: null,
    });

    renderIdeasPage();
    const card = await screen.findByText('Click me');

    // Click on the card (not the action buttons)
    await user.click(card);

    expect(mocks.navigate).toHaveBeenCalledWith('/projects/proj-test/ideas/idea-3');
  });

  it('deletes an idea', async () => {
    const user = userEvent.setup();
    mocks.listProjectTasks.mockResolvedValue({
      tasks: [makeTask({ id: 'idea-4', title: 'Delete me', status: 'draft' })],
      nextCursor: null,
    });
    mocks.deleteProjectTask.mockResolvedValue({ success: true });

    renderIdeasPage();
    await screen.findByText('Delete me');

    const deleteBtn = screen.getByTitle('Delete idea');
    await user.click(deleteBtn);

    expect(mocks.deleteProjectTask).toHaveBeenCalledWith('proj-test', 'idea-4');
  });

  it('executes a ready-status idea without transitioning status', async () => {
    const user = userEvent.setup();
    mocks.listProjectTasks.mockResolvedValue({
      tasks: [makeTask({ id: 'idea-r', title: 'Ready idea', status: 'ready' })],
      nextCursor: null,
    });
    mocks.runProjectTask.mockResolvedValue({ taskId: 'idea-r', status: 'queued' });

    renderIdeasPage();
    await screen.findByText('Ready idea');

    const executeBtn = screen.getByRole('button', { name: 'Execute' });
    await user.click(executeBtn);

    // Should NOT call updateProjectTaskStatus for ready ideas
    expect(mocks.updateProjectTaskStatus).not.toHaveBeenCalled();
    expect(mocks.runProjectTask).toHaveBeenCalledWith('proj-test', 'idea-r');
  });

  it('expands a collapsed group when clicked', async () => {
    const user = userEvent.setup();
    mocks.listProjectTasks.mockResolvedValue({
      tasks: [makeTask({ id: 'done-1', title: 'Completed idea', status: 'completed' })],
      nextCursor: null,
    });

    renderIdeasPage();

    // Done group is collapsed by default — idea should not be visible
    const doneBtn = await screen.findByRole('button', { name: /Done/i });
    expect(screen.queryByText('Completed idea')).not.toBeInTheDocument();

    // Click group header to expand
    await user.click(doneBtn);

    // Now the idea should be visible
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

  it('cancel button closes the new idea dialog', async () => {
    const user = userEvent.setup();
    renderIdeasPage();
    await screen.findByRole('heading', { name: 'Ideas' });

    // Open dialog
    await user.click(screen.getByRole('button', { name: /New Idea/i }));
    expect(screen.getByRole('heading', { name: 'New Idea' })).toBeInTheDocument();

    // Cancel
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // Dialog should be gone (the form heading disappears)
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
    expect(mocks.createProjectTask).not.toHaveBeenCalled();
  });

  it('does not submit when title is empty', async () => {
    const user = userEvent.setup();
    renderIdeasPage();
    await screen.findByRole('heading', { name: 'Ideas' });

    await user.click(screen.getByRole('button', { name: /New Idea/i }));

    // Submit button should be disabled with empty title
    const submitBtn = screen.getByRole('button', { name: /Create Idea/i });
    expect(submitBtn).toBeDisabled();
  });
});
