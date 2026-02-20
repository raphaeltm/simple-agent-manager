import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  signOut: vi.fn(),
  useIsMobile: vi.fn(() => false),
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({
    user: {
      id: 'user_123',
      email: 'dev@example.com',
      name: 'Dev User',
      image: null,
    },
  }),
}));

vi.mock('../../../src/lib/auth', () => ({
  signOut: mocks.signOut,
}));

vi.mock('../../../src/hooks/useIsMobile', () => ({
  useIsMobile: () => mocks.useIsMobile(),
}));

import { UserMenu } from '../../../src/components/UserMenu';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderUserMenu(initialEntry = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="*"
          element={(
            <>
              <UserMenu />
              <LocationProbe />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('UserMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useIsMobile.mockReturnValue(false);
  });

  describe('desktop mode', () => {
    it('renders top-level primary navigation links', () => {
      renderUserMenu();

      expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Projects' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Nodes' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    });

    it('navigates to projects from top-level nav without opening profile menu', () => {
      renderUserMenu();

      fireEvent.click(screen.getByRole('link', { name: 'Projects' }));

      expect(screen.getByTestId('location')).toHaveTextContent('/projects');
    });

    it('keeps sign out action in the profile menu', () => {
      renderUserMenu();

      fireEvent.click(screen.getByRole('button', { name: 'D' }));
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

      expect(mocks.signOut).toHaveBeenCalledTimes(1);
    });
  });

  describe('mobile mode', () => {
    beforeEach(() => {
      mocks.useIsMobile.mockReturnValue(true);
    });

    it('renders avatar-only button instead of inline nav links', () => {
      renderUserMenu();

      expect(screen.getByLabelText('Open navigation menu')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Projects' })).not.toBeInTheDocument();
    });

    it('opens navigation drawer on avatar click', () => {
      renderUserMenu();

      fireEvent.click(screen.getByLabelText('Open navigation menu'));

      expect(screen.getByRole('dialog', { name: 'Navigation menu' })).toBeInTheDocument();
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
      expect(screen.getByText('Projects')).toBeInTheDocument();
    });

    it('navigates and closes drawer when nav item clicked', () => {
      renderUserMenu();

      fireEvent.click(screen.getByLabelText('Open navigation menu'));
      fireEvent.click(screen.getByText('Projects'));

      expect(screen.getByTestId('location')).toHaveTextContent('/projects');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('closes drawer on backdrop click', () => {
      renderUserMenu();

      fireEvent.click(screen.getByLabelText('Open navigation menu'));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('mobile-nav-backdrop'));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('calls sign out from drawer', () => {
      renderUserMenu();

      fireEvent.click(screen.getByLabelText('Open navigation menu'));
      fireEvent.click(screen.getByText('Sign out'));

      expect(mocks.signOut).toHaveBeenCalledTimes(1);
    });
  });
});
