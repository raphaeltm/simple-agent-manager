import type { UserRole, UserStatus } from '@simple-agent-manager/shared';
import { createContext, type ReactNode,useContext, useEffect, useRef } from 'react';

import { setUserId } from '../lib/analytics';
import { useSession } from '../lib/auth';

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

  const enrichedUser: User | null = user
    ? { ...user, role, status }
    : null;

  // Sync authenticated userId to analytics tracker
  useEffect(() => {
    setUserId(enrichedUser?.id ?? null);
  }, [enrichedUser?.id]);

  const value: AuthContextValue = {
    user: enrichedUser,
    isLoading: isPending,
    isAuthenticated: !!user,
    isSuperadmin: role === 'superadmin',
    isApproved: status === 'active' || role === 'superadmin' || role === 'admin',
    isRefetching: isRefetching ?? false,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
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
