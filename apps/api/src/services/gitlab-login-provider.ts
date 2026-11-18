/** GitLab profile requests use the shared outbound guard; OAuth exchange/refresh use
 * BetterAuth's fetchRefusingRedirects (manual, any redirect refused). Refusing the
 * provider before registration also protects those library-owned token requests.
 */
import {
  assertOutboundUrl,
  getTimeoutMs,
  guardedFetch,
  readResponseJson,
  withDeadline,
} from '@simple-agent-manager/worker-core';
import type { GitlabOptions, GitlabProfile } from 'better-auth/social-providers';
import * as v from 'valibot';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { untrustedGitLabAccountSubject } from './gitlab-sign-in-identity';
import { keepLinkedAccountEmail } from './linked-account-identity';
import { resolveOutboundMaxRedirects } from './outbound-fetch-settings';
import type { GitLabOAuthConfig } from './platform-config-oauth';

const DEFAULT_GITLAB_API_TIMEOUT_MS = 30_000;
const gitlabUserSchema = v.object({
  id: v.union([v.number(), v.string()]),
  username: v.optional(v.nullable(v.string())),
  name: v.optional(v.nullable(v.string())),
  email: v.optional(v.nullable(v.string())),
  avatar_url: v.optional(v.nullable(v.string())),
  email_verified: v.optional(v.boolean()),
  state: v.optional(v.nullable(v.string())),
  locked: v.optional(v.nullable(v.boolean())),
});

export function gitLabLoginProvider(env: Env, config: GitLabOAuthConfig): GitlabOptions | null {
  try {
    // A private host needs the admin opt-in `integration.gitlab.allowPrivateNetwork`.
    assertOutboundUrl(config.host, { allowPrivateNetwork: config.allowPrivateNetwork });
  } catch {
    log.warn('gitlab_login_disabled_host_refused');
    return null;
  }
  return {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    issuer: config.host,
    scope: ['read_user', 'api', 'read_repository', 'write_repository'],
    disableDefaultScope: true,
    overrideUserInfoOnSignIn: config.identityTrusted,
    getUserInfo: async (token) => {
      if (!token.accessToken) return null;
      try {
        const maxRedirects = await resolveOutboundMaxRedirects(env);
        return await withDeadline(
          async (signal) => {
            const response = await guardedFetch(
              `${config.host}/api/v4/user`,
              {
                headers: { authorization: `Bearer ${token.accessToken}` },
                signal,
              },
              { maxRedirects, allowPrivateNetwork: config.allowPrivateNetwork }
            );
            if (!response.ok) return null;
            const profile = await readResponseJson(response, gitlabUserSchema, 'gitlab.user');
            if (profile.state !== 'active' || profile.locked || !profile.email) return null;
            const accountId = config.identityTrusted ? String(profile.id) : untrustedGitLabAccountSubject(config.host, profile.id);
            const identity = await keepLinkedAccountEmail(env, 'gitlab', accountId, { email: profile.email, emailVerified: config.identityTrusted && (profile.email_verified ?? false) });
            return {
              user: {
                name: profile.name ?? profile.username ?? '',
                email: identity.email ?? profile.email,
                image: profile.avatar_url ?? undefined,
                emailVerified: identity.emailVerified,
              },
              // BetterAuth reads data.id as the account key. Untrusted hosts retain
              // their host-scoped string key; GitlabProfile only types numeric ids.
              data: {
                ...profile,
                id: config.identityTrusted
                  ? profile.id
                  : untrustedGitLabAccountSubject(config.host, profile.id),
              } as unknown as GitlabProfile,
            };
          },
          getTimeoutMs(env.GITLAB_API_TIMEOUT_MS, DEFAULT_GITLAB_API_TIMEOUT_MS)
        );
      } catch {
        log.warn('gitlab_sign_in.user_fetch_refused');
        return null;
      }
    },
  };
}
