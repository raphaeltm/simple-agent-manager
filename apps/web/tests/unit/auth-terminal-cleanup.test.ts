import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('signOut terminal cleanup integration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('calls cleanupTerminalSecrets and broadcastAuthRevocation before the auth sign-out request', async () => {
    const callOrder: string[] = [];
    const cleanupMock = vi.fn(() => callOrder.push('cleanup'));
    const broadcastMock = vi.fn(() => callOrder.push('broadcast'));

    vi.doMock('../../src/lib/terminal-cleanup', () => ({
      cleanupTerminalSecrets: cleanupMock,
      broadcastAuthRevocation: broadcastMock,
      resetAuthRevoked: vi.fn(),
      TERMINAL_SESSION_STORAGE_PREFIX: 'sam-terminal-sessions-',
    }));

    vi.doMock('better-auth/react', () => ({
      createAuthClient: () => ({
        signIn: { social: vi.fn() },
        signOut: vi.fn(async (opts: { fetchOptions?: { onSuccess?: () => void } }) => {
          callOrder.push('signOut');
          opts.fetchOptions?.onSuccess?.();
        }),
        useSession: vi.fn(() => ({ data: null, isPending: false, error: null })),
      }),
    }));

    vi.doMock('../../src/lib/api/notifications', () => ({
      unsubscribeWebPush: vi.fn(),
    }));

    vi.doMock('../../src/lib/library-cache', () => ({
      clearLibraryCache: vi.fn(),
      clearLegacyLibraryCache: vi.fn(),
      buildLibraryCacheNamespace: vi.fn(),
    }));

    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          getRegistration: vi.fn().mockResolvedValue(undefined),
        },
      },
      writable: true,
      configurable: true,
    });

    const { signOut } = await import('../../src/lib/auth');

    const locationSpy = vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      href: '/',
    } as Location);

    await signOut();

    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['cleanup', 'broadcast', 'signOut']);

    locationSpy.mockRestore();
  });

  it('resets authRevoked if sign-out throws (rollback)', async () => {
    const resetMock = vi.fn();

    vi.doMock('../../src/lib/terminal-cleanup', () => ({
      cleanupTerminalSecrets: vi.fn(),
      broadcastAuthRevocation: vi.fn(),
      resetAuthRevoked: resetMock,
      TERMINAL_SESSION_STORAGE_PREFIX: 'sam-terminal-sessions-',
    }));

    vi.doMock('better-auth/react', () => ({
      createAuthClient: () => ({
        signIn: { social: vi.fn() },
        signOut: vi.fn(async () => {
          throw new Error('network error');
        }),
        useSession: vi.fn(() => ({ data: null, isPending: false, error: null })),
      }),
    }));

    vi.doMock('../../src/lib/api/notifications', () => ({
      unsubscribeWebPush: vi.fn(),
    }));

    vi.doMock('../../src/lib/library-cache', () => ({
      clearLibraryCache: vi.fn(),
      clearLegacyLibraryCache: vi.fn(),
      buildLibraryCacheNamespace: vi.fn(),
    }));

    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          getRegistration: vi.fn().mockResolvedValue(undefined),
        },
      },
      writable: true,
      configurable: true,
    });

    const { signOut } = await import('../../src/lib/auth');
    const locationSpy = vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      href: '/',
    } as Location);

    await expect(signOut()).rejects.toThrow('network error');
    expect(resetMock).toHaveBeenCalledTimes(1);

    locationSpy.mockRestore();
  });
});
