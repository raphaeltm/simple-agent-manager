import type { ProjectSummary } from '@simple-agent-manager/shared';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '../../../src/components/AuthProvider';
import { GITHUB_REAUTH_REQUIRED_EVENT } from '../../../src/lib/api/client';
import { queryClient } from '../../../src/lib/query-client';
import { projectQueryKeys } from '../../../src/lib/query-options';

const {
  mockUseSession,
  mockSignOut,
  mockClearLibraryCache,
  mockClearLegacyLibraryCache,
  mockBroadcastAuthRevocation,
  mockCleanupTerminalSecrets,
  mockInitAuthBroadcastListener,
  mockResetAuthRevoked,
  mockTeardownAuthBroadcastListener,
} = vi.hoisted(() => ({
  mockUseSession: vi.fn(),
  mockSignOut: vi.fn(),
  mockClearLibraryCache: vi.fn(),
  mockClearLegacyLibraryCache: vi.fn(),
  mockBroadcastAuthRevocation: vi.fn(),
  mockCleanupTerminalSecrets: vi.fn(),
  mockInitAuthBroadcastListener: vi.fn(),
  mockResetAuthRevoked: vi.fn(),
  mockTeardownAuthBroadcastListener: vi.fn(),
}));

vi.mock('../../../src/lib/auth', () => ({
  signOut: () => mockSignOut(),
  useSession: () => mockUseSession(),
}));

vi.mock('../../../src/lib/library-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/library-cache')>()),
  clearLibraryCache: mockClearLibraryCache,
  clearLegacyLibraryCache: mockClearLegacyLibraryCache,
}));

vi.mock('../../../src/lib/terminal-cleanup', () => ({
  broadcastAuthRevocation: mockBroadcastAuthRevocation,
  cleanupTerminalSecrets: mockCleanupTerminalSecrets,
  initAuthBroadcastListener: mockInitAuthBroadcastListener,
  resetAuthRevoked: mockResetAuthRevoked,
  teardownAuthBroadcastListener: mockTeardownAuthBroadcastListener,
}));

const clearQueryCacheSpy = vi.spyOn(queryClient, 'clear');

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

function renderWithAuth(children = <AuthConsumer />) {
  return render(<AuthProvider>{children}</AuthProvider>);
}

const validSession = {
  user: { id: 'u1', email: 'test@test.com', name: 'Test User', role: 'user', status: 'active' },
  session: { id: 's1' },
};

const PRIVATE_PROJECT = {
  id: 'private-project',
  name: 'User one private project',
  repository: 'private/repository',
  githubRepoId: 101,
  defaultBranch: 'main',
  repoProvider: 'github',
  status: 'active',
  activeWorkspaceCount: 1,
  activeSessionCount: 0,
  lastActivityAt: '2026-08-07T20:00:00.000Z',
  createdAt: '2026-08-07T19:00:00.000Z',
  taskCountsByStatus: {},
  linkedWorkspaces: 1,
} satisfies ProjectSummary;

const cacheRenderLog: string[] = [];

function ScopedProjectCacheConsumer() {
  const { user } = useAuth();
  const queryScope = user?.id ?? '';
  const { data = [] } = useQuery({
    queryKey: projectQueryKeys.list(queryScope, 50),
    queryFn: async (): Promise<ProjectSummary[]> => [],
    enabled: Boolean(queryScope),
  });
  const renderedProject = data[0]?.name ?? 'none';
  cacheRenderLog.push(`${queryScope}:${renderedProject}`);
  return (
    <div>
      <span data-testid="cache-user">{queryScope}</span>
      <span data-testid="cached-project">{renderedProject}</span>
    </div>
  );
}

describe('AuthProvider', () => {
  beforeEach(() => {
    queryClient.clear();
    clearQueryCacheSpy.mockClear();
    vi.clearAllMocks();
    cacheRenderLog.length = 0;
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
      </AuthProvider>
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
      </AuthProvider>
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
      </AuthProvider>
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
      </AuthProvider>
    );
    expect(screen.getByTestId('authenticated')).toHaveTextContent('true');
    expect(screen.getByTestId('user-name')).toHaveTextContent('Updated User');
  });

  it('does not clear the same user namespace during transient refetch errors', () => {
    mockUseSession.mockReturnValue({
      data: validSession,
      isPending: false,
      error: null,
      isRefetching: false,
    });
    const { rerender } = renderWithAuth();
    expect(mockClearLegacyLibraryCache).toHaveBeenCalledTimes(1);
    clearQueryCacheSpy.mockClear();
    mockBroadcastAuthRevocation.mockClear();
    mockCleanupTerminalSecrets.mockClear();
    mockResetAuthRevoked.mockClear();

    mockUseSession.mockReturnValue({
      data: null,
      isPending: false,
      error: new Error('Network error'),
      isRefetching: true,
    });
    rerender(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>
    );

    expect(screen.getByTestId('authenticated')).toHaveTextContent('true');
    expect(mockClearLibraryCache).not.toHaveBeenCalled();
    expect(mockClearLegacyLibraryCache).toHaveBeenCalledTimes(1);
    expect(clearQueryCacheSpy).not.toHaveBeenCalled();
    expect(mockCleanupTerminalSecrets).not.toHaveBeenCalled();
    expect(mockBroadcastAuthRevocation).not.toHaveBeenCalled();
    expect(mockResetAuthRevoked).not.toHaveBeenCalled();
  });

  it('clears the previous user namespace and legacy cache on clean null session expiry', () => {
    mockUseSession.mockReturnValue({
      data: validSession,
      isPending: false,
      error: null,
      isRefetching: false,
    });
    const { rerender } = renderWithAuth();
    mockClearLibraryCache.mockClear();
    mockClearLegacyLibraryCache.mockClear();
    clearQueryCacheSpy.mockClear();
    mockBroadcastAuthRevocation.mockClear();
    mockCleanupTerminalSecrets.mockClear();
    mockResetAuthRevoked.mockClear();

    mockUseSession.mockReturnValue({
      data: null,
      isPending: false,
      error: null,
      isRefetching: false,
    });
    rerender(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>
    );

    expect(screen.getByTestId('authenticated')).toHaveTextContent('false');
    expect(mockClearLibraryCache).toHaveBeenCalledWith('user:u1');
    expect(mockClearLegacyLibraryCache).toHaveBeenCalledOnce();
    expect(clearQueryCacheSpy).toHaveBeenCalledOnce();
    expect(mockCleanupTerminalSecrets).toHaveBeenCalledOnce();
    expect(mockBroadcastAuthRevocation).toHaveBeenCalledOnce();
    expect(mockResetAuthRevoked).not.toHaveBeenCalled();
  });

  it('clears the previous user namespace on account switch without clearing the new user cache', () => {
    mockUseSession.mockReturnValue({
      data: validSession,
      isPending: false,
      error: null,
      isRefetching: false,
    });
    const { rerender } = renderWithAuth();
    mockClearLibraryCache.mockClear();
    mockClearLegacyLibraryCache.mockClear();
    clearQueryCacheSpy.mockClear();
    mockBroadcastAuthRevocation.mockClear();
    mockCleanupTerminalSecrets.mockClear();
    mockResetAuthRevoked.mockClear();

    mockUseSession.mockReturnValue({
      data: {
        ...validSession,
        user: { ...validSession.user, id: 'u2', email: 'other@test.com', name: 'Other User' },
      },
      isPending: false,
      error: null,
      isRefetching: false,
    });
    rerender(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>
    );

    expect(screen.getByTestId('user-name')).toHaveTextContent('Other User');
    expect(mockClearLibraryCache).toHaveBeenCalledTimes(1);
    expect(mockClearLibraryCache).toHaveBeenCalledWith('user:u1');
    expect(mockClearLibraryCache).not.toHaveBeenCalledWith('user:u2');
    expect(mockClearLegacyLibraryCache).toHaveBeenCalledOnce();
    expect(clearQueryCacheSpy).toHaveBeenCalledOnce();
    expect(mockCleanupTerminalSecrets).toHaveBeenCalledOnce();
    expect(mockBroadcastAuthRevocation).toHaveBeenCalledOnce();
    expect(mockResetAuthRevoked).toHaveBeenCalledOnce();
  });

  it('never renders the previous user query cache during a direct account switch', async () => {
    mockUseSession.mockReturnValue({
      data: validSession,
      isPending: false,
      error: null,
      isRefetching: false,
    });

    const renderTree = () => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ScopedProjectCacheConsumer />
        </AuthProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(renderTree());
    await waitFor(() => expect(screen.getByTestId('cache-user')).toHaveTextContent('u1'));

    act(() => {
      queryClient.setQueryData(projectQueryKeys.list('u1', 50), [PRIVATE_PROJECT]);
    });
    await waitFor(() => {
      expect(screen.getByTestId('cached-project')).toHaveTextContent(PRIVATE_PROJECT.name);
    });
    cacheRenderLog.length = 0;

    mockUseSession.mockReturnValue({
      data: {
        ...validSession,
        user: { ...validSession.user, id: 'u2', email: 'other@test.com', name: 'Other User' },
      },
      isPending: false,
      error: null,
      isRefetching: false,
    });
    rerender(renderTree());

    await waitFor(() => expect(screen.getByTestId('cache-user')).toHaveTextContent('u2'));
    expect(screen.getByTestId('cached-project')).toHaveTextContent('none');
    expect(cacheRenderLog).not.toContain(`u2:${PRIVATE_PROJECT.name}`);
    expect(queryClient.getQueryData(projectQueryKeys.list('u1', 50))).toBeUndefined();
  });

  it('gates protected cache consumers while the next identity is unresolved', async () => {
    mockUseSession.mockReturnValue({
      data: validSession,
      isPending: false,
      error: null,
      isRefetching: false,
    });

    const renderTree = () => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ScopedProjectCacheConsumer />
        </AuthProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(renderTree());
    await waitFor(() => expect(screen.getByTestId('cache-user')).toHaveTextContent('u1'));

    act(() => {
      queryClient.setQueryData(projectQueryKeys.list('u1', 50), [PRIVATE_PROJECT]);
    });
    await waitFor(() => {
      expect(screen.getByTestId('cached-project')).toHaveTextContent(PRIVATE_PROJECT.name);
    });

    mockUseSession.mockReturnValue({
      data: null,
      isPending: true,
      error: null,
      isRefetching: false,
    });
    rerender(renderTree());

    expect(screen.queryByTestId('cache-user')).not.toBeInTheDocument();
    expect(screen.queryByText(PRIVATE_PROJECT.name)).not.toBeInTheDocument();
  });

  it('shows a GitHub reauth prompt and signs out when reconnect is clicked', () => {
    mockUseSession.mockReturnValue({
      data: validSession,
      isPending: false,
      error: null,
      isRefetching: false,
    });
    renderWithAuth();

    fireEvent(
      window,
      new CustomEvent(GITHUB_REAUTH_REQUIRED_EVENT, {
        detail: {
          message: 'Your GitHub authorization has expired — please sign out and back in',
        },
      })
    );

    expect(screen.getByRole('alert')).toHaveTextContent('GitHub sign-in required');
    expect(
      screen.getByText('Your GitHub authorization has expired — please sign out and back in')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out and reconnect' }));

    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});
