import { UserAccessTokenLock } from './user-access-token-lock';

/**
 * Per-user mutex around BetterAuth GitHub access-token lookup/refresh.
 *
 * GitHub refresh tokens are single-use, so SAM must serialize the whole
 * read → refresh → persist cycle per user. See `UserAccessTokenLock` for the
 * shared lock implementation.
 */
export class GitHubUserAccessTokenLock extends UserAccessTokenLock {
  protected readonly providerId = 'github';
}
