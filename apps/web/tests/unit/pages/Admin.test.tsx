import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Admin } from '../../../src/pages/Admin';

let mockAuthState: Record<string, unknown> = {
  canAccessAdmin: false,
  isSuperadmin: false,
};

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => mockAuthState,
}));

describe('Admin page', () => {
  beforeEach(() => {
    mockAuthState = {
      canAccessAdmin: false,
      isSuperadmin: false,
    };
  });

  it('renders only the Platform Infra tab for admins', () => {
    mockAuthState = { canAccessAdmin: true, isSuperadmin: false };

    render(
      <MemoryRouter initialEntries={['/admin/platform-infra']}>
        <Routes>
          <Route path="/admin" element={<Admin />}>
            <Route path="platform-infra" element={<div>Platform Infra Page</div>} />
            <Route path="users" element={<div>Users Page</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Platform Infra')).toBeInTheDocument();
    expect(screen.queryByText('Users')).not.toBeInTheDocument();
  });

  it('renders full admin tabs for superadmins', () => {
    mockAuthState = { canAccessAdmin: true, isSuperadmin: true };

    render(
      <MemoryRouter initialEntries={['/admin/users']}>
        <Routes>
          <Route path="/admin" element={<Admin />}>
            <Route path="platform-infra" element={<div>Platform Infra Page</div>} />
            <Route path="users" element={<div>Users Page</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Platform Infra')).toBeInTheDocument();
    expect(screen.getByText('Users')).toBeInTheDocument();
  });
});
