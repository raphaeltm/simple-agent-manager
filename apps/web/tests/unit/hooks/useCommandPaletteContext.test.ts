import { renderHook } from '@testing-library/react';
import { beforeEach,describe, expect, it, vi } from 'vitest';

import { useCommandPaletteContext } from '../../../src/hooks/useCommandPaletteContext';
import type { SessionSummaryItem } from '../../../src/lib/api';

// ── Mocks ──

const mockNavigate = vi.fn();
let mockPathname = '/dashboard';

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ pathname: mockPathname }),
  };
});

vi.mock('../../../src/components/NavSidebar', () => ({
  extractProjectId: (pathname: string) => {
    const match = pathname.match(/^\/projects\/([^/]+)/);
    const id = match?.[1];
    if (!id || id === 'new') return undefined;
    return id;
  },
}));

// ── Test Data ──

function makeSession(
  overrides: Partial<SessionSummaryItem & { createdAt: number }> = {},
): SessionSummaryItem & { createdAt: number } {
  return {
    id: 'sess-1',
    workspaceId: null,
    taskId: null,
    topic: 'Test Chat',
    status: 'active',
    messageCount: 5,
    startedAt: 1000,
    endedAt: null,
    createdAt: 1000,
    projectId: 'p1',
    projectName: 'My Project',
    userId: 'user-1',
    lastMessageAt: null,
    agentCompletedAt: null,
    updatedAt: 1000,
    ...overrides,
  };
}

const defaultProjects = [
  { id: 'p1', name: 'My Project' },
  { id: 'p2', name: 'Other Project' },
];

function renderContextHook(options?: {
  chatSessions?: Array<SessionSummaryItem & { createdAt: number }>;
  projects?: Array<{ id: string; name: string }>;
}) {
  const result = renderHook(() =>
    useCommandPaletteContext({
      chatSessions: options?.chatSessions ?? [],
      projects: options?.projects ?? defaultProjects,
    }),
  );
  return { ...result };
}

// ── Tests ──

describe('useCommandPaletteContext', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockPathname = '/dashboard';
  });

  // ── Context Detection ──

  it('returns undefined context when on dashboard', () => {
    mockPathname = '/dashboard';
    const { result } = renderContextHook();

    expect(result.current.context.projectId).toBeUndefined();
    expect(result.current.context.sessionId).toBeUndefined();
    expect(result.current.context.taskId).toBeUndefined();
  });

  it('detects projectId from project URL', () => {
    mockPathname = '/projects/p1/chat';
    const { result } = renderContextHook();

    expect(result.current.context.projectId).toBe('p1');
    expect(result.current.context.sessionId).toBeUndefined();
    expect(result.current.context.taskId).toBeUndefined();
  });

  it('detects sessionId from chat session URL', () => {
    mockPathname = '/projects/p1/chat/sess-1';
    const { result } = renderContextHook();

    expect(result.current.context.projectId).toBe('p1');
    expect(result.current.context.sessionId).toBe('sess-1');
    expect(result.current.context.taskId).toBeUndefined();
  });

  it('detects taskId from ideas URL', () => {
    mockPathname = '/projects/p1/ideas/task-1';
    const { result } = renderContextHook();

    expect(result.current.context.projectId).toBe('p1');
    expect(result.current.context.sessionId).toBeUndefined();
    expect(result.current.context.taskId).toBe('task-1');
  });

  it('detects taskId from tasks URL', () => {
    mockPathname = '/projects/p1/tasks/task-1';
    const { result } = renderContextHook();

    expect(result.current.context.projectId).toBe('p1');
    expect(result.current.context.taskId).toBe('task-1');
  });

  it('excludes reserved project paths like "new"', () => {
    mockPathname = '/projects/new';
    const { result } = renderContextHook();

    expect(result.current.context.projectId).toBeUndefined();
  });

  // ── Context Actions: No Context ──

  it('returns no context actions on dashboard', () => {
    mockPathname = '/dashboard';
    const { result } = renderContextHook();

    expect(result.current.contextActions).toHaveLength(0);
  });

  // ── Context Actions: Project Scope ──

  it('returns project-scoped actions when inside a project', () => {
    mockPathname = '/projects/p1/chat';
    const { result } = renderContextHook();

    const labels = result.current.contextActions.map((a) => a.label);
    expect(labels).toContain('My Project: Go to Chat');
    expect(labels).toContain('My Project: Go to Ideas');
    expect(labels).toContain('My Project: Go to Activity');
    expect(labels).toContain('My Project: Go to Settings');
  });

  it('project actions navigate correctly', () => {
    mockPathname = '/projects/p1/chat';
    const { result } = renderContextHook();

    const chatAction = result.current.contextActions.find((a) => a.id === 'ctx-project-ideas');
    chatAction?.action();

    expect(mockNavigate).toHaveBeenCalledWith('/projects/p1/ideas');
  });

  it('exposes the full set of project-scoped navigation actions', () => {
    mockPathname = '/projects/p1/chat';
    const { result } = renderContextHook();

    const labels = result.current.contextActions.map((a) => a.label);
    expect(labels).toContain('My Project: Go to Library');
    expect(labels).toContain('My Project: Go to Agent Context');
    expect(labels).toContain('My Project: Go to Notifications');
    expect(labels).toContain('My Project: Go to Triggers');
    expect(labels).toContain('My Project: Go to Profiles');
    expect(labels).toContain('My Project: Go to Skills');
  });

  it.each([
    ['ctx-project-library', '/projects/p1/library'],
    ['ctx-project-agent-context', '/projects/p1/agent-context'],
    ['ctx-project-notifications', '/projects/p1/notifications'],
    ['ctx-project-triggers', '/projects/p1/triggers'],
    ['ctx-project-profiles', '/projects/p1/profiles'],
    ['ctx-project-skills', '/projects/p1/skills'],
  ])('%s navigates to %s', (id, expectedPath) => {
    mockPathname = '/projects/p1/chat';
    const { result } = renderContextHook();

    const action = result.current.contextActions.find((a) => a.id === id);
    action?.action();

    expect(mockNavigate).toHaveBeenCalledWith(expectedPath);
  });

  // ── Create quick actions (?edit=new opens the create modal) ──

  it.each([
    ['ctx-create-trigger', 'My Project: Create Trigger', '/projects/p1/triggers?edit=new'],
    ['ctx-create-profile', 'My Project: Create Profile', '/projects/p1/profiles?edit=new'],
    ['ctx-create-skill', 'My Project: Create Skill', '/projects/p1/skills?edit=new'],
  ])('%s navigates with the ?edit=new query string', (id, label, expectedPath) => {
    mockPathname = '/projects/p1/chat';
    const { result } = renderContextHook();

    const action = result.current.contextActions.find((a) => a.id === id);
    expect(action?.label).toBe(label);
    action?.action();

    expect(mockNavigate).toHaveBeenCalledWith(expectedPath);
  });

  // ── Context Actions: Session Scope ──

  it('shows "Go to Workspace" when session has workspaceId', () => {
    mockPathname = '/projects/p1/chat/sess-1';

    const sessions = [
      makeSession({
        id: 'sess-1',
        projectId: 'p1',
        workspaceId: 'ws-abc',
      }),
    ];

    const { result } = renderContextHook({ chatSessions: sessions });
    const labels = result.current.contextActions.map((a) => a.label);
    expect(labels).toContain('Go to Workspace');
  });

  it('does not show "Go to Workspace" when session has no workspaceId', () => {
    mockPathname = '/projects/p1/chat/sess-1';

    const sessions = [makeSession({ id: 'sess-1', projectId: 'p1', workspaceId: null })];

    const { result } = renderContextHook({ chatSessions: sessions });
    const labels = result.current.contextActions.map((a) => a.label);
    expect(labels).not.toContain('Go to Workspace');
  });

  it('shows "View Task" when session has taskId', () => {
    mockPathname = '/projects/p1/chat/sess-1';

    const sessions = [makeSession({ id: 'sess-1', projectId: 'p1', taskId: 'task-42' })];

    const { result } = renderContextHook({ chatSessions: sessions });
    const labels = result.current.contextActions.map((a) => a.label);
    expect(labels).toContain('View Task');
  });

  it('"Open PR" action is not available from list data (task embed only on detail endpoint)', () => {
    mockPathname = '/projects/p1/chat/sess-1';

    const sessions = [
      makeSession({
        id: 'sess-1',
        projectId: 'p1',
        taskId: 'task-42',
      }),
    ];

    const { result } = renderContextHook({ chatSessions: sessions });
    const labels = result.current.contextActions.map((a) => a.label);
    expect(labels).not.toContain('Open PR');
  });

  // ── Context Actions: Task/Idea Scope ──

  it('shows "Go to Linked Chat" when viewing a task with a linked session', () => {
    mockPathname = '/projects/p1/ideas/task-42';

    const sessions = [makeSession({ id: 'sess-1', projectId: 'p1', taskId: 'task-42' })];

    const { result } = renderContextHook({ chatSessions: sessions });
    const labels = result.current.contextActions.map((a) => a.label);
    expect(labels).toContain('Go to Linked Chat');
  });

  it('shows "Go to Task\'s Workspace" in task context when linked session has workspaceId', () => {
    mockPathname = '/projects/p1/ideas/task-42';

    const sessions = [
      makeSession({
        id: 'sess-1',
        projectId: 'p1',
        taskId: 'task-42',
        workspaceId: 'ws-abc',
      }),
    ];

    const { result } = renderContextHook({ chatSessions: sessions });
    const labels = result.current.contextActions.map((a) => a.label);
    expect(labels).toContain("Go to Task's Workspace");
  });

  it('does not show task-scoped actions when no linked session exists', () => {
    mockPathname = '/projects/p1/ideas/task-42';

    const sessions = [makeSession({ id: 'sess-1', projectId: 'p1', taskId: 'other-task' })];

    const { result } = renderContextHook({ chatSessions: sessions });
    const labels = result.current.contextActions.map((a) => a.label);
    expect(labels).not.toContain('Go to Linked Chat');
    // Project-scoped actions should still be present
    expect(labels).toContain('My Project: Go to Chat');
  });

  // ── Configurable Limit ──

  it('caps context actions to configured maximum', () => {
    mockPathname = '/projects/p1/chat/sess-1';

    const sessions = [
      makeSession({
        id: 'sess-1',
        projectId: 'p1',
        workspaceId: 'ws-abc',
        taskId: 'task-42',
      }),
    ];

    const { result } = renderContextHook({ chatSessions: sessions });
    // Default cap is 20. On a project+session URL we have:
    //   10 project nav (Chat/Ideas/Activity/Settings/Library/Agent Context/
    //   Notifications/Triggers/Profiles/Skills) + 3 create + 2 session = 15 (all fit)
    // (outputPrUrl is only on detail endpoint, not list; "Open PR" action removed)
    expect(result.current.contextActions.length).toBeLessThanOrEqual(20);
    expect(result.current.contextActions.length).toBe(15);
  });

  // ── window.open assertions ──

  it('"Go to Workspace" calls navigate with correct path', () => {
    mockPathname = '/projects/p1/chat/sess-1';

    const sessions = [
      makeSession({
        id: 'sess-1',
        projectId: 'p1',
        workspaceId: 'ws-abc',
      }),
    ];

    const { result } = renderContextHook({ chatSessions: sessions });
    const wsAction = result.current.contextActions.find((a) => a.id === 'ctx-go-to-workspace');
    wsAction?.action();

    expect(mockNavigate).toHaveBeenCalledWith('/workspaces/ws-abc');
  });

  it('"Open PR" action is not available (outputPrUrl only on detail endpoint, not list)', () => {
    mockPathname = '/projects/p1/chat/sess-1';

    const sessions = [
      makeSession({
        id: 'sess-1',
        projectId: 'p1',
        taskId: 'task-42',
      }),
    ];

    const { result } = renderContextHook({ chatSessions: sessions });
    const prAction = result.current.contextActions.find((a) => a.id === 'ctx-open-pr');
    expect(prAction).toBeUndefined();
  });

  // ── Cross-project isolation ──

  it('does not show PR from a different project for same taskId', () => {
    mockPathname = '/projects/p1/ideas/task-42';

    const sessions = [
      // This session has the same taskId but belongs to project p2
      makeSession({
        id: 'sess-wrong',
        projectId: 'p2',
        taskId: 'task-42',
      }),
    ];

    const { result } = renderContextHook({ chatSessions: sessions });
    const labels = result.current.contextActions.map((a) => a.label);
    expect(labels).not.toContain('Open PR');
    expect(labels).not.toContain('Go to Linked Chat');
  });

  it('does not show session actions when session belongs to wrong project', () => {
    mockPathname = '/projects/p1/chat/sess-1';

    const sessions = [
      makeSession({ id: 'sess-1', projectId: 'p2', workspaceId: 'ws-abc' }),
    ];

    const { result } = renderContextHook({ chatSessions: sessions });
    const labels = result.current.contextActions.map((a) => a.label);
    expect(labels).not.toContain('Go to Workspace');
  });

  // ── Empty sessions on session URL (initial load) ──

  it('returns only project actions when chatSessions is empty on a session URL', () => {
    mockPathname = '/projects/p1/chat/sess-1';

    const { result } = renderContextHook({ chatSessions: [] });
    const labels = result.current.contextActions.map((a) => a.label);

    // Project actions present
    expect(labels).toContain('My Project: Go to Chat');
    // Session actions absent
    expect(labels).not.toContain('Go to Workspace');
    expect(labels).not.toContain('View Task');
    expect(labels).not.toContain('Open PR');
  });

  // ── Unknown project (not in projects list) ──

  it('shows actions without project name prefix when project is not in list', () => {
    mockPathname = '/projects/unknown-id/chat';

    const { result } = renderContextHook({ chatSessions: [], projects: [] });
    const labels = result.current.contextActions.map((a) => a.label);

    // Actions present without prefix
    expect(labels).toContain('Go to Chat');
    expect(labels).toContain('Go to Ideas');
  });
});
