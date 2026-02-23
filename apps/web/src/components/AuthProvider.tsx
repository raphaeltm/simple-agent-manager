import { createContext, useContext, ReactNode } from 'react';
import { useSession } from '../lib/auth';
import type { UserRole, UserStatus } from '@simple-agent-manager/shared';

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
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  isSuperadmin: false,
  isApproved: false,
});

interface AuthProviderProps {
  children: ReactNode;
}

/**
 * Auth provider component that wraps the app and provides auth state.
 */
export function AuthProvider({ children }: AuthProviderProps) {
  const { data: session, isPending } = useSession();

  const user = session?.user ?? null;
  const sessionUser = user as (Record<string, unknown> & NonNullable<typeof user>) | null;
  const role = (sessionUser?.role as UserRole) ?? 'user';
  const status = (sessionUser?.status as UserStatus) ?? 'active';

  const enrichedUser: User | null = user
    ? { ...user, role, status }
    : null;

  const value: AuthContextValue = {
    user: enrichedUser,
    isLoading: isPending,
    isAuthenticated: !!user,
    isSuperadmin: role === 'superadmin',
    isApproved: status === 'active' || role === 'superadmin' || role === 'admin',
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
