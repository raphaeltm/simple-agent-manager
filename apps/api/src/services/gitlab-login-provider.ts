/**
 * The better-auth GitLab sign-in provider, built from the admin's GitLab settings.
 *
 * Outbound requests, and who controls them (better-auth 1.7.14, @better-auth/core dist):
 * - authorization redirect: the browser goes there; the Worker fetches nothing.
 * - code exchange (`validateAuthorizationCode`) and token refresh (`refreshAccessToken`, reached
 *   through `getAccessToken` from the repo-hosting package's gitlab.ts): better-auth's
 *   `fetchRefusingRedirects` (`oauth2/reject-redirects.mjs`), `redirect: 'manual'`, any 3xx is
 *   an error. They carry the client secret and refresh token, and go only to
 *   `<issuer>/oauth/token`. The provider has no
 *   fetch hook for these, so SAM guards them by refusing to register the provider at all for a
 *   host it may not call (`assertGitLabHostAllowed`); DNS answers are the egress fence's job.
 * - profile (`getUserInfo`): better-auth's default follows redirects with the access token, so
 *   SAM replaces it with a guarded fetch (every hop re-checked, cross-origin hops lose the token).
 */
import {
  DEFAULT_GITLAB_API_TIMEOUT_MS,
  gitLabHostVerdict,
} from '@simple-agent-manager/repo-hosting';
import type { GitlabOptions, GitlabProfile } from 'better-auth/social-providers';
import * as v from 'valibot';

import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import { guardedFetch } from '../lib/network-hosts';
import { readResponseJson } from '../lib/runtime-validation';
import { getTimeoutMs } from './fetch-timeout';
import { keepLinkedAccountEmail } from './linked-account-identity';
import { resolveOutboundMaxRedirects } from './outbound-fetch-settings';
import type { GitLabOAuthConfig } from './platform-config-oauth';

const log = createModuleLogger('gitlab-login');

const GITLAB_SCOPES = ['read_user', 'api', 'read_repository', 'write_repository'];

const gitlabUserSchema = v.object({
  id: v.number(),
  username: v.string(),
  name: v.optional(v.nullable(v.string())),
  email: v.optional(v.nullable(v.string())),
  state: v.string(),
  locked: v.optional(v.nullable(v.boolean())),
  avatar_url: v.optional(v.nullable(v.string())),
  email_verified: v.optional(v.nullable(v.boolean())),
});

type GitLabProvider = GitlabOptions;
type GitLabUserInfo = Awaited<ReturnType<NonNullable<GitLabProvider['getUserInfo']>>>;

/** The signed-in GitLab user, fetched through the guarded fetch. Mirrors better-auth's default. */
export async function fetchGitLabUserInfo(
  env: Env,
  config: GitLabOAuthConfig,
  accessToken: string | undefined
): Promise<GitLabUserInfo> {
  if (!accessToken) return null;
  let response: Response;
  try {
    response = await guardedFetch(
      `${config.host}/api/v4/user`,
      { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } },
      {
        allowPrivateNetwork: config.allowPrivateNetwork,
        maxRedirects: await resolveOutboundMaxRedirects(env),
        deadlineMs: getTimeoutMs(env.GITLAB_API_TIMEOUT_MS, DEFAULT_GITLAB_API_TIMEOUT_MS),
      }
    );
  } catch (err) {
    log.warn('gitlab_user_fetch_refused', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!response.ok) {
    log.warn('gitlab_user_fetch_failed', { status: response.status });
    return null;
  }
  const profile = await readResponseJson(response, gitlabUserSchema, 'gitlab.user');
  if (profile.state !== 'active' || profile.locked) return null;
  // A linked account keeps its own verified SAM email (`keepLinkedAccountEmail`).
  const identity = await keepLinkedAccountEmail(env, 'gitlab', String(profile.id), {
    email: profile.email,
    emailVerified: profile.email_verified ?? false,
  });
  return {
    user: {
      name: profile.name ?? profile.username ?? '',
      email: identity.email ?? undefined,
      image: profile.avatar_url ?? undefined,
      emailVerified: identity.emailVerified,
    },
    // better-auth keys the account on `data.id` (`accountSubject: ({ profile }) => profile.id`).
    // Only the fields gitlabUserSchema validates exist; nothing in SAM reads the others.
    data: profile as GitlabProfile,
  };
}

/** The GitLab provider, or null when the admin's host may not be called (logged). */
export function gitLabLoginProvider(env: Env, config: GitLabOAuthConfig): GitLabProvider | null {
  const verdict = gitLabHostVerdict(config.host, config.allowPrivateNetwork);
  if (verdict !== 'allowed') {
    log.warn('gitlab_login_disabled_host_refused', { verdict });
    return null;
  }
  return {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    issuer: config.host,
    scope: GITLAB_SCOPES,
    overrideUserInfoOnSignIn: true,
    getUserInfo: (token) => fetchGitLabUserInfo(env, config, token.accessToken),
  };
}
