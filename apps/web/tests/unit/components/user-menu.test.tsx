import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  signOut: vi.fn(),
  useAuth: vi.fn(),
}));

const DEFAULT_USER = {
  id: 'user_123',
  email: 'dev@example.com',
  name: 'Dev User',
  image: null,
};

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: mocks.useAuth,
}));

vi.mock('../../../src/lib/auth', () => ({
  signOut: mocks.signOut,
}));

import { UserMenu } from '../../../src/components/UserMenu';
import { THEME_STORAGE_KEY, ThemeProvider } from '../../../src/contexts/ThemeContext';

/**
 * Install a controllable `matchMedia` so System mode resolves deterministically.
 * jsdom does not implement matchMedia; the global setup stubs it, but we install
 * a per-suite mock with a known OS preference so the System-click assertion is
 * stable regardless of harness defaults.
 */
function installMatchMedia(prefersDark: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: prefersDark,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  } as unknown as MediaQueryList);
}

function renderUserMenu() {
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <UserMenu />
      </MemoryRouter>
    </ThemeProvider>
  );
}

describe('UserMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useAuth.mockReturnValue({ user: DEFAULT_USER });
    localStorage.clear();
    document.documentElement.removeAttribute('data-ui-theme');
    installMatchMedia(true); // OS prefers dark by default in this suite
  });

  it('renders user name', () => {
    renderUserMenu();
    expect(screen.getByText('Dev User')).toBeInTheDocument();
  });

  it('renders avatar initial when no image provided', () => {
    renderUserMenu();
    expect(screen.getByText('D')).toBeInTheDocument();
  });

  it('opens dropdown when avatar button clicked', () => {
    renderUserMenu();
    // Click the avatar/name button to open dropdown
    fireEvent.click(screen.getByText('Dev User'));
    // Should show email in dropdown
    expect(screen.getByText('dev@example.com')).toBeInTheDocument();
  });

  it('shows sign out button in dropdown', () => {
    renderUserMenu();
    fireEvent.click(screen.getByText('Dev User'));
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('calls signOut when sign out button clicked', () => {
    renderUserMenu();
    fireEvent.click(screen.getByText('Dev User'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });

  it('renders the three-way theme switcher in the dropdown and switches to Light', () => {
    renderUserMenu();
    fireEvent.click(screen.getByText('Dev User'));

    // The shared switcher offers all three options.
    const group = screen.getByRole('group', { name: 'Theme' });
    expect(group).toBeInTheDocument();
    const light = screen.getByRole('button', { name: 'Light' });

    fireEvent.click(light);

    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('sam-light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(light).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches to Dark from the dropdown switcher', () => {
    renderUserMenu();
    fireEvent.click(screen.getByText('Dev User'));

    const dark = screen.getByRole('button', { name: 'Dark' });
    fireEvent.click(dark);

    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('sam');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(dark).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches to System and resolves via the OS preference', () => {
    // OS prefers dark (installed in beforeEach) → System resolves to sam.
    renderUserMenu();
    fireEvent.click(screen.getByText('Dev User'));

    const system = screen.getByRole('button', { name: 'System' });
    fireEvent.click(system);

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('sam');
    expect(system).toHaveAttribute('aria-pressed', 'true');
  });

  it('exposes accessible attributes on the menu trigger', () => {
    renderUserMenu();
    const trigger = screen.getByRole('button', { name: 'User menu' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('does not render navigation links (moved to AppShell)', () => {
    renderUserMenu();
    expect(screen.queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Projects' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Nodes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('closes dropdown when clicking outside', () => {
    renderUserMenu();
    fireEvent.click(screen.getByText('Dev User'));
    expect(screen.getByText('dev@example.com')).toBeInTheDocument();

    // Click outside the menu
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('dev@example.com')).not.toBeInTheDocument();
  });

  it('renders nothing when there is no authenticated user', () => {
    mocks.useAuth.mockReturnValue({ user: null });
    const { container } = renderUserMenu();
    // UserMenu returns null for a missing user — no trigger, no name.
    expect(container.querySelector('button')).toBeNull();
    expect(screen.queryByText('Dev User')).not.toBeInTheDocument();
  });
});
