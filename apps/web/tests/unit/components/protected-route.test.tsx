import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach,describe, expect, it, vi } from 'vitest';

import { ProtectedRoute } from '../../../src/components/ProtectedRoute';

const mockUseAuth = vi.fn();

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../../../src/pages/PendingApproval', () => ({
  PendingApproval: () => <div data-testid="pending-approval" />,
}));

vi.mock('@simple-agent-manager/ui', () => ({
  Spinner: ({ size }: { size: string }) => <div data-testid="spinner" data-size={size} />,
}));

/** Captures location.state so we can verify ProtectedRoute passes state.from */
function LandingWithState() {
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } })?.from;
  return (
    <div data-testid="landing">
      {from && <span data-testid="from-path">{from.pathname}</span>}
    </div>
  );
}

function renderProtected(initialPath = '/protected') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<LandingWithState />} />
        <Route
          path="/protected"
          element={
            <ProtectedRoute>
              <div data-testid="protected-content" />
            </ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows spinner when loading', () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: true,
      isApproved: false,
      isRefetching: false,
      user: null,
    });
    renderProtected();
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('landing')).not.toBeInTheDocument();
  });

  it('shows spinner during refetch when not authenticated (transient error)', () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
      isApproved: false,
      isRefetching: true,
      user: null,
    });
    renderProtected();
    // Should show spinner, NOT redirect to login
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
    expect(screen.queryByTestId('landing')).not.toBeInTheDocument();
  });

  it('redirects to login when not authenticated and not refetching', () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
      isApproved: false,
      isRefetching: false,
      user: null,
    });
    renderProtected();
    expect(screen.getByTestId('landing')).toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('passes location.state.from when redirecting to login', () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
      isApproved: false,
      isRefetching: false,
      user: null,
    });
    renderProtected('/protected');
    // Verify the redirect includes state.from so Landing can navigate back
    expect(screen.getByTestId('landing')).toBeInTheDocument();
    expect(screen.getByTestId('from-path')).toHaveTextContent('/protected');
  });

  it('renders children when authenticated', () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      isApproved: true,
      isRefetching: false,
      user: { id: 'u1', email: 'test@test.com', name: 'Test', role: 'user', status: 'active' },
    });
    renderProtected();
    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
  });

  it('renders children when authenticated and refetching (no disruption)', () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      isApproved: true,
      isRefetching: true,
      user: { id: 'u1', email: 'test@test.com', name: 'Test', role: 'user', status: 'active' },
    });
    renderProtected();
    // Refetching while authenticated should NOT show spinner or redirect
    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
    expect(screen.queryByTestId('spinner')).not.toBeInTheDocument();
  });

  it('shows PendingApproval for unapproved pending user', () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      isApproved: false,
      isRefetching: false,
      user: { id: 'u1', email: 'test@test.com', name: 'Test', role: 'user', status: 'pending' },
    });
    renderProtected();
    expect(screen.getByTestId('pending-approval')).toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('skips approval check when skipApprovalCheck is true', () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      isApproved: false,
      isRefetching: false,
      user: { id: 'u1', email: 'test@test.com', name: 'Test', role: 'user', status: 'pending' },
    });
    render(
      <MemoryRouter initialEntries={['/protected']}>
        <Routes>
          <Route path="/" element={<LandingWithState />} />
          <Route
            path="/protected"
            element={
              <ProtectedRoute skipApprovalCheck>
                <div data-testid="protected-content" />
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
    expect(screen.queryByTestId('pending-approval')).not.toBeInTheDocument();
  });
});
