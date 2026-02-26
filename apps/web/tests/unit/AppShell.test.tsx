import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { AppShell } from '../../src/components/AppShell';

// jsdom does not implement window.matchMedia — stub it for useIsMobile hook
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
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
  useAuth: () => ({
    user: { name: 'Test User', email: 'test@example.com', image: null },
  }),
}));

// Mock auth lib
vi.mock('../../src/lib/auth', () => ({
  signOut: vi.fn(),
}));

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
});
