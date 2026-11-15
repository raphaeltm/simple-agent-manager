import type { GitlabOptions, GitlabProfile } from 'better-auth/social-providers';
import * as v from 'valibot';

import { log } from '../lib/logger';
import { readResponseJson } from '../lib/runtime-validation';
import type { GitLabAccountScope } from './better-auth-account';
import type { GitLabOAuthConfig } from './platform-config-oauth';

type GitLabUserInfo = NonNullable<GitlabOptions['getUserInfo']>;

const gitlabUserSchema = v.object({
  id: v.union([v.number(), v.string()]),
  username: v.optional(v.nullable(v.string())),
  name: v.optional(v.nullable(v.string())),
  email: v.optional(v.nullable(v.string())),
  avatar_url: v.optional(v.nullable(v.string())),
  state: v.optional(v.nullable(v.string())),
  locked: v.optional(v.nullable(v.boolean())),
});

/**
 * The account key an untrusted GitLab host's user is stored under. GitLab user ids are small
 * public integers and better-auth keys an account on provider id + account id alone, so a raw id
 * from a host SAM does not trust could sign in as whichever user already holds that id from
 * gitlab.com (or squat an id a real gitlab.com user signs in with later). Prefixing the host
 * keeps every untrusted host's ids in their own namespace.
 */
export function untrustedGitLabAccountSubject(host: string, gitlabUserId: string | number): string {
  return `${host}/users/${String(gitlabUserId)}`;
}

/** The account rows the configured GitLab host issued, for token lookups (`GitLabAccountScope`). */
export function gitlabAccountScope(
  config: Pick<GitLabOAuthConfig, 'host' | 'identityTrusted'>
): GitLabAccountScope {
  return config.identityTrusted
    ? { kind: 'raw' }
    : { kind: 'host', accountIdPrefix: untrustedGitLabAccountSubject(config.host, '') };
}

/**
 * `getUserInfo` for a GitLab host whose sign-ins SAM does not trust (a self-managed host saved at
 * runtime; see `GitLabOAuthConfig.identityTrusted`). It reads the same `/api/v4/user` profile as
 * better-auth's own GitLab provider, but stores the account under a host-scoped key and never
 * treats the host's email as verified, so the sign-in can neither take over an existing account
 * by id nor by email.
 */
export function untrustedGitLabUserInfo(host: string): GitLabUserInfo {
  return async (token) => {
    if (!token.accessToken) return null;
    try {
      const response = await fetch(`${host}/api/v4/user`, {
        headers: { authorization: `Bearer ${token.accessToken}` },
      });
      if (!response.ok) {
        log.warn('gitlab_sign_in.user_fetch_failed', { status: response.status });
        return null;
      }
      const profile = await readResponseJson(response, gitlabUserSchema, 'gitlab.user');
      if (profile.state !== 'active' || profile.locked || !profile.email) return null;
      return {
        user: {
          name: profile.name ?? profile.username ?? '',
          email: profile.email,
          image: profile.avatar_url ?? undefined,
          emailVerified: false,
        },
        // better-auth's GitLab provider keys the account on `data.id`
        // (`accountSubject: ({ profile }) => profile.id`) and passes `data` nowhere else SAM
        // configures. GitlabProfile types `id` as a number; the host-scoped key is a string,
        // which better-auth stringifies anyway (`resolveOAuthAccountKey`).
        data: {
          ...profile,
          id: untrustedGitLabAccountSubject(host, profile.id),
        } as unknown as GitlabProfile,
      };
    } catch (err) {
      log.warn('gitlab_sign_in.user_fetch_exception', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };
}
