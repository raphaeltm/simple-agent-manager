/**
 * AuthProvider must still render when IndexedDB misbehaves.
 *
 * Separate from `auth-provider.test.tsx` because `vi.mock('idb-keyval')` is
 * hoisted and file-wide: that suite exercises the real (fake-indexeddb) store, so
 * the storage-failure cases cannot share a file with it. ESM namespace objects are
 * not configurable, so `vi.spyOn(idbModule, 'get')` is not an option either.
 *
 * Query-cache persistence is an optimisation. Rendering is gated on its restore,
 * so every failure mode here must fail OPEN — degrade to the normal in-memory
 * cache and paint — never hold the app blank.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '../../../src/components/AuthProvider';

const { mockUseSession, idbGet } = vi.hoisted(() => ({
  mockUseSession: vi.fn(),
  idbGet: vi.fn(),
}));

vi.mock('idb-keyval', () => ({
  get: idbGet,
  set: vi.fn().mockResolvedValue(undefined),
  del: vi.fn().mockResolvedValue(undefined),
  delMany: vi.fn().mockResolvedValue(undefined),
  keys: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/lib/auth', () => ({
  signOut: vi.fn(),
  useSession: () => mockUseSession(),
}));

vi.mock('../../../src/lib/library-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/library-cache')>()),
  clearLibraryCache: vi.fn(),
  clearLegacyLibraryCache: vi.fn(),
}));

vi.mock('../../../src/lib/terminal-cleanup', () => ({
  broadcastAuthRevocation: vi.fn(),
  cleanupTerminalSecrets: vi.fn(),
  initAuthBroadcastListener: vi.fn(),
  resetAuthRevoked: vi.fn(),
  teardownAuthBroadcastListener: vi.fn(),
}));

function AuthConsumer() {
  const auth = useAuth();
  return <span data-testid="authenticated">{String(auth.isAuthenticated)}</span>;
}

const validSession = {
  user: { id: 'u1', email: 'test@test.com', name: 'Test User', role: 'user', status: 'active' },
  session: { id: 's1' },
};

describe('AuthProvider — persisted query cache failure modes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSession.mockReturnValue({
      data: validSession,
      isPending: false,
      error: null,
      isRefetching: false,
    });
  });

  it('renders children when the restore never settles', async () => {
    // A hung IndexedDB open. Without the fail-open settle timer in
    // useQueryCachePersistence, children never mount and this test times out —
    // which is exactly the blank-screen failure the timer exists to bound.
    idbGet.mockImplementation(() => new Promise<never>(() => {}));

    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>
    );

    expect(await screen.findByTestId('authenticated')).toHaveTextContent('true');
  });

  it('shows an accessible status affordance while the restore is in flight', async () => {
    // ui-ux review: unmounting ProtectedRoute's "Verifying your session" spinner
    // into a silent blank screen regressed both state clarity and accessibility —
    // a screen reader heard that label and then nothing. The gate must carry the
    // same affordance so the spinner is continuous.
    idbGet.mockImplementation(() => new Promise<never>(() => {}));

    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>
    );

    // Asserted SYNCHRONOUSLY: the affordance is on screen the moment the gate
    // opens, with no blank frame between the session spinner and this one. An
    // awaited query here would let the fail-open budget elapse first and prove
    // nothing.
    expect(screen.getByLabelText('Verifying your session')).toBeInTheDocument();
    expect(screen.queryByTestId('authenticated')).not.toBeInTheDocument();

    // ...and it yields to real content once the fail-open budget elapses.
    expect(await screen.findByTestId('authenticated')).toHaveTextContent('true');
    expect(screen.queryByLabelText('Verifying your session')).not.toBeInTheDocument();
  });

  it('renders children when IndexedDB rejects outright', async () => {
    // Private browsing, or a disabled/blocked store.
    idbGet.mockRejectedValue(new Error('IndexedDB unavailable'));

    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>
    );

    expect(await screen.findByTestId('authenticated')).toHaveTextContent('true');
  });

  it('renders children immediately for a signed-out session and never reads storage', async () => {
    // Anonymous visitors (landing page, /try, /device) have no identity to key a
    // record by, so they must not pay for the gate at all.
    mockUseSession.mockReturnValue({
      data: null,
      isPending: false,
      error: null,
      isRefetching: false,
    });

    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>
    );

    // Synchronous: present on the very first assertion, with no `find`/await gap.
    expect(screen.getByTestId('authenticated')).toHaveTextContent('false');
    expect(idbGet).not.toHaveBeenCalled();
  });
});
