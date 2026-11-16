import type { GitLabAccountScope } from './better-auth-account';
import type { GitLabOAuthConfig } from './platform-config-oauth';

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

