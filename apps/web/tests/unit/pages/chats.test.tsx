import { fireEvent,render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockNavigate = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mocks = vi.hoisted(() => ({
  useAllChatSessions: vi.fn(),
}));

vi.mock('../../../src/hooks/useAllChatSessions', () => ({
  useAllChatSessions: mocks.useAllChatSessions,
}));

vi.mock('../../../src/components/UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu">user-menu</div>,
}));

import { Chats } from '../../../src/pages/Chats';

function renderChats() {
  return render(
    <MemoryRouter initialEntries={['/chats']}>
      <Chats />
    </MemoryRouter>,
  );
}

const NOW = Date.now();

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    workspaceId: null,
    taskId: null,
    topic: null,
    status: 'active',
    messageCount: 5,
    startedAt: NOW - 60000,
    endedAt: null,
    createdAt: NOW - 120000,
    lastMessageAt: NOW - 30000,
    isIdle: false,
    agentCompletedAt: null,
    projectId: 'proj-1',
    projectName: 'My Project',
    ...overrides,
  };
}

describe('Chats page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading skeletons when loading', () => {
    mocks.useAllChatSessions.mockReturnValue({
      sessions: [],
      loading: true,
      error: null,
      refresh: vi.fn(),
    });
    renderChats();
    // SkeletonCard renders divs with animation
    expect(screen.queryByText('No active chats')).not.toBeInTheDocument();
  });

  it('renders empty state when no sessions', () => {
    mocks.useAllChatSessions.mockReturnValue({
      sessions: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    renderChats();
    expect(screen.getByText('No active chats')).toBeInTheDocument();
    expect(screen.getByText('Start a conversation from any project to see it here.')).toBeInTheDocument();
  });

  it('renders error state when fetch fails', () => {
    mocks.useAllChatSessions.mockReturnValue({
      sessions: [],
      loading: false,
      error: 'Failed to load chat sessions',
      refresh: vi.fn(),
    });
    renderChats();
    expect(screen.getByText('Failed to load chat sessions')).toBeInTheDocument();
  });

  it('renders session rows with topic, project name, and state badge', () => {
    mocks.useAllChatSessions.mockReturnValue({
      sessions: [
        makeSession({ id: 's1', topic: 'Fix auth bug', status: 'active', projectName: 'Backend' }),
        makeSession({ id: 's2', topic: null, status: 'active', isIdle: true, projectName: 'Frontend' }),
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    renderChats();

    expect(screen.getByText('Fix auth bug')).toBeInTheDocument();
    expect(screen.getByText('Untitled Chat')).toBeInTheDocument();
    expect(screen.getByText('Backend')).toBeInTheDocument();
    expect(screen.getByText('Frontend')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  it('navigates to project chat on click', () => {
    mocks.useAllChatSessions.mockReturnValue({
      sessions: [
        makeSession({ id: 'sess-abc', projectId: 'proj-xyz', topic: 'Test Session' }),
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    renderChats();

    fireEvent.click(screen.getByText('Test Session'));
    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-xyz/chat/sess-abc');
  });

  it('filters out stale sessions', () => {
    const STALE_TIME = NOW - 4 * 60 * 60 * 1000; // 4 hours ago — stale
    mocks.useAllChatSessions.mockReturnValue({
      sessions: [
        makeSession({ id: 's-recent', topic: 'Recent', lastMessageAt: NOW - 1000 }),
        makeSession({ id: 's-stale', topic: 'Stale', lastMessageAt: STALE_TIME }),
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    renderChats();

    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
  });

  it('shows idle sessions with appropriate badge', () => {
    mocks.useAllChatSessions.mockReturnValue({
      sessions: [
        makeSession({ id: 's1', topic: 'Idle Session', isIdle: true }),
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    renderChats();

    expect(screen.getByText('Idle Session')).toBeInTheDocument();
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  it('filters out stopped sessions', () => {
    mocks.useAllChatSessions.mockReturnValue({
      sessions: [
        makeSession({ id: 's-active', topic: 'Active Chat', status: 'active' }),
        makeSession({ id: 's-stopped', topic: 'Stopped Chat', status: 'stopped' }),
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    renderChats();

    expect(screen.getByText('Active Chat')).toBeInTheDocument();
    expect(screen.queryByText('Stopped Chat')).not.toBeInTheDocument();
  });
});
