import { act, fireEvent, render as baseRender, type RenderOptions, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileNavDrawer } from '../../../src/components/MobileNavDrawer';
import { ThemeProvider } from '../../../src/contexts/ThemeContext';

// MobileNavDrawer renders the shared <ThemeSwitcher />, which calls useTheme and
// therefore requires a ThemeProvider ancestor.
function render(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  return baseRender(ui, { wrapper: ThemeProvider, ...options });
}

const defaultProps = {
  onClose: vi.fn(),
  user: { name: 'Dev User', email: 'dev@example.com', image: null },
  navItems: [
    { label: 'Home', path: '/dashboard' },
    { label: 'Projects', path: '/projects' },
    { label: 'Settings', path: '/settings' },
  ],
  currentPath: '/dashboard',
  onNavigate: vi.fn(),
  onSignOut: vi.fn(),
};

describe('MobileNavDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('renders a dialog with navigation links', () => {
    render(<MobileNavDrawer {...defaultProps} />);

    expect(screen.getByRole('dialog', { name: 'Navigation menu' })).toBeInTheDocument();
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('renders user info in the header', () => {
    render(<MobileNavDrawer {...defaultProps} />);

    expect(screen.getByText('Dev User')).toBeInTheDocument();
    expect(screen.getByText('dev@example.com')).toBeInTheDocument();
  });

  it('renders user avatar image when provided', () => {
    render(
      <MobileNavDrawer
        {...defaultProps}
        user={{ name: 'Dev User', email: 'dev@example.com', image: 'https://example.com/avatar.jpg' }}
      />
    );

    expect(screen.getByAltText('Dev User')).toBeInTheDocument();
  });

  it('renders initial letter when no avatar image', () => {
    render(<MobileNavDrawer {...defaultProps} />);

    // The fallback should show 'D' for 'Dev User'
    expect(screen.getByText('D')).toBeInTheDocument();
  });

  it('highlights the active navigation item', () => {
    render(<MobileNavDrawer {...defaultProps} currentPath="/dashboard" />);

    const homeButton = screen.getByText('Home');
    expect(homeButton.className).toContain('text-accent');

    const projectsButton = screen.getByText('Projects');
    expect(projectsButton.className).not.toContain('text-accent');
  });

  it('calls onNavigate when a nav item is clicked', () => {
    render(<MobileNavDrawer {...defaultProps} />);

    fireEvent.click(screen.getByText('Projects'));

    expect(defaultProps.onNavigate).toHaveBeenCalledWith('/projects');
  });

  it('calls onSignOut when sign out button is clicked', () => {
    render(<MobileNavDrawer {...defaultProps} />);

    fireEvent.click(screen.getByText('Sign out'));

    expect(defaultProps.onSignOut).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    render(<MobileNavDrawer {...defaultProps} />);

    fireEvent.click(screen.getByTestId('mobile-nav-backdrop'));

    expect(screen.getByTestId('mobile-nav-panel')).toHaveAttribute('data-state', 'closing');
    act(() => vi.advanceTimersByTime(250));

    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when close button is clicked', () => {
    render(<MobileNavDrawer {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Close navigation'));

    expect(screen.getByTestId('mobile-nav-panel')).toHaveAttribute('data-state', 'closing');
    act(() => vi.advanceTimersByTime(250));

    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape key is pressed', () => {
    render(<MobileNavDrawer {...defaultProps} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.getByTestId('mobile-nav-panel')).toHaveAttribute('data-state', 'closing');
    act(() => vi.advanceTimersByTime(250));

    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });


  it('focuses the drawer panel on open, traps Tab, and restores opener focus on unmount', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open navigation';
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = render(<MobileNavDrawer {...defaultProps} />);

    const panel = screen.getByRole('dialog', { name: 'Navigation menu' });
    const close = screen.getByLabelText('Close navigation');
    const signOut = screen.getByRole('button', { name: 'Sign out' });

    expect(panel).toHaveFocus();

    signOut.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();

    close.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(signOut).toHaveFocus();

    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('locks body scroll and isolates background siblings while mounted', () => {
    const background = document.createElement('main');
    document.body.appendChild(background);

    const { unmount } = render(<MobileNavDrawer {...defaultProps} />);

    expect(document.body.style.overflow).toBe('hidden');
    expect(background).toHaveAttribute('aria-hidden', 'true');
    expect(background.inert).toBe(true);

    unmount();

    expect(document.body.style.overflow).toBe('');
    expect(background).not.toHaveAttribute('aria-hidden');
    expect(background.inert).not.toBe(true);
    background.remove();
  });

  it('keeps focus out of the inactive sliding nav panel', () => {
    render(
      <MobileNavDrawer
        {...defaultProps}
        projectName="Test Project"
        navItems={[{ label: 'Chat', path: '/projects/p1/chat' }]}
        globalNavItems={[{ label: 'Projects', path: '/projects' }]}
        currentPath="/projects/p1/chat"
        showGlobalNav={false}
        onToggleGlobalNav={vi.fn()}
      />,
    );

    const panel = screen.getByTestId('mobile-nav-panel');
    const slidingPanels = panel.querySelectorAll('nav [aria-hidden]');

    expect(slidingPanels).toHaveLength(1);
    expect(slidingPanels[0]).toHaveAttribute('aria-hidden', 'true');
    expect(slidingPanels[0]).toHaveAttribute('inert');
  });

  it('keeps drawer width within a mobile viewport class contract', () => {
    render(<MobileNavDrawer {...defaultProps} />);

    const panel = screen.getByTestId('mobile-nav-panel');
    expect(panel.className).toContain('w-[85vw]');
    expect(panel.className).toContain('max-w-80');
  });

  it('marks nested path as active for non-dashboard routes', () => {
    render(<MobileNavDrawer {...defaultProps} currentPath="/projects/abc-123" />);

    const projectsButton = screen.getByText('Projects');
    expect(projectsButton.className).toContain('text-accent');

    const homeButton = screen.getByText('Home');
    expect(homeButton.className).not.toContain('text-accent');
  });


  it('does not render command palette search button in drawer', () => {
    render(<MobileNavDrawer {...defaultProps} />);

    expect(screen.queryByLabelText('Open command palette')).not.toBeInTheDocument();
  });
});
