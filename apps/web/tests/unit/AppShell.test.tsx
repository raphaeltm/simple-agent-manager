import { act, fireEvent, render as baseRender, type RenderOptions, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, useNavigate } from 'react-router';
import { afterEach, beforeAll, beforeEach,describe, expect, it, vi } from 'vitest';

import { AppShell } from '../../src/components/AppShell';
import { GLOBAL_NAV_ITEMS, PROJECT_NAV_ITEMS } from '../../src/components/NavSidebar';
import { ThemeProvider } from '../../src/contexts/ThemeContext';

// AppShell renders the shared <ThemeSwitcher /> (desktop sidebar footer and the
// mobile drawer), which calls useTheme and requires a ThemeProvider ancestor.
function render(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  return baseRender(ui, { wrapper: ThemeProvider, ...options });
}

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
vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api')>()),
  listProjects: vi.fn().mockResolvedValue({ projects: [] }),
  listNodes: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/components/NotificationCenter', () => ({
  NotificationCenter: () => <button type="button" aria-label="Notifications" />,
}));

vi.mock('../../src/components/RecentChatsDropdown', () => ({
  RecentChatsDropdown: () => <button type="button" aria-label="Recent chats" />,
}));

vi.mock('../../src/components/GlobalAudioPlayer', () => ({
  GlobalAudioPlayer: () => null,
}));

vi.mock('../../src/components/onboarding/choose-path/ChoosePathWizard', () => ({
  ChoosePathWizard: () => null,
}));

vi.mock('../../src/components/GlobalCommandPalette', () => ({
  GlobalCommandPalette: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Command palette">
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

beforeEach(() => {
  matchMediaMatches = false;
  mockAuthState = {
    user: { name: 'Test User', email: 'test@example.com', image: null },
    isSuperadmin: false,
  };
});

afterEach(() => {
  vi.useRealTimers();
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

  it('shows Infrastructure section for non-superadmins', () => {
    renderAppShell();
    expect(screen.getByText('Infrastructure')).toBeInTheDocument();
  });

  it('expands Infrastructure to show Nodes and Workspaces in primary nav', () => {
    renderAppShell();
    fireEvent.click(screen.getByText('Infrastructure'));
    expect(screen.getByText('Nodes')).toBeInTheDocument();
    expect(screen.getByText('Workspaces')).toBeInTheDocument();
  });

  it('renders SAM branding', () => {
    renderAppShell();
    expect(screen.getByAltText('SAM')).toBeInTheDocument();
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

  it('does not include prototype or test-only destinations in production navigation models', () => {
    const navPaths = [
      ...GLOBAL_NAV_ITEMS.map((item) => item.path),
      ...PROJECT_NAV_ITEMS.map((item) => `/projects/project-id/${item.path}`),
    ];

    expect(navPaths).not.toContain('/sam');
    expect(navPaths).not.toContain('/__test/trial-chat-gate');
    expect(navPaths).not.toContain('/ui-standards');
    expect(navPaths.every((path) => !path.includes('prototype'))).toBe(true);
    expect(navPaths.every((path) => !path.includes('__test'))).toBe(true);
  });
});

describe('AppShell (project context)', () => {
  it('shows project navigation when inside a project route', () => {
    renderAppShell('/projects/proj-123/chat');
    const projectNav = screen.getByRole('navigation', { name: 'Project navigation' });
    expect(projectNav).toBeInTheDocument();
    // Project nav should be the visible/active panel
    expect(projectNav.getAttribute('aria-hidden')).not.toBe('true');
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.getByText('Ideas')).toBeInTheDocument();
    expect(screen.getByText('Deployments')).toBeInTheDocument();
    expect(screen.queryByText('Activity')).not.toBeInTheDocument();
  });

  it('shows Back to Projects toggle button when inside a project', () => {
    renderAppShell('/projects/proj-123/chat');
    expect(screen.getByText('Back to Projects')).toBeInTheDocument();
  });

  it('has global nav panel hidden by default when inside a project', () => {
    const { container } = renderAppShell('/projects/proj-123/tasks');
    // Both nav panels exist in the DOM for the slide animation,
    // but the global nav panel is hidden with aria-hidden
    const globalNav = container.querySelector('nav[aria-label="Primary navigation"]');
    expect(globalNav).toBeTruthy();
    expect(globalNav?.getAttribute('aria-hidden')).toBe('true');
  });

  it('resets toggle state when navigating to a different route', () => {
    // Use a helper component to trigger navigation from inside the router
    let navigateFn: (path: string) => void;
    function NavHelper() {
      const nav = useNavigate();
      navigateFn = nav;
      return null;
    }

    render(
      <MemoryRouter initialEntries={['/projects/proj-123/chat']}>
        <NavHelper />
        <AppShell>
          <div data-testid="page-content">Page content</div>
        </AppShell>
      </MemoryRouter>,
    );

    // Global nav panel should be hidden initially
    const container = document.body;
    const globalNav = container.querySelector('nav[aria-label="Primary navigation"]');
    expect(globalNav?.getAttribute('aria-hidden')).toBe('true');

    // Toggle to show global nav
    const toggleBtn = screen.getByRole('button', { name: 'Show global navigation' });
    fireEvent.click(toggleBtn);

    // Global nav panel should now be visible (aria-hidden removed or false)
    expect(globalNav?.getAttribute('aria-hidden')).not.toBe('true');

    // Navigate to a different route
    act(() => { navigateFn('/projects/proj-123/ideas'); });

    // Global nav should be hidden again after route change
    const globalNavAfter = container.querySelector('nav[aria-label="Primary navigation"]');
    expect(globalNavAfter?.getAttribute('aria-hidden')).toBe('true');
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
    expect(screen.getByRole('button', { name: 'Ideas' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deployments' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activity' })).not.toBeInTheDocument();
  });

  it('renders icons alongside labels in mobile drawer nav items', () => {
    renderAppShell();

    fireEvent.click(screen.getByLabelText('Open navigation menu'));

    const drawer = screen.getByRole('dialog', { name: 'Navigation menu' });
    // Lucide icons render as <svg> elements — each nav item button should contain an SVG icon
    const navButtons = drawer.querySelectorAll('nav button');
    for (const btn of navButtons) {
      expect(btn.querySelector('svg')).toBeTruthy();
    }
  });

  it('renders icons in mobile drawer project nav items', () => {
    renderAppShell('/projects/proj-123/chat');

    fireEvent.click(screen.getByLabelText('Open navigation menu'));

    const drawer = screen.getByRole('dialog', { name: 'Navigation menu' });
    const navButtons = drawer.querySelectorAll('nav button');
    expect(navButtons.length).toBeGreaterThan(0);
    for (const btn of navButtons) {
      expect(btn.querySelector('svg')).toBeTruthy();
    }
  });

  it('shows project name header in mobile drawer when in project context', () => {
    renderAppShell('/projects/proj-123/chat');

    fireEvent.click(screen.getByLabelText('Open navigation menu'));

    const drawer = screen.getByRole('dialog', { name: 'Navigation menu' });
    expect(within(drawer).getByText('Project')).toBeInTheDocument();
  });

  it('shows Infrastructure section in mobile drawer for non-superadmins', () => {
    renderAppShell();

    fireEvent.click(screen.getByLabelText('Open navigation menu'));

    expect(screen.getByText('Infrastructure')).toBeInTheDocument();
  });

  it('expands Infrastructure to show Nodes and Workspaces in mobile drawer', () => {
    renderAppShell();

    fireEvent.click(screen.getByLabelText('Open navigation menu'));
    fireEvent.click(screen.getByText('Infrastructure'));

    expect(screen.getByRole('button', { name: 'Nodes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Workspaces' })).toBeInTheDocument();
  });

  it('renders sign out with icon in mobile drawer', () => {
    renderAppShell();

    fireEvent.click(screen.getByLabelText('Open navigation menu'));

    const signOutBtn = screen.getByRole('button', { name: 'Sign out' });
    expect(signOutBtn.querySelector('svg')).toBeTruthy();
  });

  it('closes the mobile drawer when Escape is pressed', () => {
    vi.useFakeTimers();
    renderAppShell();

    fireEvent.click(screen.getByLabelText('Open navigation menu'));
    expect(screen.getByRole('dialog', { name: 'Navigation menu' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    act(() => vi.advanceTimersByTime(250));

    expect(screen.queryByRole('dialog', { name: 'Navigation menu' })).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('closes the drawer after navigating to a nav item', () => {
    renderAppShell();

    fireEvent.click(screen.getByLabelText('Open navigation menu'));
    expect(screen.getByRole('dialog', { name: 'Navigation menu' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Home' }));

    expect(screen.queryByRole('dialog', { name: 'Navigation menu' })).not.toBeInTheDocument();
  });

  it('shows Infrastructure in toggled global view when non-superadmin is inside a project', () => {
    renderAppShell('/projects/proj-123/chat');

    fireEvent.click(screen.getByLabelText('Open navigation menu'));
    fireEvent.click(screen.getByTestId('mobile-nav-toggle'));

    expect(screen.getByText('Infrastructure')).toBeInTheDocument();
  });

  it('closes the drawer when backdrop is clicked', () => {
    vi.useFakeTimers();
    renderAppShell();

    fireEvent.click(screen.getByLabelText('Open navigation menu'));
    expect(screen.getByRole('dialog', { name: 'Navigation menu' })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('mobile-nav-backdrop'));
    act(() => vi.advanceTimersByTime(250));

    expect(screen.queryByRole('dialog', { name: 'Navigation menu' })).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe('AppShell (Focus Mode — desktop)', () => {
  // The grid wrapper carries the collapsing nav column as an inline width.
  // navWidthForMode: default=220, focus=56, zen=0 (see src/lib/focus-mode.ts).
  function gridColumns(): string {
    const grid = document.querySelector('div.grid.h-screen') as HTMLElement | null;
    expect(grid).toBeTruthy();
    return grid!.style.gridTemplateColumns;
  }

  beforeEach(() => {
    matchMediaMatches = false; // desktop — Focus Mode is desktop-only
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('persists mode changes to localStorage and collapses the nav column', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderAppShell();

    // Default: full nav rail (220px) and the segmented toggle is visible.
    expect(gridColumns()).toBe('220px 1fr');
    expect(screen.getByRole('group', { name: 'Focus Mode' })).toBeInTheDocument();

    // Select Focus -> nav collapses to the 56px icon rail, persisted.
    fireEvent.click(screen.getByRole('button', { name: 'Focus', exact: true }));
    expect(setItem).toHaveBeenCalledWith('sam:focus-mode', 'focus');
    expect(gridColumns()).toBe('56px 1fr');

    // In focus mode the compact cycle control replaces the segmented group.
    const cycle = screen.getByRole('button', {
      name: /Focus Mode: Focus\. Activate to switch to Zen/,
    });
    fireEvent.click(cycle);
    expect(setItem).toHaveBeenCalledWith('sam:focus-mode', 'zen');
    expect(gridColumns()).toBe('0px 1fr');
  });

  it('hydrates the persisted mode across reloads', () => {
    // Simulate a prior session that left Focus Mode in "focus".
    window.localStorage.setItem('sam:focus-mode', 'focus');
    renderAppShell();

    // The hydration effect reads localStorage on mount and collapses to 56px.
    expect(gridColumns()).toBe('56px 1fr');
    // The compact cycle control (not the segmented group) is shown in focus mode.
    expect(
      screen.getByRole('button', { name: /Focus Mode: Focus\. Activate to switch to Zen/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Focus Mode' })).not.toBeInTheDocument();
  });

  it('cycles default -> focus -> zen -> default with the F key', () => {
    renderAppShell();
    expect(gridColumns()).toBe('220px 1fr');

    fireEvent.keyDown(window, { key: 'f' });
    expect(gridColumns()).toBe('56px 1fr');

    fireEvent.keyDown(window, { key: 'f' });
    expect(gridColumns()).toBe('0px 1fr');

    fireEvent.keyDown(window, { key: 'f' });
    expect(gridColumns()).toBe('220px 1fr');
  });

  it('disables the column transition under prefers-reduced-motion', () => {
    renderAppShell();
    const grid = document.querySelector('div.grid.h-screen') as HTMLElement | null;
    expect(grid).toBeTruthy();
    // The grid animates grid-template-columns, but must opt out when the user
    // requests reduced motion (Tailwind motion-reduce: variant).
    expect(grid!.className).toContain('transition-[grid-template-columns]');
    expect(grid!.className).toContain('motion-reduce:transition-none');
  });

  it('ignores the F key while typing in an input', () => {
    renderAppShell();
    const search = screen.getByLabelText('Open command palette');
    // Focus a text-like element and press F — Focus Mode must not cycle.
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: 'f' });
    expect(gridColumns()).toBe('220px 1fr');
    input.remove();
    expect(search).toBeInTheDocument();
  });

  it('ignores the F key while a select element is focused', () => {
    renderAppShell();
    // A native <select> captures "f" for type-ahead option matching, so the
    // global Focus Mode cycle must not also fire.
    const select = document.createElement('select');
    document.body.appendChild(select);
    select.focus();
    fireEvent.keyDown(select, { key: 'f' });
    expect(gridColumns()).toBe('220px 1fr');
    select.remove();
  });
});

describe('AppShell (Focus Mode — mobile is disabled)', () => {
  beforeEach(() => {
    matchMediaMatches = true; // mobile
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('never renders the Focus Mode toggle and ignores a persisted mode', () => {
    // Even with a persisted non-default mode, mobile must stay default.
    window.localStorage.setItem('sam:focus-mode', 'zen');
    renderAppShell();

    expect(screen.queryByRole('group', { name: 'Focus Mode' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Focus Mode: .*Activate to switch/ }),
    ).not.toBeInTheDocument();
    // The collapsing desktop grid wrapper is not used on mobile.
    expect(document.querySelector('div.grid.h-screen')).toBeNull();
  });

  it('does not cycle Focus Mode when the F key is pressed', () => {
    renderAppShell();
    fireEvent.keyDown(window, { key: 'f' });
    expect(
      screen.queryByRole('button', { name: /Focus Mode: .*Activate to switch/ }),
    ).not.toBeInTheDocument();
  });
});
