import { UserAccessTokenLock } from './user-access-token-lock';

/**
 * Per-user mutex around BetterAuth GitLab access-token lookup/refresh.
 *
 * GitLab refresh tokens are single-use and rotating, so a concurrent replay of
 * a consumed refresh token revokes the entire token family upstream. The
 * shared lock in `UserAccessTokenLock` serializes the whole
 * read → refresh → persist cycle per user.
 *
 * Refresh-aware rate limiting is tracked in
 * tasks/backlog/2026-07-12-gitlab-token-lock-rate-limit.md — most calls are
 * cached reads for git credential fetches, so a naive per-call limit would
 * throttle legitimate git operations.
 */
export class GitLabUserAccessTokenLock extends UserAccessTokenLock {
  protected readonly providerId = 'gitlab';
}
