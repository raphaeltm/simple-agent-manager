import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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

function renderProtected(initialPath = '/protected') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<div data-testid="landing" />} />
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
});
