import { render, screen } from '@testing-library/react';
import { beforeEach,describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '../../../src/components/AuthProvider';

const mockUseSession = vi.fn();

vi.mock('../../../src/lib/auth', () => ({
  useSession: () => mockUseSession(),
}));

function AuthConsumer() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="authenticated">{String(auth.isAuthenticated)}</span>
      <span data-testid="loading">{String(auth.isLoading)}</span>
      <span data-testid="refetching">{String(auth.isRefetching)}</span>
      <span data-testid="user-name">{auth.user?.name ?? 'none'}</span>
    </div>
  );
}

function renderWithAuth() {
  return render(
    <AuthProvider>
      <AuthConsumer />
    </AuthProvider>,
  );
}

const validSession = {
  user: { id: 'u1', email: 'test@test.com', name: 'Test User', role: 'user', status: 'active' },
  session: { id: 's1' },
};

describe('AuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows authenticated when session is valid', () => {
    mockUseSession.mockReturnValue({
      data: validSession,
      isPending: false,
      error: null,
      isRefetching: false,
    });
    renderWithAuth();
    expect(screen.getByTestId('authenticated')).toHaveTextContent('true');
    expect(screen.getByTestId('user-name')).toHaveTextContent('Test User');
  });

  it('shows loading when session is pending', () => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: true,
      error: null,
      isRefetching: false,
    });
    renderWithAuth();
    expect(screen.getByTestId('loading')).toHaveTextContent('true');
    expect(screen.getByTestId('authenticated')).toHaveTextContent('false');
  });

  it('preserves session when refetch error occurs after valid session', () => {
    // First render: valid session
    mockUseSession.mockReturnValue({
      data: validSession,
      isPending: false,
      error: null,
      isRefetching: false,
    });
    const { rerender } = renderWithAuth();
    expect(screen.getByTestId('authenticated')).toHaveTextContent('true');

    // Second render: refetch error wipes session data (BetterAuth behavior)
    mockUseSession.mockReturnValue({
      data: null,
      isPending: false,
      error: new Error('Network error'),
      isRefetching: false,
    });
    rerender(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    // Should still show authenticated using cached session
    expect(screen.getByTestId('authenticated')).toHaveTextContent('true');
    expect(screen.getByTestId('user-name')).toHaveTextContent('Test User');
  });

  it('clears session when error occurs with no prior session', () => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: false,
      error: new Error('Network error'),
      isRefetching: false,
    });
    renderWithAuth();
    expect(screen.getByTestId('authenticated')).toHaveTextContent('false');
    expect(screen.getByTestId('user-name')).toHaveTextContent('none');
  });

  it('exposes isRefetching from BetterAuth', () => {
    mockUseSession.mockReturnValue({
      data: validSession,
      isPending: false,
      error: null,
      isRefetching: true,
    });
    renderWithAuth();
    expect(screen.getByTestId('refetching')).toHaveTextContent('true');
  });

  it('clears cached session on clean null (intentional signout)', () => {
    // Start with valid session
    mockUseSession.mockReturnValue({
      data: validSession,
      isPending: false,
      error: null,
      isRefetching: false,
    });
    const { rerender } = renderWithAuth();
    expect(screen.getByTestId('authenticated')).toHaveTextContent('true');

    // Server returns clean null — no error, not pending (signout or session expiry)
    mockUseSession.mockReturnValue({
      data: null,
      isPending: false,
      error: null,
      isRefetching: false,
    });
    rerender(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    // Must NOT use cached session — this was an intentional signout
    expect(screen.getByTestId('authenticated')).toHaveTextContent('false');
    expect(screen.getByTestId('user-name')).toHaveTextContent('none');
  });

  it('recovers when refetch succeeds after transient error', () => {
    // Start with valid session
    mockUseSession.mockReturnValue({
      data: validSession,
      isPending: false,
      error: null,
      isRefetching: false,
    });
    const { rerender } = renderWithAuth();

    // Error wipes session
    mockUseSession.mockReturnValue({
      data: null,
      isPending: false,
      error: new Error('transient'),
      isRefetching: false,
    });
    rerender(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );
    // Cached session used
    expect(screen.getByTestId('authenticated')).toHaveTextContent('true');

    // Refetch succeeds with new session
    const newSession = {
      ...validSession,
      user: { ...validSession.user, name: 'Updated User' },
    };
    mockUseSession.mockReturnValue({
      data: newSession,
      isPending: false,
      error: null,
      isRefetching: false,
    });
    rerender(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );
    expect(screen.getByTestId('authenticated')).toHaveTextContent('true');
    expect(screen.getByTestId('user-name')).toHaveTextContent('Updated User');
  });
});
