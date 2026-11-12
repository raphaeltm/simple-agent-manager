import type { AuthPort } from '@simple-agent-manager/repo-hosting';

import type { Env } from '../env';
import { getBetterAuthAccessTokenForProvider } from '../services/better-auth-access-token';

/**
 * Better Auth decrypts and refreshes the user's OAuth tokens; only the worker constructs it.
 * The package hands over its narrow env; the full worker env is what reached it.
 */
export const authPort: AuthPort = {
  getAccessToken: (env, headers, userId, providerId) =>
    getBetterAuthAccessTokenForProvider(env as Env, headers, userId, providerId),
};
