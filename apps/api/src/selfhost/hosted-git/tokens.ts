/**
 * Access tokens for SAM-hosted repositories.
 *
 * A token is `samgit1.<payload>.<signature>`: a base64url JSON payload naming one repository,
 * one scope, an expiry and who it acts for (a user, and for workspaces the workspace and its
 * callback generation), signed with HMAC-SHA256. git sends it as the HTTP Basic password (any
 * username). The key is derived from the Worker's ENCRYPTION_KEY with HKDF under a fixed label, so
 * it is separate from every other use of that secret and needs no new secret or table.
 *
 * Tokens cannot be revoked individually; they are short-lived (TTL clamped to 1 s..24 h) and
 * the git route re-checks in D1, on every request, that the repository still belongs to a
 * project, that the user is still an active member, and that a workspace-bound token's workspace
 * is still active on its current runtime (callback generation).
 */
import { mintSignedToken, type SignedTokenPurpose, verifySignedToken } from '../signed-token';
import type { HostedGitEnv as Env } from './env';

export type HostedGitScope = 'read' | 'write';

export interface HostedGitTokenClaims {
  /** Repository name (projects.artifacts_repo_id). */
  repo: string;
  scope: HostedGitScope;
  /** Expiry, unix seconds. */
  exp: number;
  /** Workspace the token was minted for, when a workspace asked for it. */
  workspaceId?: string;
  /**
   * The workspace's callback credential generation at mint time (`workspaces.callback_generation`,
   * null when unset). A restart or wake rotates it, retiring tokens of the previous runtime.
   */
  callbackGeneration?: string | null;
  /** The person the token acts for: a member, or the owner of the workspace. */
  userId?: string;
}

const TOKEN_PREFIX = 'samgit1';
const KEY_LABEL = 'sam-hosted-git-token/v1';
export const DEFAULT_HOSTED_GIT_TOKEN_TTL_SECONDS = 3600;
export const MAX_HOSTED_GIT_TOKEN_TTL_SECONDS = 86_400;
/** Repository names SAM generates (toArtifactsRepoName): lowercase, digits, dashes. */
const REPO_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

const PURPOSE: SignedTokenPurpose = { prefix: TOKEN_PREFIX, label: KEY_LABEL };

export function isHostedGitRepoName(name: string): boolean {
  return REPO_NAME_PATTERN.test(name);
}

export function clampHostedGitTokenTtl(ttlSeconds: number | undefined): number {
  if (ttlSeconds === undefined || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return DEFAULT_HOSTED_GIT_TOKEN_TTL_SECONDS;
  }
  return Math.min(Math.floor(ttlSeconds), MAX_HOSTED_GIT_TOKEN_TTL_SECONDS) || 1;
}

export async function mintHostedGitToken(
  env: Pick<Env, 'ENCRYPTION_KEY'>,
  input: {
    repo: string;
    scope: HostedGitScope;
    ttlSeconds?: number;
    workspaceId?: string;
    callbackGeneration?: string | null;
    userId?: string;
  },
  now: number = Date.now()
): Promise<{ token: string; expiresAt: string }> {
  if (!isHostedGitRepoName(input.repo)) throw new Error('Invalid hosted repository name');
  const exp = Math.floor(now / 1000) + clampHostedGitTokenTtl(input.ttlSeconds);
  const claims: HostedGitTokenClaims = { repo: input.repo, scope: input.scope, exp };
  if (input.workspaceId) {
    claims.workspaceId = input.workspaceId;
    claims.callbackGeneration = input.callbackGeneration ?? null;
  }
  if (input.userId) claims.userId = input.userId;
  return {
    token: await mintSignedToken(env, PURPOSE, claims),
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/** Verify signature, shape and expiry. Returns null for any token that is not valid now. */
export async function verifyHostedGitToken(
  env: Pick<Env, 'ENCRYPTION_KEY'>,
  token: string,
  now: number = Date.now()
): Promise<HostedGitTokenClaims | null> {
  const claims = await verifySignedToken(env, PURPOSE, token);
  if (!claims) return null;
  if (typeof claims.repo !== 'string' || !isHostedGitRepoName(claims.repo)) return null;
  if (claims.scope !== 'read' && claims.scope !== 'write') return null;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
  if (claims.workspaceId !== undefined && typeof claims.workspaceId !== 'string') return null;
  if (claims.userId !== undefined && typeof claims.userId !== 'string') return null;
  const generation = claims.callbackGeneration;
  if (generation !== undefined && generation !== null && typeof generation !== 'string')
    return null;
  return {
    repo: claims.repo,
    scope: claims.scope,
    exp: claims.exp,
    ...(typeof claims.workspaceId === 'string'
      ? { workspaceId: claims.workspaceId, callbackGeneration: generation ?? null }
      : {}),
    ...(typeof claims.userId === 'string' ? { userId: claims.userId } : {}),
  };
}
