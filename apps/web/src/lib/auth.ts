import { createAuthClient } from 'better-auth/react';

import { unsubscribeWebPush } from './api/notifications';
import { clearLegacyLibraryCache, clearLibraryCache } from './library-cache';
import {
  broadcastAuthRevocation,
  cleanupTerminalSecrets,
  resetAuthRevoked,
} from './terminal-cleanup';

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

/** A sign-in provider an existing account can connect ("Connect GitHub"). */
export type LinkableProvider = 'github' | 'gitlab';

/**
 * Connect a provider to the signed-in account through BetterAuth's own `/link-social` flow:
 * the provider's consent screen, then back to `returnTo`. The API allows the provider account's
 * email to differ from the SAM one only on this explicit, signed-in path.
 */
export async function connectProvider(
  provider: LinkableProvider,
  returnTo: string = window.location.href
): Promise<void> {
  // Errors come back to the same page too, not to the API's bare error page.
  const { error } = await authClient.linkSocial({
    provider,
    callbackURL: returnTo,
    errorCallbackURL: returnTo,
  });
  if (error) throw new Error(error.message || `Could not connect ${provider}`);
}

/** The providers already connected to the signed-in account (BetterAuth `/list-accounts`). */
export async function listConnectedProviders(): Promise<string[]> {
  const { data, error } = await authClient.listAccounts();
  if (error) throw new Error(error.message || 'Could not list connected accounts');
  return (data ?? []).map((account) => account.providerId);
}

/**
 * Email a sign-in code. The API answers the same whether or not the address can sign in,
 * so the caller always moves on to the code step.
 */
export async function sendSignInCode(email: string): Promise<void> {
  const { error } = await authClient.$fetch('/email-otp/send-verification-otp', {
    method: 'POST',
    body: { email, type: 'sign-in' },
  });
  if (error) throw new Error(error.message || 'Could not send a sign-in code');
}

/** Sign in with an emailed code; creates the session cookie on success. */
export async function signInWithEmailCode(email: string, code: string): Promise<void> {
  const { error } = await authClient.$fetch('/sign-in/email-otp', {
    method: 'POST',
    body: { email, otp: code },
  });
  if (error) throw new Error(error.message || 'That code did not work');
}

/**
 * Sign out the current user.
 * Clears session and redirects to home.
 */
export async function signOut() {
  cleanupTerminalSecrets();
  broadcastAuthRevocation();
  try {
    await revokeBrowserPushSubscription();
  } catch {
    // best-effort — don't block signout
  }
  clearLibraryCache();
  clearLegacyLibraryCache();
  // Best-effort, internally bounded sweep of the persisted query cache. Awaited so
  // it normally completes before the redirect, and it runs even when the signOut
  // request below fails — the case the archived cross-user cache incident cared
  // about. It is NOT a hard guarantee: the sweep races an internal timeout so
  // sign-out can never hang behind IndexedDB. That is safe because a surviving
  // record is keyed to this same user and gated by the scope-checked allowlist, so
  // it can never be read by the next account.
  // Imported dynamically to keep idb-keyval out of the eager bundle.
  await import('./query-persistence')
    .then((m) => m.removeAllPersistedQueryCaches())
    .catch(() => undefined);
  try {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          window.location.href = '/';
        },
      },
    });
  } catch (err) {
    resetAuthRevoked();
    throw err;
  }
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
