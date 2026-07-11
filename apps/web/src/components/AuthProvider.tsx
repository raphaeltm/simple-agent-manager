import type { UserRole, UserStatus } from '@simple-agent-manager/shared';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { setUserId } from '../lib/analytics';
import { GITHUB_REAUTH_REQUIRED_EVENT } from '../lib/api/client';
import { signOut, useSession } from '../lib/auth';

interface User {
  id: string;
  email: string;
  name: string | null;
  image?: string | null;
  role: UserRole;
  status: UserStatus;
}

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isSuperadmin: boolean;
  isApproved: boolean;
  /** True when BetterAuth is re-checking the session (e.g. after tab regains focus) */
  isRefetching: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: ReactNode;
}

/**
 * Auth provider component that wraps the app and provides auth state.
 *
 * Implements a "last known good session" pattern to prevent transient network
 * errors (common on mobile app resume) from appearing as logout. When a
 * session refetch fails but we previously had a valid session, we preserve
 * the cached session instead of showing the login page.
 *
 * NOTE: Cached session values (role, status) are for UI display only.
 * All authorization decisions are enforced server-side via requireAuth().
 */
export function AuthProvider({ children }: AuthProviderProps) {
  const { data: session, isPending, error, isRefetching } = useSession();
  const lastGoodSessionRef = useRef<typeof session>(null);
  const [githubReauthMessage, setGitHubReauthMessage] = useState<string | null>(null);

  // Cache every successful session
  if (session?.user) {
    lastGoodSessionRef.current = session;
  } else if (!error && !isPending) {
    // Clean null from server (intentional signout or expired session) — clear cache.
    // Only preserve the cache when there's an error (transient network failure).
    lastGoodSessionRef.current = null;
  }

  // Use cached session when a refetch error wipes the current one
  const effectiveSession =
    session?.user
      ? session
      : error && lastGoodSessionRef.current
        ? lastGoodSessionRef.current
        : session;

  const user = effectiveSession?.user ?? null;
  const sessionUser = user as (Record<string, unknown> & NonNullable<typeof user>) | null;
  const role = (sessionUser?.role as UserRole) ?? 'user';
  const status = (sessionUser?.status as UserStatus) ?? 'active';

  const enrichedUser: User | null = useMemo(
    () => (user ? { ...user, role, status } : null),
    [user, role, status]
  );

  // Sync authenticated userId to analytics tracker
  useEffect(() => {
    setUserId(enrichedUser?.id ?? null);
  }, [enrichedUser?.id]);

  useEffect(() => {
    const onGitHubReauthRequired = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail as { message?: unknown } : null;
      setGitHubReauthMessage(
        typeof detail?.message === 'string' && detail.message.length > 0
          ? detail.message
          : 'Your GitHub authorization has expired — please sign out and back in'
      );
    };

    window.addEventListener(GITHUB_REAUTH_REQUIRED_EVENT, onGitHubReauthRequired);
    return () => window.removeEventListener(GITHUB_REAUTH_REQUIRED_EVENT, onGitHubReauthRequired);
  }, []);

  const handleGitHubReauth = async () => {
    await signOut();
  };

  const isAuthenticated = !!user;
  const isSuperadmin = role === 'superadmin';
  const isApproved = status === 'active' || role === 'superadmin' || role === 'admin';
  const effectiveIsRefetching = isRefetching ?? false;

  const value: AuthContextValue = useMemo(
    () => ({
      user: enrichedUser,
      isLoading: isPending,
      isAuthenticated,
      isSuperadmin,
      isApproved,
      isRefetching: effectiveIsRefetching,
    }),
    [enrichedUser, isPending, isAuthenticated, isSuperadmin, isApproved, effectiveIsRefetching]
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      {githubReauthMessage && (
        <div className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-md rounded-lg border border-border bg-surface-elevated p-4 shadow-lg" role="alert">
          <p className="text-sm font-medium text-fg-primary">GitHub sign-in required</p>
          <p className="mt-1 text-sm text-fg-secondary">{githubReauthMessage}</p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              className="rounded-md border border-border px-3 py-2 text-sm text-fg-secondary hover:bg-surface-hover"
              onClick={() => setGitHubReauthMessage(null)}
            >
              Dismiss
            </button>
            <button
              type="button"
              className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-fg-on-accent hover:opacity-90"
              onClick={() => void handleGitHubReauth()}
            >
              Sign out and reconnect
            </button>
          </div>
        </div>
      )}
    </AuthContext.Provider>
  );
}

/**
 * Hook to access auth context.
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
