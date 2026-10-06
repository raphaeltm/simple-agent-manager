import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock better-auth before importing auth module
const mockSignOut = vi.fn();
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    signOut: mockSignOut,
    signIn: { social: vi.fn() },
    useSession: vi.fn(),
  }),
}));

// Mock library-cache
const mockClearLibraryCache = vi.fn();
const mockClearLegacyLibraryCache = vi.fn();
const mockUnsubscribeWebPush = vi.fn();
vi.mock('../../../src/lib/library-cache', () => ({
  clearLibraryCache: mockClearLibraryCache,
  clearLegacyLibraryCache: mockClearLegacyLibraryCache,
}));
vi.mock('../../../src/lib/api/notifications', () => ({
  unsubscribeWebPush: mockUnsubscribeWebPush,
}));

// signOut dynamically imports this module to keep idb-keyval out of the eager
// bundle; mocking it here proves the wiring survives that indirection.
const mockRemoveAllPersistedQueryCaches = vi.fn();
vi.mock('../../../src/lib/query-persistence', () => ({
  removeAllPersistedQueryCaches: mockRemoveAllPersistedQueryCaches,
}));

describe('signOut', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Capture the onSuccess callback when signOut is called
    mockSignOut.mockImplementation(async (opts: { fetchOptions: { onSuccess: () => void } }) => {
      // Simulate successful sign-out by invoking onSuccess
      opts.fetchOptions.onSuccess();
    });
    // Prevent actual navigation
    Object.defineProperty(window, 'location', {
      value: { href: '' },
      writable: true,
    });
    mockUnsubscribeWebPush.mockResolvedValue(undefined);
    mockRemoveAllPersistedQueryCaches.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears namespaced and legacy library cache before sign-out completes', async () => {
    const { signOut } = await import('../../../src/lib/auth');

    await signOut();

    expect(mockClearLibraryCache).toHaveBeenCalledOnce();
    expect(mockClearLegacyLibraryCache).toHaveBeenCalledOnce();
    expect(mockSignOut).toHaveBeenCalledOnce();
    expect(mockClearLibraryCache.mock.invocationCallOrder[0]).toBeLessThan(
      mockSignOut.mock.invocationCallOrder[0]!
    );
  });

  it('redirects to home after clearing cache', async () => {
    const { signOut } = await import('../../../src/lib/auth');

    await signOut();

    expect(window.location.href).toBe('/');
  });

  it('clears cache even when the sign-out request fails', async () => {
    mockSignOut.mockRejectedValueOnce(new Error('network'));
    const { signOut } = await import('../../../src/lib/auth');

    await expect(signOut()).rejects.toThrow('network');

    expect(mockClearLibraryCache).toHaveBeenCalledOnce();
    expect(mockClearLegacyLibraryCache).toHaveBeenCalledOnce();
  });

  it('revokes an active origin-level push endpoint before ending the account session', async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: {
            getSubscription: vi.fn().mockResolvedValue({
              endpoint: 'https://push.example.test/account-a',
              unsubscribe,
            }),
          },
        }),
      },
    });
    const { signOut } = await import('../../../src/lib/auth');

    await signOut();

    expect(mockUnsubscribeWebPush).toHaveBeenCalledWith('https://push.example.test/account-a');
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(mockUnsubscribeWebPush.mock.invocationCallOrder[0]).toBeLessThan(
      mockSignOut.mock.invocationCallOrder[0]!
    );
  });

  it('sweeps the persisted query cache before the sign-out request', async () => {
    // Nothing previously proved signOut() actually calls this — the sweep function
    // was unit-tested in isolation, so deleting the call site would have been
    // invisible. That is precisely the regression this whole feature guards against.
    const { signOut } = await import('../../../src/lib/auth');

    await signOut();

    expect(mockRemoveAllPersistedQueryCaches).toHaveBeenCalledOnce();
    expect(mockRemoveAllPersistedQueryCaches.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSignOut.mock.invocationCallOrder[0]!
    );
  });

  it('sweeps the persisted query cache even when the sign-out request fails', async () => {
    mockSignOut.mockRejectedValueOnce(new Error('network down'));
    const { signOut } = await import('../../../src/lib/auth');

    await expect(signOut()).rejects.toThrow('network down');

    expect(mockRemoveAllPersistedQueryCaches).toHaveBeenCalledOnce();
  });

  it('completes sign-out even when the persisted-cache sweep rejects', async () => {
    // The sweep is best-effort: a storage failure must not block sign-out.
    mockRemoveAllPersistedQueryCaches.mockRejectedValueOnce(new Error('IndexedDB gone'));
    const { signOut } = await import('../../../src/lib/auth');

    await signOut();

    expect(mockSignOut).toHaveBeenCalledOnce();
  });
});
