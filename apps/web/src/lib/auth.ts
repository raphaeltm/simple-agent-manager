import { createAuthClient } from 'better-auth/react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';

/**
 * BetterAuth React client instance.
 * Provides hooks and methods for authentication.
 */
export const authClient = createAuthClient({
  baseURL: API_URL,
  basePath: '/api/auth',
});

/**
 * Sign in with GitHub OAuth.
 * Redirects to GitHub for authentication.
 */
export async function signInWithGitHub() {
  await authClient.signIn.social({
    provider: 'github',
    callbackURL: window.location.origin + '/dashboard',
  });
}

/**
 * Sign out the current user.
 * Clears session and redirects to home.
 */
export async function signOut() {
  await authClient.signOut({
    fetchOptions: {
      onSuccess: () => {
        window.location.href = '/';
      },
    },
  });
}

/**
 * React hook to get current session.
 */
export const useSession = authClient.useSession;

/**
 * Check if user is authenticated.
 */
export function useIsAuthenticated() {
  const { data: session, isPending } = useSession();
  return {
    isAuthenticated: !!session?.user,
    isPending,
    user: session?.user,
  };
}
