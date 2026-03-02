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
    expect(screen.getByPlaceholderText('Search pages, projects, nodes...')).toBeInTheDocument();
  });

  it('auto-focuses the search input', () => {
    renderPalette();
    const input = screen.getByRole('textbox');
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
      expect(screen.getByText('My API Worker')).toBeInTheDocument();
    });
    expect(screen.getByText('Frontend Dashboard')).toBeInTheDocument();
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
    const input = screen.getByRole('textbox');

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
    const input = screen.getByRole('textbox');

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
    const input = screen.getByRole('textbox');

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
    const input = screen.getByRole('textbox');

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
    const input = screen.getByRole('textbox');

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
    const input = screen.getByRole('textbox');

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
    const input = screen.getByRole('textbox');

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
    const input = screen.getByRole('textbox');

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
    const input = screen.getByRole('textbox');

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
    const input = screen.getByRole('textbox');

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
    const input = screen.getByRole('textbox');

    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
    });

    // Press up from the first item
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });

    const options = screen.getAllByRole('option');
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
  });
});


