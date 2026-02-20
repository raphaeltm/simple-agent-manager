import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { MobileNavDrawer } from '../../../src/components/MobileNavDrawer';

const defaultProps = {
  onClose: vi.fn(),
  user: { name: 'Dev User', email: 'dev@example.com', image: null },
  navItems: [
    { label: 'Dashboard', path: '/dashboard' },
    { label: 'Projects', path: '/projects' },
    { label: 'Nodes', path: '/nodes' },
    { label: 'Settings', path: '/settings' },
  ],
  currentPath: '/dashboard',
  onNavigate: vi.fn(),
  onSignOut: vi.fn(),
};

describe('MobileNavDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a dialog with navigation links', () => {
    render(<MobileNavDrawer {...defaultProps} />);

    expect(screen.getByRole('dialog', { name: 'Navigation menu' })).toBeInTheDocument();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('Nodes')).toBeInTheDocument();
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

    const dashboardButton = screen.getByText('Dashboard');
    expect(dashboardButton.className).toContain('is-active');

    const projectsButton = screen.getByText('Projects');
    expect(projectsButton.className).not.toContain('is-active');
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

    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when close button is clicked', () => {
    render(<MobileNavDrawer {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Close navigation'));

    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape key is pressed', () => {
    render(<MobileNavDrawer {...defaultProps} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('marks nested path as active for non-dashboard routes', () => {
    render(<MobileNavDrawer {...defaultProps} currentPath="/projects/abc-123" />);

    const projectsButton = screen.getByText('Projects');
    expect(projectsButton.className).toContain('is-active');

    const dashboardButton = screen.getByText('Dashboard');
    expect(dashboardButton.className).not.toContain('is-active');
  });
});
