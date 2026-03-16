import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GlobalCommandPalette } from '../../src/components/GlobalCommandPalette';

// Track navigation calls
const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ pathname: '/dashboard' }),
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
      { id: 'p3', name: 'Auth Service' },
    ],
  }),
  listNodes: vi.fn().mockResolvedValue([
    { id: 'n1', name: 'node-hetzner-1' },
    { id: 'n2', name: 'node-hetzner-2' },
  ]),
  listChatSessions: vi.fn().mockImplementation((projectId: string) => {
    const sessionsByProject: Record<string, { sessions: Array<{ id: string; topic: string | null; createdAt: number; status: string; messageCount: number; startedAt: number; endedAt: number | null; workspaceId: string | null; taskId: string | null }>; total: number }> = {
      p1: {
        sessions: [
          { id: 's1', topic: 'Fix auth bug', createdAt: 1000, status: 'active', messageCount: 5, startedAt: 1000, endedAt: null, workspaceId: null, taskId: null },
          { id: 's2', topic: null, createdAt: 500, status: 'stopped', messageCount: 2, startedAt: 500, endedAt: 600, workspaceId: null, taskId: null },
        ],
        total: 2,
      },
      p2: {
        sessions: [
          { id: 's3', topic: 'Refactor dashboard layout', createdAt: 2000, status: 'active', messageCount: 10, startedAt: 2000, endedAt: null, workspaceId: null, taskId: null },
        ],
        total: 1,
      },
      p3: { sessions: [], total: 0 },
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

describe('GlobalCommandPalette', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  // ── Basic rendering ──

  it('renders the palette dialog', async () => {
    renderPalette();
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });

  it('renders search input with correct placeholder', () => {
    renderPalette();
    expect(screen.getByPlaceholderText('Search pages, projects, chats, nodes...')).toBeInTheDocument();
  });

  it('auto-focuses the search input', () => {
    renderPalette();
    const input = screen.getByRole('combobox');
    expect(document.activeElement).toBe(input);
  });

  it('renders navigation items when query is empty', async () => {
    renderPalette();
    await waitFor(() => {
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
    });
    // "Projects" and "Nodes" appear as both nav items and category headers,
    // so use getAllByText and verify at least 1 exists as an option
    const projectOptions = screen.getAllByText('Projects');
    expect(projectOptions.length).toBeGreaterThanOrEqual(1);
    const nodeOptions = screen.getAllByText('Nodes');
    expect(nodeOptions.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('renders Navigation category header', async () => {
    renderPalette();
    await waitFor(() => {
      expect(screen.getByText('Navigation')).toBeInTheDocument();
    });
  });

  it('renders action items when query is empty', async () => {
    renderPalette();
    await waitFor(() => {
      expect(screen.getByText('New Project')).toBeInTheDocument();
    });
  });

  // ── Dynamic data loading ──

  it('shows projects after loading', async () => {
    renderPalette();
    await waitFor(() => {
      // "My API Worker" appears both as a project and as a chat's project label
      expect(screen.getAllByText('My API Worker').length).toBeGreaterThanOrEqual(1);
    });
    // "Frontend Dashboard" may also appear as a chat project label
    expect(screen.getAllByText('Frontend Dashboard').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Auth Service')).toBeInTheDocument();
  });

  it('shows nodes after loading', async () => {
    renderPalette();
    await waitFor(() => {
      expect(screen.getByText('node-hetzner-1')).toBeInTheDocument();
    });
    expect(screen.getByText('node-hetzner-2')).toBeInTheDocument();
  });

  // ── Fuzzy search ──

  it('filters navigation items by query', async () => {
    renderPalette();
    const input = screen.getByRole('combobox');

    await waitFor(() => {
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
    });

    fireEvent.change(input, { target: { value: 'sett' } });

    const options = screen.getAllByRole('option');
    const settingsOption = options.find((o) => o.textContent?.includes('Settings'));
    expect(settingsOption).toBeDefined();
    // Dashboard should be filtered out
    const dashOption = options.find((o) => o.textContent?.includes('Dashboard'));
    expect(dashOption).toBeUndefined();
  });

  it('filters projects by name', async () => {
    renderPalette();
    const input = screen.getByRole('combobox');

    await waitFor(() => {
      expect(screen.getByText('My API Worker')).toBeInTheDocument();
    });

    fireEvent.change(input, { target: { value: 'api' } });

    const options = screen.getAllByRole('option');
    const apiOption = options.find((o) => o.textContent?.includes('My API Worker'));
    expect(apiOption).toBeDefined();
    // Frontend Dashboard should be filtered out
    const frontendOption = options.find((o) => o.textContent?.includes('Frontend Dashboard'));
    expect(frontendOption).toBeUndefined();
  });

  it('filters nodes by name', async () => {
    renderPalette();
    const input = screen.getByRole('combobox');

    await waitFor(() => {
      expect(screen.getByText('node-hetzner-1')).toBeInTheDocument();
    });

    fireEvent.change(input, { target: { value: 'hetzner-1' } });

    const options = screen.getAllByRole('option');
    const node1 = options.find((o) => o.textContent?.includes('node-hetzner-1'));
    expect(node1).toBeDefined();
    const node2 = options.find((o) => o.textContent?.includes('node-hetzner-2'));
    expect(node2).toBeUndefined();
  });

  it('shows "No matching results" for unmatched query', async () => {
    renderPalette();
    const input = screen.getByRole('combobox');

    await waitFor(() => {
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
    });

    fireEvent.change(input, { target: { value: 'xyznonexistent99' } });
    expect(screen.getByText('No matching results')).toBeInTheDocument();
  });

  // ── Result execution ──

  it('navigates to page when navigation result is clicked', async () => {
    const onClose = vi.fn();
    renderPalette(onClose);

    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    const options = screen.getAllByRole('option');
    const settingsOption = options.find((o) => o.textContent?.includes('Settings'));
    fireEvent.click(settingsOption!);

    expect(mockNavigate).toHaveBeenCalledWith('/settings');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('navigates to project when project result is clicked', async () => {
    const onClose = vi.fn();
    renderPalette(onClose);

    await waitFor(() => {
      expect(screen.getByText('My API Worker')).toBeInTheDocument();
    });

    const options = screen.getAllByRole('option');
    const projectOption = options.find((o) => o.textContent?.includes('My API Worker'));
    fireEvent.click(projectOption!);

    expect(mockNavigate).toHaveBeenCalledWith('/projects/p1');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('navigates to node when node result is clicked', async () => {
    const onClose = vi.fn();
    renderPalette(onClose);

    await waitFor(() => {
      expect(screen.getByText('node-hetzner-1')).toBeInTheDocument();
    });

    const options = screen.getAllByRole('option');
    const nodeOption = options.find((o) => o.textContent?.includes('node-hetzner-1'));
    fireEvent.click(nodeOption!);

    expect(mockNavigate).toHaveBeenCalledWith('/nodes/n1');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('navigates to new project when action result is clicked', async () => {
    const onClose = vi.fn();
    renderPalette(onClose);

    await waitFor(() => {
      expect(screen.getByText('New Project')).toBeInTheDocument();
    });

    const options = screen.getAllByRole('option');
    const actionOption = options.find((o) => o.textContent?.includes('New Project'));
    fireEvent.click(actionOption!);

    expect(mockNavigate).toHaveBeenCalledWith('/projects/new');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('executes selected result via Enter key', async () => {
    const onClose = vi.fn();
    renderPalette(onClose);
    const input = screen.getByRole('combobox');

    await waitFor(() => {
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
    });

    // Filter to Settings (not current path) and press Enter
    fireEvent.change(input, { target: { value: 'Settings' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockNavigate).toHaveBeenCalledWith('/settings');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── Keyboard navigation ──

  it('navigates selection with ArrowDown and ArrowUp', async () => {
    renderPalette();
    const input = screen.getByRole('combobox');

    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
    });

    const options = screen.getAllByRole('option');
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const optionsAfterDown = screen.getAllByRole('option');
    expect(optionsAfterDown[0]?.getAttribute('aria-selected')).toBe('false');
    expect(optionsAfterDown[1]?.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    const optionsAfterUp = screen.getAllByRole('option');
    expect(optionsAfterUp[0]?.getAttribute('aria-selected')).toBe('true');
    expect(optionsAfterUp[1]?.getAttribute('aria-selected')).toBe('false');
  });

  it('resets selection when query changes', async () => {
    renderPalette();
    const input = screen.getByRole('combobox');

    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
    });

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    fireEvent.change(input, { target: { value: 'dash' } });
    const options = screen.getAllByRole('option');
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('updates selection on mouse hover', async () => {
    renderPalette();

    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(2);
    });

    const options = screen.getAllByRole('option');
    fireEvent.mouseEnter(options[2]!);
    expect(options[2]?.getAttribute('aria-selected')).toBe('true');
    expect(options[0]?.getAttribute('aria-selected')).toBe('false');
  });

  // ── Close behaviors ──

  it('closes on Escape key', async () => {
    const onClose = vi.fn();
    renderPalette(onClose);
    const input = screen.getByRole('combobox');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on backdrop click', async () => {
    const onClose = vi.fn();
    const { container } = renderPalette(onClose);

    // Backdrop is the first child (fixed overlay)
    const backdrop = container.querySelector('.fixed.inset-0');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not navigate when Escape is pressed', async () => {
    const onClose = vi.fn();
    renderPalette(onClose);
    const input = screen.getByRole('combobox');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  // ── Edge cases ──

  it('does not crash when API calls fail', async () => {
    const { listProjects, listNodes } = await import('../../src/lib/api');
    vi.mocked(listProjects).mockRejectedValueOnce(new Error('Network error'));
    vi.mocked(listNodes).mockRejectedValueOnce(new Error('Network error'));

    renderPalette();

    // Should still show navigation items
    await waitFor(() => {
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
    });
  });

  it('ArrowDown does not go past last result', async () => {
    renderPalette();
    const input = screen.getByRole('combobox');

    // Filter to get a small set
    await waitFor(() => {
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
    });

    fireEvent.change(input, { target: { value: 'dashboard' } });
    const options = screen.getAllByRole('option');

    // Press down more times than there are options
    for (let i = 0; i < options.length + 5; i++) {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    }

    // Last item should be selected
    const finalOptions = screen.getAllByRole('option');
    expect(finalOptions[finalOptions.length - 1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('ArrowUp does not go above first result', async () => {
    renderPalette();
    const input = screen.getByRole('combobox');

    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
    });

    // Press up from the first item
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });

    const options = screen.getAllByRole('option');
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
  });

  // ── Current path skip logic ──

  it('does not navigate when selecting current page (closes only)', async () => {
    // Location is mocked as /dashboard — clicking Dashboard should not navigate
    const onClose = vi.fn();
    renderPalette(onClose);

    await waitFor(() => {
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
    });

    const options = screen.getAllByRole('option');
    const dashOption = options.find((o) => o.textContent?.includes('Dashboard'));
    fireEvent.click(dashOption!);

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── ARIA attributes ──

  it('has combobox role on input with aria-controls and aria-expanded', async () => {
    renderPalette();
    const input = screen.getByRole('combobox');
    expect(input).toBeInTheDocument();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe('gcp-listbox');
  });

  it('has listbox with matching id', async () => {
    renderPalette();
    const listbox = screen.getByRole('listbox');
    expect(listbox.getAttribute('id')).toBe('gcp-listbox');
  });

  it('sets aria-activedescendant on input to selected option id', async () => {
    renderPalette();
    const input = screen.getByRole('combobox');

    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
    });

    // First option selected by default
    const options = screen.getAllByRole('option');
    const firstOptionId = options[0]?.getAttribute('id');
    expect(firstOptionId).toBeTruthy();
    expect(input.getAttribute('aria-activedescendant')).toBe(firstOptionId);

    // Arrow down changes it
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const updatedOptions = screen.getAllByRole('option');
    const secondOptionId = updatedOptions[1]?.getAttribute('id');
    expect(input.getAttribute('aria-activedescendant')).toBe(secondOptionId);
  });

  it('has aria-modal on dialog', async () => {
    renderPalette();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('options have unique id attributes', async () => {
    renderPalette();

    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
    });

    const options = screen.getAllByRole('option');
    const ids = options.map((o) => o.getAttribute('id'));
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
    // All IDs should start with gcp-option-
    for (const id of ids) {
      expect(id).toMatch(/^gcp-option-/);
    }
  });

  // ── Category group structure ──

  it('has role=group with aria-labelledby for categories', async () => {
    renderPalette();

    await waitFor(() => {
      expect(screen.getByText('Navigation')).toBeInTheDocument();
    });

    // The Navigation header should have an id
    const navHeader = screen.getByText('Navigation');
    expect(navHeader.getAttribute('id')).toBe('gcp-category-Navigation');

    // Its parent group should reference it
    const group = navHeader.closest('[role="group"]');
    expect(group).not.toBeNull();
    expect(group?.getAttribute('aria-labelledby')).toBe('gcp-category-Navigation');
  });

  // ── Quick Actions (New Chat) ──

  it('shows "Quick Actions" category when typing "new chat"', async () => {
    renderPalette();
    const input = screen.getByRole('combobox');

    await waitFor(() => {
      expect(screen.getByText('My API Worker')).toBeInTheDocument();
    });

    fireEvent.change(input, { target: { value: 'new chat' } });

    await waitFor(() => {
      expect(screen.getByText('Quick Actions')).toBeInTheDocument();
    });

    // Should show new chat options for all three projects
    const options = screen.getAllByRole('option');
    const newChatOptions = options.filter((o) => o.textContent?.includes('New Chat'));
    expect(newChatOptions.length).toBe(3);
  });

  it('filters quick actions by project name prefix', async () => {
    renderPalette();
    const input = screen.getByRole('combobox');

    await waitFor(() => {
      expect(screen.getByText('My API Worker')).toBeInTheDocument();
    });

    fireEvent.change(input, { target: { value: 'api new chat' } });

    const options = screen.getAllByRole('option');
    const newChatOptions = options.filter((o) => o.textContent?.includes('New Chat'));
    // Only "My API Worker New Chat" should match — "api" has no subsequence in the other project names
    expect(newChatOptions.length).toBe(1);
    const apiOption = options.find((o) => o.textContent?.includes('My API Worker New Chat'));
    expect(apiOption).toBeDefined();
  });

  it('navigates to project chat when quick action is clicked', async () => {
    const onClose = vi.fn();
    renderPalette(onClose);
    const input = screen.getByRole('combobox');

    await waitFor(() => {
      expect(screen.getByText('My API Worker')).toBeInTheDocument();
    });

    fireEvent.change(input, { target: { value: 'api new chat' } });

    await waitFor(() => {
      expect(screen.getByText('Quick Actions')).toBeInTheDocument();
    });

    const options = screen.getAllByRole('option');
    const apiNewChat = options.find((o) => o.textContent?.includes('My API Worker New Chat'));
    expect(apiNewChat).toBeDefined();
    fireEvent.click(apiNewChat!);

    expect(mockNavigate).toHaveBeenCalledWith('/projects/p1/chat', );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not show quick actions when query is empty', async () => {
    renderPalette();

    await waitFor(() => {
      expect(screen.getByText('My API Worker')).toBeInTheDocument();
    });

    // Query is empty — no Quick Actions category
    expect(screen.queryByText('Quick Actions')).not.toBeInTheDocument();
  });

  it('quick action is executable via Enter key', async () => {
    const onClose = vi.fn();
    renderPalette(onClose);
    const input = screen.getByRole('combobox');

    await waitFor(() => {
      expect(screen.getByText('My API Worker')).toBeInTheDocument();
    });

    // Type a query that uniquely matches one quick action
    fireEvent.change(input, { target: { value: 'Auth Service New Chat' } });

    await waitFor(() => {
      expect(screen.getByText('Quick Actions')).toBeInTheDocument();
    });

    // First matching result should be selected; press Enter
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockNavigate).toHaveBeenCalledWith('/projects/p3/chat', );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not show quick actions when query matches nothing', async () => {
    renderPalette();
    const input = screen.getByRole('combobox');

    await waitFor(() => {
      expect(screen.getByText('My API Worker')).toBeInTheDocument();
    });

    fireEvent.change(input, { target: { value: 'xyznonexistent99' } });

    expect(screen.queryByText('Quick Actions')).not.toBeInTheDocument();
  });

  it('Quick Actions group has correct ARIA structure', async () => {
    renderPalette();
    const input = screen.getByRole('combobox');

    await waitFor(() => {
      expect(screen.getByText('My API Worker')).toBeInTheDocument();
    });

    fireEvent.change(input, { target: { value: 'new chat' } });

    await waitFor(() => {
      expect(screen.getByText('Quick Actions')).toBeInTheDocument();
    });

    const quickActionsHeader = screen.getByText('Quick Actions');
    expect(quickActionsHeader.getAttribute('id')).toBe('gcp-category-Quick Actions');

    const group = quickActionsHeader.closest('[role="group"]');
    expect(group).not.toBeNull();
    expect(group?.getAttribute('aria-labelledby')).toBe('gcp-category-Quick Actions');
  });

  // ── Chat search ──

  it('shows Chats category after loading sessions', async () => {
    renderPalette();

    await waitFor(() => {
      expect(screen.getByText('Chats')).toBeInTheDocument();
    });

    expect(screen.getByText('Fix auth bug')).toBeInTheDocument();
    expect(screen.getByText('Refactor dashboard layout')).toBeInTheDocument();
  });

  it('shows "Untitled Chat" for sessions without a topic', async () => {
    renderPalette();

    await waitFor(() => {
      expect(screen.getByText('Chats')).toBeInTheDocument();
    });

    expect(screen.getByText('Untitled Chat')).toBeInTheDocument();
  });

  it('shows project name next to chat results', async () => {
    renderPalette();

    await waitFor(() => {
      expect(screen.getByText('Fix auth bug')).toBeInTheDocument();
    });

    // Chat results should include the project name as secondary text
    // Find the chat option and verify it contains the project name
    const options = screen.getAllByRole('option');
    const authBugOption = options.find((o) => o.textContent?.includes('Fix auth bug'));
    expect(authBugOption?.textContent).toContain('My API Worker');

    const refactorOption = options.find((o) => o.textContent?.includes('Refactor dashboard layout'));
    expect(refactorOption?.textContent).toContain('Frontend Dashboard');
  });

  it('orders chats by most recent first when no query', async () => {
    renderPalette();

    await waitFor(() => {
      expect(screen.getByText('Chats')).toBeInTheDocument();
    });

    const options = screen.getAllByRole('option');
    const chatOptions = options.filter(
      (o) =>
        o.textContent?.includes('Fix auth bug') ||
        o.textContent?.includes('Refactor dashboard layout') ||
        o.textContent?.includes('Untitled Chat'),
    );

    // Most recent (createdAt: 2000) should come first
    expect(chatOptions[0]?.textContent).toContain('Refactor dashboard layout');
    expect(chatOptions[1]?.textContent).toContain('Fix auth bug');
    expect(chatOptions[2]?.textContent).toContain('Untitled Chat');
  });

  it('filters chats by topic with fuzzy matching', async () => {
    renderPalette();
    const input = screen.getByRole('combobox');

    await waitFor(() => {
      expect(screen.getByText('Fix auth bug')).toBeInTheDocument();
    });

    fireEvent.change(input, { target: { value: 'auth' } });

    const options = screen.getAllByRole('option');
    const authOption = options.find((o) => o.textContent?.includes('Fix auth bug'));
    expect(authOption).toBeDefined();

    // "Refactor dashboard layout" should be filtered out
    const refactorOption = options.find((o) => o.textContent?.includes('Refactor dashboard layout'));
    expect(refactorOption).toBeUndefined();
  });

  it('navigates to chat session when chat result is clicked', async () => {
    const onClose = vi.fn();
    renderPalette(onClose);

    await waitFor(() => {
      expect(screen.getByText('Fix auth bug')).toBeInTheDocument();
    });

    const options = screen.getAllByRole('option');
    const chatOption = options.find((o) => o.textContent?.includes('Fix auth bug'));
    fireEvent.click(chatOption!);

    expect(mockNavigate).toHaveBeenCalledWith('/projects/p1/chat/s1');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('navigates to correct project for cross-project chat results', async () => {
    const onClose = vi.fn();
    renderPalette(onClose);

    await waitFor(() => {
      expect(screen.getByText('Refactor dashboard layout')).toBeInTheDocument();
    });

    const options = screen.getAllByRole('option');
    const chatOption = options.find((o) => o.textContent?.includes('Refactor dashboard layout'));
    fireEvent.click(chatOption!);

    expect(mockNavigate).toHaveBeenCalledWith('/projects/p2/chat/s3');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Chats category has correct ARIA structure', async () => {
    renderPalette();

    await waitFor(() => {
      expect(screen.getByText('Chats')).toBeInTheDocument();
    });

    const chatsHeader = screen.getByText('Chats');
    expect(chatsHeader.getAttribute('id')).toBe('gcp-category-Chats');

    const group = chatsHeader.closest('[role="group"]');
    expect(group).not.toBeNull();
    expect(group?.getAttribute('aria-labelledby')).toBe('gcp-category-Chats');
  });

  it('gracefully handles chat session fetch failure', async () => {
    const { listChatSessions } = await import('../../src/lib/api');
    // Reject all per-project session fetches (one per project)
    vi.mocked(listChatSessions)
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'));

    renderPalette();

    // Should still show other categories
    await waitFor(() => {
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
    });

    // Chats category should not appear
    expect(screen.queryByText('Chats')).not.toBeInTheDocument();
  });
});
