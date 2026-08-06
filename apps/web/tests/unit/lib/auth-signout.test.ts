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
vi.mock('../../../src/lib/library-cache', () => ({
  clearLibraryCache: mockClearLibraryCache,
  clearLegacyLibraryCache: mockClearLegacyLibraryCache,
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
      mockSignOut.mock.invocationCallOrder[0]!,
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
});
