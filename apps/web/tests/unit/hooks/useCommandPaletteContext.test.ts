import { renderHook } from '@testing-library/react';
import { beforeEach,describe, expect, it, vi } from 'vitest';

import { useCommandPaletteContext } from '../../../src/hooks/useCommandPaletteContext';
import type { ChatSessionResponse } from '../../../src/lib/api';

// ── Mocks ──

const mockNavigate = vi.fn();
let mockPathname = '/dashboard';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
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
  overrides: Partial<ChatSessionResponse & { projectId: string; projectName: string }> = {},
): ChatSessionResponse & { projectId: string; projectName: string } {
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
    workspaceUrl: null,
    ...overrides,
  };
}

const defaultProjects = [
  { id: 'p1', name: 'My Project' },
  { id: 'p2', name: 'Other Project' },
];

function renderContextHook(options?: {
  chatSessions?: Array<ChatSessionResponse & { projectId: string; projectName: string }>;
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

  // ── Context Actions: Session Scope ──

  it('shows "Go to Workspace" when session has workspaceUrl', () => {
    mockPathname = '/projects/p1/chat/sess-1';

    const sessions = [
      makeSession({
        id: 'sess-1',
        projectId: 'p1',
        workspaceUrl: 'https://ws-abc.example.com',
      }),
    ];

    const { result } = renderContextHook({ chatSessions: sessions });
    const labels = result.current.contextActions.map((a) => a.label);
    expect(labels).toContain('Go to Workspace');
  });

  it('does not show "Go to Workspace" when session has no workspaceUrl', () => {
    mockPathname = '/projects/p1/chat/sess-1';

    const sessions = [makeSession({ id: 'sess-1', projectId: 'p1', workspaceUrl: null })];

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

  it('shows "Open PR" when session task has outputPrUrl', () => {
    mockPathname = '/projects/p1/chat/sess-1';

    const sessions = [
      makeSession({
        id: 'sess-1',
        projectId: 'p1',
        taskId: 'task-42',
        task: {
          outputPrUrl: 'https://github.com/org/repo/pull/123',
          outputBranch: null,
          outputSummary: null,
          finalizedAt: null,
          executionStep: null,
          errorMessage: null,
        },
      }),
    ];

    const { result } = renderContextHook({ chatSessions: sessions });
    const labels = result.current.contextActions.map((a) => a.label);
    expect(labels).toContain('Open PR');
  });

  // ── Context Actions: Task/Idea Scope ──

  it('shows "Go to Linked Chat" when viewing a task with a linked session', () => {
    mockPathname = '/projects/p1/ideas/task-42';

    const sessions = [makeSession({ id: 'sess-1', projectId: 'p1', taskId: 'task-42' })];

    const { result } = renderContextHook({ chatSessions: sessions });
    const labels = result.current.contextActions.map((a) => a.label);
    expect(labels).toContain('Go to Linked Chat');
  });

  it('shows "Go to Task\'s Workspace" in task context when linked session has workspaceUrl', () => {
    mockPathname = '/projects/p1/ideas/task-42';

    const sessions = [
      makeSession({
        id: 'sess-1',
        projectId: 'p1',
        taskId: 'task-42',
        workspaceUrl: 'https://ws-abc.example.com',
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
        workspaceUrl: 'https://ws-abc.example.com',
        taskId: 'task-42',
        task: {
          outputPrUrl: 'https://github.com/org/repo/pull/123',
          outputBranch: null,
          outputSummary: null,
          finalizedAt: null,
          executionStep: null,
          errorMessage: null,
        },
      }),
    ];

    const { result } = renderContextHook({ chatSessions: sessions });
    // Default cap is 10, and we have 4 project + 3 session = 7 actions (all fit)
    expect(result.current.contextActions.length).toBeLessThanOrEqual(10);
    expect(result.current.contextActions.length).toBe(7);
  });

  // ── window.open assertions ──

  it('"Go to Workspace" calls window.open with correct URL', () => {
    mockPathname = '/projects/p1/chat/sess-1';
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    const sessions = [
      makeSession({
        id: 'sess-1',
        projectId: 'p1',
        workspaceUrl: 'https://ws-abc.example.com',
      }),
    ];

    const { result } = renderContextHook({ chatSessions: sessions });
    const wsAction = result.current.contextActions.find((a) => a.id === 'ctx-go-to-workspace');
    wsAction?.action();

    expect(openSpy).toHaveBeenCalledWith('https://ws-abc.example.com', '_blank');
    openSpy.mockRestore();
  });

  it('"Open PR" calls window.open with correct URL', () => {
    mockPathname = '/projects/p1/chat/sess-1';
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    const sessions = [
      makeSession({
        id: 'sess-1',
        projectId: 'p1',
        taskId: 'task-42',
        task: {
          outputPrUrl: 'https://github.com/org/repo/pull/123',
          outputBranch: null,
          outputSummary: null,
          finalizedAt: null,
          executionStep: null,
          errorMessage: null,
        },
      }),
    ];

    const { result } = renderContextHook({ chatSessions: sessions });
    const prAction = result.current.contextActions.find((a) => a.id === 'ctx-open-pr');
    prAction?.action();

    expect(openSpy).toHaveBeenCalledWith('https://github.com/org/repo/pull/123', '_blank');
    openSpy.mockRestore();
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
        task: {
          outputPrUrl: 'https://github.com/org/repo/pull/999',
          outputBranch: null,
          outputSummary: null,
          finalizedAt: null,
          executionStep: null,
          errorMessage: null,
        },
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
      makeSession({ id: 'sess-1', projectId: 'p2', workspaceUrl: 'https://ws-abc.example.com' }),
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
