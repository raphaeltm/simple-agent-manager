/**
 * Better Auth provider access-token lookup for repo hosting. Kept in the worker because it
 * constructs Better Auth; `@simple-agent-manager/repo-hosting` reaches it through its auth port
 * (`repo-hosting-wiring.ts`).
 */
import { createAuth } from '../auth';
import type { Env } from '../env';
import { getBetterAuthAccountIdForProvider, type GitLabAccountScope } from './better-auth-account';
import { gitlabAccountScope } from './gitlab-sign-in-identity';

type OAuthProviderId = 'github' | 'gitlab';

export async function getBetterAuthAccessTokenForProvider(
  env: Env,
  headers: Headers | undefined,
  userId: string,
  providerId: OAuthProviderId
) {
  let gitlabScope: GitLabAccountScope | undefined;
  if (providerId === 'gitlab') {
    // Only a row the configured host issued: another host's token must not reach this one.
    // Loaded here, not at module scope: the GitHub path never needs the platform-config graph.
    const { getGitLabOAuthConfig } = await import('./platform-config-oauth');
    const config = await getGitLabOAuthConfig(env);
    if (!config) return null;
    gitlabScope = gitlabAccountScope(config);
  }
  const accountId = await getBetterAuthAccountIdForProvider(env, userId, providerId, gitlabScope);
  if (!accountId) {
    return null;
  }

  const auth = await createAuth(env);
  return auth.api.getAccessToken({
    ...(headers ? { headers } : {}),
    body: { accountId, userId },
  });
}
