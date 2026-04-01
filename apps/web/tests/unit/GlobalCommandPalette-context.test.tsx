import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach,describe, expect, it, vi } from 'vitest';

import { GlobalCommandPalette } from '../../src/components/GlobalCommandPalette';

// ── Location mock — allows changing pathname per test ──

let mockPathname = '/dashboard';
const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ pathname: mockPathname }),
  };
});

vi.mock('../../src/components/AuthProvider', () => ({
  useAuth: () => ({ isSuperadmin: false }),
}));

vi.mock('../../src/lib/api', () => ({
  listProjects: vi.fn().mockResolvedValue({
    projects: [
      { id: 'p1', name: 'My API Worker' },
      { id: 'p2', name: 'Frontend Dashboard' },
    ],
  }),
  listNodes: vi.fn().mockResolvedValue([]),
  listChatSessions: vi.fn().mockImplementation((projectId: string) => {
    const sessionsByProject: Record<string, { sessions: Array<Record<string, unknown>>; total: number }> = {
      p1: {
        sessions: [
          {
            id: 'sess-1',
            topic: 'Fix auth bug',
            createdAt: 2000,
            status: 'active',
            messageCount: 5,
            startedAt: 1000,
            endedAt: null,
            workspaceId: 'ws-1',
            taskId: 'task-1',
            workspaceUrl: 'https://ws-abc.example.com',
            task: {
              outputPrUrl: 'https://github.com/org/repo/pull/42',
              outputBranch: 'fix-auth',
              outputSummary: null,
              finalizedAt: null,
              executionStep: null,
              errorMessage: null,
            },
          },
          {
            id: 'sess-2',
            topic: 'Code review',
            createdAt: 1000,
            status: 'stopped',
            messageCount: 2,
            startedAt: 500,
            endedAt: 600,
            workspaceId: null,
            taskId: null,
          },
        ],
        total: 2,
      },
      p2: {
        sessions: [
          {
            id: 'sess-3',
            topic: 'Refactor layout',
            createdAt: 3000,
            status: 'active',
            messageCount: 10,
            startedAt: 2000,
            endedAt: null,
            workspaceId: null,
            taskId: null,
          },
        ],
        total: 1,
      },
    };
    return Promise.resolve(sessionsByProject[projectId] || { sessions: [], total: 0 });
  }),
}));

function renderPalette(onClose = vi.fn()) {
  return {
    onClose,
    ...render(
      <MemoryRouter>
        <GlobalCommandPalette onClose={onClose} />
      </MemoryRouter>,
    ),
  };
}

describe('GlobalCommandPalette — Context Awareness', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockPathname = '/dashboard';
  });

  // ── No context on dashboard ──

  it('does not show Context section on dashboard', async () => {
    mockPathname = '/dashboard';
    renderPalette();

    await waitFor(() => {
      expect(screen.getByText('Navigation')).toBeInTheDocument();
    });

    expect(screen.queryByText('Context')).not.toBeInTheDocument();
  });

  // ── Project context ──

  it('shows Context section when inside a project', async () => {
    mockPathname = '/projects/p1/chat';
    renderPalette();

    await waitFor(() => {
      expect(screen.getByText('Context')).toBeInTheDocument();
    });

    // Should show project-scoped navigation actions
    const options = screen.getAllByRole('option');
    const labels = options.map((o) => o.textContent);
    expect(labels.some((l) => l?.includes('Go to Chat'))).toBe(true);
    expect(labels.some((l) => l?.includes('Go to Ideas'))).toBe(true);
    expect(labels.some((l) => l?.includes('Go to Activity'))).toBe(true);
    expect(labels.some((l) => l?.includes('Go to Settings'))).toBe(true);
  });

  it('Context section appears before Navigation', async () => {
    mockPathname = '/projects/p1/chat';
    renderPalette();

    await waitFor(() => {
      expect(screen.getByText('Context')).toBeInTheDocument();
    });

    const groups = screen.getAllByRole('group');
    const groupLabels = groups.map(
      (g) => g.querySelector('[id^="gcp-category-"]')?.textContent,
    );

    const contextIdx = groupLabels.indexOf('Context');
    const navIdx = groupLabels.indexOf('Navigation');
    expect(contextIdx).toBeLessThan(navIdx);
  });

  it('context actions are filterable by query', async () => {
    mockPathname = '/projects/p1/chat';
    renderPalette();
    const input = screen.getByRole('combobox');

    await waitFor(() => {
      expect(screen.getByText('Context')).toBeInTheDocument();
    });

    fireEvent.change(input, { target: { value: 'ideas' } });

    const options = screen.getAllByRole('option');
    const contextOptions = options.filter((o) => o.textContent?.includes('Go to Ideas'));
    expect(contextOptions.length).toBeGreaterThanOrEqual(1);

    // "Go to Activity" should be filtered out since "ideas" doesn't match
    const activityOptions = options.filter((o) => o.textContent?.includes('Go to Activity'));
    expect(activityOptions).toHaveLength(0);
  });

  // ── Session context ──

  it('shows "Go to Workspace" when in a session with workspaceUrl', async () => {
    mockPathname = '/projects/p1/chat/sess-1';
    renderPalette();

    await waitFor(() => {
      expect(screen.getByText('Context')).toBeInTheDocument();
    });

    const options = screen.getAllByRole('option');
    const labels = options.map((o) => o.textContent);
    expect(labels.some((l) => l?.includes('Go to Workspace'))).toBe(true);
  });

  it('shows "View Task" when session has a linked task', async () => {
    mockPathname = '/projects/p1/chat/sess-1';
    renderPalette();

    await waitFor(() => {
      expect(screen.getByText('Context')).toBeInTheDocument();
    });

    const options = screen.getAllByRole('option');
    const labels = options.map((o) => o.textContent);
    expect(labels.some((l) => l?.includes('View Task'))).toBe(true);
  });

  it('shows "Open PR" when session task has outputPrUrl', async () => {
    mockPathname = '/projects/p1/chat/sess-1';
    renderPalette();

    await waitFor(() => {
      expect(screen.getByText('Context')).toBeInTheDocument();
    });

    const options = screen.getAllByRole('option');
    const labels = options.map((o) => o.textContent);
    expect(labels.some((l) => l?.includes('Open PR'))).toBe(true);
  });

  it('does not show workspace/task actions for session without them', async () => {
    mockPathname = '/projects/p1/chat/sess-2';
    renderPalette();

    await waitFor(() => {
      expect(screen.getByText('Context')).toBeInTheDocument();
    });

    const options = screen.getAllByRole('option');
    const labels = options.map((o) => o.textContent);
    expect(labels.some((l) => l?.includes('Go to Workspace'))).toBe(false);
    expect(labels.some((l) => l?.includes('View Task'))).toBe(false);
    expect(labels.some((l) => l?.includes('Open PR'))).toBe(false);
  });

  // ── Task/Idea context ──

  it('shows "Go to Linked Chat" when viewing a task with a linked session', async () => {
    mockPathname = '/projects/p1/ideas/task-1';
    renderPalette();

    await waitFor(() => {
      expect(screen.getByText('Context')).toBeInTheDocument();
    });

    const options = screen.getAllByRole('option');
    const labels = options.map((o) => o.textContent);
    expect(labels.some((l) => l?.includes('Go to Linked Chat'))).toBe(true);
  });

  // ── Chat prioritization ──

  it('prioritizes current project chats when inside a project', async () => {
    mockPathname = '/projects/p1/chat';
    renderPalette();

    await waitFor(() => {
      expect(screen.getByText('Chats')).toBeInTheDocument();
    });

    const options = screen.getAllByRole('option');
    const chatOptions = options.filter(
      (o) =>
        o.textContent?.includes('Fix auth bug') ||
        o.textContent?.includes('Code review') ||
        o.textContent?.includes('Refactor layout'),
    );

    // p1's chats (Fix auth bug, Code review) should appear before p2's (Refactor layout)
    // even though Refactor layout has higher createdAt (3000 vs 2000/1000)
    const firstChatLabel = chatOptions[0]?.textContent;
    expect(firstChatLabel).toContain('My API Worker');
  });

  // ── Keyboard navigation with context ──

  it('context actions are navigable via keyboard', async () => {
    mockPathname = '/projects/p1/chat/sess-1';
    renderPalette();
    const input = screen.getByRole('combobox');

    await waitFor(() => {
      expect(screen.getByText('Context')).toBeInTheDocument();
    });

    // First option should be selected (first context action)
    const options = screen.getAllByRole('option');
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');

    // Arrow down selects next
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const updatedOptions = screen.getAllByRole('option');
    expect(updatedOptions[1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('Enter executes the selected context action', async () => {
    mockPathname = '/projects/p1/chat';
    const onClose = vi.fn();
    renderPalette(onClose);
    const input = screen.getByRole('combobox');

    await waitFor(() => {
      expect(screen.getByText('Context')).toBeInTheDocument();
    });

    // Filter to "ideas" to isolate the Go to Ideas action
    fireEvent.change(input, { target: { value: 'ideas' } });

    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
    });

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockNavigate).toHaveBeenCalledWith('/projects/p1/ideas');
    expect(onClose).toHaveBeenCalled();
  });

  // ── Context ARIA structure ──

  it('Context group has correct ARIA structure', async () => {
    mockPathname = '/projects/p1/chat';
    renderPalette();

    await waitFor(() => {
      expect(screen.getByText('Context')).toBeInTheDocument();
    });

    const contextHeader = screen.getByText('Context');
    expect(contextHeader.getAttribute('id')).toBe('gcp-category-Context');

    const group = contextHeader.closest('[role="group"]');
    expect(group).not.toBeNull();
    expect(group?.getAttribute('aria-labelledby')).toBe('gcp-category-Context');
  });

  // ── Existing functionality preserved ──

  it('still shows all global categories when inside a project', async () => {
    mockPathname = '/projects/p1/chat';
    renderPalette();

    await waitFor(() => {
      expect(screen.getByText('Context')).toBeInTheDocument();
    });

    // All existing categories should still be present
    expect(screen.getByText('Navigation')).toBeInTheDocument();
  });
});
