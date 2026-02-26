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

describe('AppShell', () => {
  it('renders children content', () => {
    renderAppShell();
    expect(screen.getByTestId('page-content')).toBeInTheDocument();
  });

  it('renders primary navigation with all 4 sections', () => {
    renderAppShell();
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('Nodes')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
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
    expect(projectsLink).toHaveClass('is-active');
  });

  it('does not highlight inactive nav items', () => {
    renderAppShell('/dashboard');
    const projectsLink = screen.getByText('Projects').closest('a');
    expect(projectsLink).not.toHaveClass('is-active');
  });

  it('highlights nav item for nested routes', () => {
    renderAppShell('/projects/123');
    const projectsLink = screen.getByText('Projects').closest('a');
    expect(projectsLink).toHaveClass('is-active');
  });

  it('shows Admin nav item in sidebar for superadmins', () => {
    mockAuthState = {
      ...mockAuthState,
      isSuperadmin: true,
    };
    renderAppShell();
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  it('does not show Admin nav item for non-superadmins', () => {
    mockAuthState = {
      ...mockAuthState,
      isSuperadmin: false,
    };
    renderAppShell();
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
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
    mockAuthState = {
      ...mockAuthState,
      isSuperadmin: true,
    };
    renderAppShell();

    // Open drawer
    fireEvent.click(screen.getByLabelText('Open navigation menu'));

    // Admin should be in the drawer nav
    const drawer = screen.getByRole('dialog', { name: 'Navigation menu' });
    expect(drawer).toBeInTheDocument();
    const adminButton = screen.getByRole('button', { name: 'Admin' });
    expect(adminButton).toBeInTheDocument();
  });

  it('does not show Admin in mobile drawer for non-superadmins', () => {
    mockAuthState = {
      ...mockAuthState,
      isSuperadmin: false,
    };
    renderAppShell();

    // Open drawer
    fireEvent.click(screen.getByLabelText('Open navigation menu'));

    expect(screen.queryByRole('button', { name: 'Admin' })).not.toBeInTheDocument();
  });
});
