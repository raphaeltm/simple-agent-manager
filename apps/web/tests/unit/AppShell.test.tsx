import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { AppShell } from '../../src/components/AppShell';

// Mutable auth state so individual tests can override
let mockAuthState: Record<string, unknown> = {
  user: { name: 'Test User', email: 'test@example.com', image: null },
  isSuperadmin: false,
};

// jsdom does not implement window.matchMedia — stub it for useIsMobile hook
let matchMediaMatches = false;
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      get matches() { return matchMediaMatches; },
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

// Mock AuthProvider
vi.mock('../../src/components/AuthProvider', () => ({
  useAuth: () => mockAuthState,
}));

// Mock auth lib
vi.mock('../../src/lib/auth', () => ({
  signOut: vi.fn(),
}));

// Mock API calls used by GlobalCommandPalette
vi.mock('../../src/lib/api', () => ({
  listProjects: vi.fn().mockResolvedValue({ projects: [] }),
  listNodes: vi.fn().mockResolvedValue([]),
}));

beforeEach(() => {
  matchMediaMatches = false;
  mockAuthState = {
    user: { name: 'Test User', email: 'test@example.com', image: null },
    isSuperadmin: false,
  };
});

function renderAppShell(path = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell>
        <div data-testid="page-content">Page content</div>
      </AppShell>
    </MemoryRouter>,
  );
}

describe('AppShell (global context)', () => {
  it('renders children content', () => {
    renderAppShell();
    expect(screen.getByTestId('page-content')).toBeInTheDocument();
  });

  it('renders primary navigation with Home, Projects, Settings', () => {
    renderAppShell();
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('does not show Nodes or Workspaces in primary nav for non-superadmins', () => {
    renderAppShell();
    expect(screen.queryByText('Nodes')).not.toBeInTheDocument();
    expect(screen.queryByText('Workspaces')).not.toBeInTheDocument();
  });

  it('shows Infrastructure section for superadmins', () => {
    mockAuthState = { ...mockAuthState, isSuperadmin: true };
    renderAppShell();
    expect(screen.getByText('Infrastructure')).toBeInTheDocument();
  });

  it('renders SAM branding', () => {
    renderAppShell();
    expect(screen.getByText('SAM')).toBeInTheDocument();
  });

  it('renders user name', () => {
    renderAppShell();
    expect(screen.getByText('Test User')).toBeInTheDocument();
  });

  it('highlights active nav item based on current route', () => {
    renderAppShell('/projects');
    const projectsLink = screen.getByText('Projects').closest('a');
    expect(projectsLink?.className).toContain('text-accent');
  });

  it('does not highlight inactive nav items', () => {
    renderAppShell('/dashboard');
    const projectsLink = screen.getByText('Projects').closest('a');
    expect(projectsLink?.className).not.toContain('text-accent');
  });

  it('shows Admin nav item in sidebar for superadmins', () => {
    mockAuthState = { ...mockAuthState, isSuperadmin: true };
    renderAppShell();
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  it('does not show Admin nav item for non-superadmins', () => {
    mockAuthState = { ...mockAuthState, isSuperadmin: false };
    renderAppShell();
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });
});

describe('AppShell (project context)', () => {
  it('shows project navigation when inside a project route', () => {
    renderAppShell('/projects/proj-123/chat');
    expect(screen.getByRole('navigation', { name: 'Project navigation' })).toBeInTheDocument();
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
  });

  it('shows Back to Projects link when inside a project', () => {
    renderAppShell('/projects/proj-123/chat');
    expect(screen.getByText('Back to Projects')).toBeInTheDocument();
  });

  it('does not show global nav items when inside a project', () => {
    renderAppShell('/projects/proj-123/tasks');
    expect(screen.queryByText('Home')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Primary navigation' })).not.toBeInTheDocument();
  });

  it('shows global nav on /projects/new (not treated as project context)', () => {
    renderAppShell('/projects/new');
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
    expect(screen.getByText('Home')).toBeInTheDocument();
  });
});

describe('AppShell (command palette)', () => {
  it('renders command palette trigger button in sidebar', () => {
    renderAppShell();
    expect(screen.getByLabelText('Open command palette')).toBeInTheDocument();
  });

  it('renders Search... text in trigger button', () => {
    renderAppShell();
    expect(screen.getByText('Search...')).toBeInTheDocument();
  });

  it('opens command palette when trigger button is clicked', async () => {
    renderAppShell();
    fireEvent.click(screen.getByLabelText('Open command palette'));
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });
});

describe('AppShell (mobile)', () => {
  beforeEach(() => {
    matchMediaMatches = true;
  });

  it('renders mobile header with hamburger menu', () => {
    renderAppShell();
    expect(screen.getByLabelText('Open navigation menu')).toBeInTheDocument();
  });

  it('shows Admin in mobile drawer for superadmins', () => {
    mockAuthState = { ...mockAuthState, isSuperadmin: true };
    renderAppShell();

    fireEvent.click(screen.getByLabelText('Open navigation menu'));

    const drawer = screen.getByRole('dialog', { name: 'Navigation menu' });
    expect(drawer).toBeInTheDocument();
    const adminButton = screen.getByRole('button', { name: 'Admin' });
    expect(adminButton).toBeInTheDocument();
  });

  it('does not show Admin in mobile drawer for non-superadmins', () => {
    mockAuthState = { ...mockAuthState, isSuperadmin: false };
    renderAppShell();

    fireEvent.click(screen.getByLabelText('Open navigation menu'));

    expect(screen.queryByRole('button', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('shows project nav items in mobile drawer when inside a project', () => {
    renderAppShell('/projects/proj-123/chat');

    fireEvent.click(screen.getByLabelText('Open navigation menu'));

    const drawer = screen.getByRole('dialog', { name: 'Navigation menu' });
    expect(drawer).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Overview' })).toBeInTheDocument();
  });
});
