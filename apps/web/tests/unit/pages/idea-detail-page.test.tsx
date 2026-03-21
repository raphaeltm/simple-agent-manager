import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { TaskDetailResponse, TaskStatus } from '@simple-agent-manager/shared';
import type { TaskSessionLink } from '../../../src/lib/api';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  getProjectTask: vi.fn(),
  getTaskSessions: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  getProjectTask: mocks.getProjectTask,
  getTaskSessions: mocks.getTaskSessions,
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

import { IdeaDetailPage } from '../../../src/pages/IdeaDetailPage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIdea(overrides: Partial<TaskDetailResponse> = {}): TaskDetailResponse {
  return {
    id: 'idea-1',
    projectId: 'proj-test',
    userId: 'user-1',
    parentTaskId: null,
    workspaceId: null,
    title: 'Authentication Refactor',
    description: 'Explore better auth patterns',
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
    createdAt: '2026-03-18T00:00:00Z',
    updatedAt: '2026-03-18T00:00:00Z',
    dependencies: [],
    ...overrides,
  };
}

function makeSession(overrides: Partial<TaskSessionLink> = {}): TaskSessionLink {
  return {
    sessionId: 'session-1',
    topic: 'Should we switch to JWT?',
    status: 'active',
    context: null,
    linkedAt: Date.now() - 86_400_000, // 1 day ago
    ...overrides,
  };
}

function renderIdeaDetail(taskId = 'idea-1') {
  return render(
    <MemoryRouter initialEntries={[`/projects/proj-test/ideas/${taskId}`]}>
      <Routes>
        <Route path="/projects/:id/ideas/:taskId" element={<IdeaDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IdeaDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProjectTask.mockResolvedValue(makeIdea());
    mocks.getTaskSessions.mockResolvedValue({ sessions: [], count: 0 });
  });

  it('renders the idea title and description', async () => {
    renderIdeaDetail();

    expect(await screen.findByRole('heading', { name: 'Authentication Refactor' })).toBeInTheDocument();
    expect(screen.getByText('Explore better auth patterns')).toBeInTheDocument();
  });

  it('shows the idea status badge', async () => {
    renderIdeaDetail();

    expect(await screen.findByText('Exploring')).toBeInTheDocument();
  });

  it('shows creation date', async () => {
    renderIdeaDetail();

    expect(await screen.findByText(/Created/)).toBeInTheDocument();
    expect(screen.getByText(/Mar 18, 2026/)).toBeInTheDocument();
  });

  it('shows empty state when no sessions are linked', async () => {
    renderIdeaDetail();

    expect(
      await screen.findByText('No conversations linked yet. Start chatting to discuss this idea.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Conversations (0)')).toBeInTheDocument();
  });

  it('displays linked sessions', async () => {
    mocks.getTaskSessions.mockResolvedValue({
      sessions: [
        makeSession({ sessionId: 's1', topic: 'Should we switch to JWT?', status: 'active' }),
        makeSession({ sessionId: 's2', topic: 'Auth middleware audit', status: 'stopped' }),
      ],
      count: 2,
    });

    renderIdeaDetail();

    expect(await screen.findByText('Should we switch to JWT?')).toBeInTheDocument();
    expect(screen.getByText('Auth middleware audit')).toBeInTheDocument();
    expect(screen.getByText('Conversations (2)')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Stopped')).toBeInTheDocument();
  });

  it('shows session context when provided', async () => {
    mocks.getTaskSessions.mockResolvedValue({
      sessions: [
        makeSession({ context: 'Discussed JWT vs session tokens' }),
      ],
      count: 1,
    });

    renderIdeaDetail();

    expect(await screen.findByText('Discussed JWT vs session tokens')).toBeInTheDocument();
  });

  it('navigates to chat session on click', async () => {
    const user = userEvent.setup();
    mocks.getTaskSessions.mockResolvedValue({
      sessions: [makeSession({ sessionId: 'sess-abc' })],
      count: 1,
    });

    renderIdeaDetail();

    const sessionBtn = await screen.findByRole('button', { name: /Open conversation/i });
    await user.click(sessionBtn);

    expect(mocks.navigate).toHaveBeenCalledWith('/projects/proj-test/chat/sess-abc');
  });

  it('navigates back to ideas list on back button click', async () => {
    const user = userEvent.setup();
    renderIdeaDetail();

    const backBtn = await screen.findByRole('button', { name: /Back to Ideas/i });
    await user.click(backBtn);

    expect(mocks.navigate).toHaveBeenCalledWith('/projects/proj-test/ideas');
  });

  it('shows error state when API fails', async () => {
    mocks.getProjectTask.mockRejectedValue(new Error('Network error'));

    renderIdeaDetail();

    expect(await screen.findByText('Failed to load idea details. Please try again.')).toBeInTheDocument();
  });

  it('shows executing status for in_progress ideas', async () => {
    mocks.getProjectTask.mockResolvedValue(makeIdea({ status: 'in_progress' }));

    renderIdeaDetail();

    expect(await screen.findByText('Executing')).toBeInTheDocument();
  });

  it('fetches data with correct project and task IDs', async () => {
    renderIdeaDetail('my-task-id');

    await screen.findByRole('heading', { name: 'Authentication Refactor' });

    expect(mocks.getProjectTask).toHaveBeenCalledWith('proj-test', 'my-task-id');
    expect(mocks.getTaskSessions).toHaveBeenCalledWith('proj-test', 'my-task-id');
  });
});
