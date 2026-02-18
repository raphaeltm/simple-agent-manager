import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  signOut: vi.fn(),
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({
    user: {
      id: 'user_123',
      email: 'dev@example.com',
      name: 'Dev User',
    },
  }),
}));

vi.mock('../../../src/lib/auth', () => ({
  signOut: mocks.signOut,
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
  });

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
