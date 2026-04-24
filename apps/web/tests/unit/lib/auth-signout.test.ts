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
vi.mock('../../../src/lib/library-cache', () => ({
  clearLibraryCache: mockClearLibraryCache,
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

  it('calls clearLibraryCache on successful sign-out', async () => {
    const { signOut } = await import('../../../src/lib/auth');

    await signOut();

    expect(mockSignOut).toHaveBeenCalledOnce();
    expect(mockClearLibraryCache).toHaveBeenCalledOnce();
  });

  it('redirects to home after clearing cache', async () => {
    const { signOut } = await import('../../../src/lib/auth');

    await signOut();

    expect(window.location.href).toBe('/');
  });
});
