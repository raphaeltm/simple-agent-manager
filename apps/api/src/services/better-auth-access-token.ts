/**
 * Better Auth provider access-token lookup for repo hosting. Kept in the worker because it
 * constructs Better Auth; `@simple-agent-manager/repo-hosting` reaches it through its auth port
 * (`repo-hosting-wiring.ts`).
 */
import { createAuth } from '../auth';
import type { Env } from '../env';
import { getBetterAuthAccountIdForProvider } from './better-auth-account';

type OAuthProviderId = 'github' | 'gitlab';

export async function getBetterAuthAccessTokenForProvider(
  env: Env,
  headers: Headers | undefined,
  userId: string,
  providerId: OAuthProviderId
) {
  const accountId = await getBetterAuthAccountIdForProvider(env, userId, providerId);
  if (!accountId) {
    return null;
  }

  const auth = await createAuth(env);
  return auth.api.getAccessToken({
    ...(headers ? { headers } : {}),
    body: { accountId, userId },
  });
}
