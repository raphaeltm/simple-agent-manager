/**
 * Default for the `performance.userAccessTokenLockTimeoutMs` admin setting: how long one
 * GitHub or GitLab user-token lookup may hold its per-user lock in {@link UserAccessTokenLock}.
 *
 * Kept in its own module so the admin setting registry can import it without importing the
 * Durable Object (which imports the registry's resolver).
 *
 * A lookup is a few D1 reads plus at most one OAuth refresh round trip, normally well under
 * 2 s. 20 s leaves a wide margin above that and stays far below "forever", which is what an
 * unbounded lock turns one hung lookup into for every later lookup by the same user.
 */
export const DEFAULT_USER_ACCESS_TOKEN_LOCK_TIMEOUT_MS = 20_000;
