/**
 * Access tokens for SAM-hosted repositories.
 *
 * A token is `samgit1.<payload>.<signature>`: a base64url JSON payload naming one repository,
 * one scope and an expiry, signed with HMAC-SHA256. git sends it as the HTTP Basic password
 * (any username). The key is derived from the Worker's ENCRYPTION_KEY with a fixed label, so it
 * is separate from every other use of that secret and needs no new secret or table.
 *
 * Tokens cannot be revoked individually; they are short-lived (TTL clamped to 1 s..24 h) and
 * the git route re-checks in D1, on every request, that the repository still belongs to a
 * project and that a workspace-bound token's workspace is still active.
 */
import type { Env } from '../../env';

export type HostedGitScope = 'read' | 'write';

export interface HostedGitTokenClaims {
  /** Repository name (projects.artifacts_repo_id). */
  repo: string;
  scope: HostedGitScope;
  /** Expiry, unix seconds. */
  exp: number;
  /** Workspace the token was minted for, when a workspace asked for it. */
  workspaceId?: string;
}

const TOKEN_PREFIX = 'samgit1';
const KEY_LABEL = 'sam-hosted-git-token/v1';
export const DEFAULT_HOSTED_GIT_TOKEN_TTL_SECONDS = 3600;
export const MAX_HOSTED_GIT_TOKEN_TTL_SECONDS = 86_400;
/** Repository names SAM generates (toArtifactsRepoName): lowercase, digits, dashes. */
const REPO_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function isHostedGitRepoName(name: string): boolean {
  return REPO_NAME_PATTERN.test(name);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded =
      value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

function signingKey(env: Pick<Env, 'ENCRYPTION_KEY'>): Promise<CryptoKey> {
  const secret = env.ENCRYPTION_KEY;
  if (!secret) throw new Error('ENCRYPTION_KEY is required for SAM-hosted repositories');
  if (cachedKey?.secret === secret) return cachedKey.key;
  const key = (async () => {
    const root = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const derived = await crypto.subtle.sign('HMAC', root, encoder.encode(KEY_LABEL));
    return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]);
  })();
  cachedKey = { secret, key };
  return key;
}

export function clampHostedGitTokenTtl(ttlSeconds: number | undefined): number {
  if (ttlSeconds === undefined || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return DEFAULT_HOSTED_GIT_TOKEN_TTL_SECONDS;
  }
  return Math.min(Math.floor(ttlSeconds), MAX_HOSTED_GIT_TOKEN_TTL_SECONDS) || 1;
}

export async function mintHostedGitToken(
  env: Pick<Env, 'ENCRYPTION_KEY'>,
  input: { repo: string; scope: HostedGitScope; ttlSeconds?: number; workspaceId?: string },
  now: number = Date.now()
): Promise<{ token: string; expiresAt: string }> {
  if (!isHostedGitRepoName(input.repo)) throw new Error('Invalid hosted repository name');
  const exp = Math.floor(now / 1000) + clampHostedGitTokenTtl(input.ttlSeconds);
  const claims: HostedGitTokenClaims = { repo: input.repo, scope: input.scope, exp };
  if (input.workspaceId) claims.workspaceId = input.workspaceId;
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const unsigned = `${TOKEN_PREFIX}.${payload}`;
  const signature = await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(unsigned));
  return {
    token: `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/** Verify signature, shape and expiry. Returns null for any token that is not valid now. */
export async function verifyHostedGitToken(
  env: Pick<Env, 'ENCRYPTION_KEY'>,
  token: string,
  now: number = Date.now()
): Promise<HostedGitTokenClaims | null> {
  if (token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  const [prefix, payload, signaturePart] = parts as [string, string, string];
  const signature = base64UrlDecode(signaturePart);
  const payloadBytes = base64UrlDecode(payload);
  if (!signature || !payloadBytes) return null;
  const valid = await crypto.subtle.verify(
    'HMAC',
    await signingKey(env),
    signature,
    encoder.encode(`${prefix}.${payload}`)
  );
  if (!valid) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const claims = parsed as Record<string, unknown>;
  if (typeof claims.repo !== 'string' || !isHostedGitRepoName(claims.repo)) return null;
  if (claims.scope !== 'read' && claims.scope !== 'write') return null;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
  if (claims.workspaceId !== undefined && typeof claims.workspaceId !== 'string') return null;
  return {
    repo: claims.repo,
    scope: claims.scope,
    exp: claims.exp,
    ...(typeof claims.workspaceId === 'string' ? { workspaceId: claims.workspaceId } : {}),
  };
}
