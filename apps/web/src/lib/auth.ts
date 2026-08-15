import { createAuthClient } from 'better-auth/react';

import { unsubscribeWebPush } from './api/notifications';
import { clearLegacyLibraryCache, clearLibraryCache } from './library-cache';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';

/**
 * BetterAuth React client instance.
 * Provides hooks and methods for authentication.
 */
export const authClient: ReturnType<typeof createAuthClient> = createAuthClient({
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
 * Sign in with Google OAuth.
 * Redirects to Google for authentication.
 */
export async function signInWithGoogle() {
  await authClient.signIn.social({
    provider: 'google',
    callbackURL: window.location.origin + '/dashboard',
  });
}

/**
 * Sign in with GitLab OAuth.
 * Redirects to the configured GitLab host for authentication.
 */
export async function signInWithGitLab() {
  await authClient.signIn.social({
    provider: 'gitlab',
    callbackURL: window.location.origin + '/dashboard',
  });
}

/**
 * Sign out the current user.
 * Clears session and redirects to home.
 */
export async function signOut() {
  await revokeBrowserPushSubscription();
  clearLibraryCache();
  clearLegacyLibraryCache();
  await authClient.signOut({
    fetchOptions: {
      onSuccess: () => {
        window.location.href = '/';
      },
    },
  });
}

/**
 * Remove the origin-level browser endpoint before the authenticated account
 * changes. Either server deletion or push-service unsubscribe is sufficient to
 * prevent the previous tenant's notifications from reaching the next user.
 */
export async function revokeBrowserPushSubscription(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  registration?.active?.postMessage({ type: 'push-subscription-revoked' });

  const [serverRemoval, browserRemoval] = await Promise.allSettled([
    unsubscribeWebPush(subscription.endpoint),
    subscription.unsubscribe(),
  ]);
  const removedFromServer = serverRemoval.status === 'fulfilled';
  const invalidatedAtBrowser =
    browserRemoval.status === 'fulfilled' && browserRemoval.value !== false;
  if (!removedFromServer && !invalidatedAtBrowser) {
    throw new Error('Could not safely revoke this browser push subscription before sign-out');
  }
}

/**
 * React hook to get current session.
 */
export const useSession: typeof authClient.useSession = authClient.useSession;
