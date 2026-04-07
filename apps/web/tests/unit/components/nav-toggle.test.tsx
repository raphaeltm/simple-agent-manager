import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { MobileNavDrawer, type MobileNavItem } from '../../../src/components/MobileNavDrawer';
import { extractProjectId, NavSidebar } from '../../../src/components/NavSidebar';

// Mock AuthProvider to provide superadmin context
vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ isSuperadmin: false }),
}));

// ---------------------------------------------------------------------------
// extractProjectId
// ---------------------------------------------------------------------------

describe('extractProjectId', () => {
  it('returns project ID from project path', () => {
    expect(extractProjectId('/projects/abc-123/chat')).toBe('abc-123');
  });

  it('returns undefined for /projects/new', () => {
    expect(extractProjectId('/projects/new')).toBeUndefined();
  });

  it('returns undefined for non-project paths', () => {
    expect(extractProjectId('/dashboard')).toBeUndefined();
    expect(extractProjectId('/settings')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// NavSidebar — Desktop Toggle
// ---------------------------------------------------------------------------

describe('NavSidebar — desktop toggle', () => {
  function renderSidebar(options: {
    pathname: string;
    showGlobalNav?: boolean;
    onToggleGlobalNav?: () => void;
    projectName?: string;
  }) {
    return render(
      <MemoryRouter initialEntries={[options.pathname]}>
        <NavSidebar
          projectName={options.projectName ?? 'Test Project'}
          showGlobalNav={options.showGlobalNav ?? false}
          onToggleGlobalNav={options.onToggleGlobalNav ?? (() => {})}
        />
      </MemoryRouter>,
    );
  }

  it('shows "Back to Projects" toggle button in project context', () => {
    renderSidebar({ pathname: '/projects/proj-1/chat' });
    const btn = screen.getByRole('button', { name: 'Show global navigation' });
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain('Back to Projects');
  });

  it('shows project nav items when showGlobalNav is false', () => {
    renderSidebar({ pathname: '/projects/proj-1/chat' });
    expect(screen.getByText('Chat')).toBeTruthy();
    expect(screen.getByText('Ideas')).toBeTruthy();
    expect(screen.getByText('Activity')).toBeTruthy();
  });

  it('shows global nav items when showGlobalNav is true', () => {
    renderSidebar({ pathname: '/projects/proj-1/chat', showGlobalNav: true });
    // Global nav has Home, Chats, Projects, Map, Settings
    const primaryNav = screen.getByLabelText('Primary navigation');
    expect(primaryNav).toBeTruthy();
    // These are link elements in the global nav
    expect(screen.getByRole('link', { name: 'Home' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Projects' })).toBeTruthy();
  });

  it('shows "Back to [Project Name]" when toggled to global', () => {
    renderSidebar({
      pathname: '/projects/proj-1/chat',
      showGlobalNav: true,
      projectName: 'My Cool Project',
    });
    const btn = screen.getByRole('button', { name: /Back to My Cool Project/ });
    expect(btn).toBeTruthy();
  });

  it('calls onToggleGlobalNav when toggle button is clicked', () => {
    const toggle = vi.fn();
    renderSidebar({
      pathname: '/projects/proj-1/chat',
      onToggleGlobalNav: toggle,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show global navigation' }));
    expect(toggle).toHaveBeenCalledOnce();
  });

  it('shows project name header in project view', () => {
    renderSidebar({ pathname: '/projects/proj-1/chat', projectName: 'Alpha Project' });
    expect(screen.getByText('Alpha Project')).toBeTruthy();
  });

  it('shows normal global nav when NOT in project context', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <NavSidebar />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Home' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Projects' })).toBeTruthy();
    // No toggle button
    expect(screen.queryByRole('button', { name: 'Show global navigation' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MobileNavDrawer — Toggle
// ---------------------------------------------------------------------------

describe('MobileNavDrawer — toggle', () => {
  const projectNavItems: MobileNavItem[] = [
    { label: 'Chat', path: '/projects/p1/chat' },
    { label: 'Ideas', path: '/projects/p1/ideas' },
    { label: 'Settings', path: '/projects/p1/settings' },
  ];

  const globalNavItems: MobileNavItem[] = [
    { label: 'Home', path: '/dashboard' },
    { label: 'Projects', path: '/projects' },
    { label: 'Settings', path: '/settings' },
  ];

  const baseProps = {
    onClose: vi.fn(),
    user: { name: 'Test User', email: 'test@example.com', image: null },
    currentPath: '/projects/p1/chat',
    onNavigate: vi.fn(),
    onSignOut: vi.fn(),
    projectName: 'Test Project',
  };

  it('shows toggle button when in project context', () => {
    render(
      <MobileNavDrawer
        {...baseProps}
        navItems={projectNavItems}
        globalNavItems={globalNavItems}
        showGlobalNav={false}
        onToggleGlobalNav={vi.fn()}
      />,
    );
    const toggle = screen.getByTestId('mobile-nav-toggle');
    expect(toggle).toBeTruthy();
    expect(toggle.textContent).toContain('Back to Projects');
  });

  it('shows global nav items when showGlobalNav is true', () => {
    render(
      <MobileNavDrawer
        {...baseProps}
        navItems={projectNavItems}
        globalNavItems={globalNavItems}
        showGlobalNav={true}
        onToggleGlobalNav={vi.fn()}
      />,
    );
    // Toggle should show "Back to [project name]"
    const toggle = screen.getByTestId('mobile-nav-toggle');
    expect(toggle.textContent).toContain('Back to Test Project');
  });

  it('calls onToggleGlobalNav when toggle is clicked', () => {
    const toggleFn = vi.fn();
    render(
      <MobileNavDrawer
        {...baseProps}
        navItems={projectNavItems}
        globalNavItems={globalNavItems}
        showGlobalNav={false}
        onToggleGlobalNav={toggleFn}
      />,
    );
    fireEvent.click(screen.getByTestId('mobile-nav-toggle'));
    expect(toggleFn).toHaveBeenCalledOnce();
  });

  it('does not show toggle when not in project context', () => {
    render(
      <MobileNavDrawer
        {...baseProps}
        navItems={globalNavItems}
        projectName={undefined}
        currentPath="/dashboard"
      />,
    );
    expect(screen.queryByTestId('mobile-nav-toggle')).toBeNull();
  });

  it('shows project name header when showing project nav', () => {
    render(
      <MobileNavDrawer
        {...baseProps}
        navItems={projectNavItems}
        globalNavItems={globalNavItems}
        showGlobalNav={false}
        onToggleGlobalNav={vi.fn()}
      />,
    );
    expect(screen.getByTitle('Test Project')).toBeTruthy();
  });
});
