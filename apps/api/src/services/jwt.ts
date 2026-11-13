import {
  DEFAULT_GCP_IDENTITY_TOKEN_EXPIRY_SECONDS,
  DEFAULT_TERMINAL_TOKEN_EXPIRY_MS,
} from '@simple-agent-manager/shared';
import { decodeJwt, importPKCS8, SignJWT } from 'jose';

import type { Env } from '../env';
import {
  CALLBACK_TOKEN_CREDENTIAL_GENERATION_CLAIM,
  CALLBACK_TOKEN_GENERATION_ISSUED_AT_CLAIM,
} from './callback-token-claims';
import { loadCallbackCredentialGeneration } from './callback-token-generation';
import {
  CALLBACK_AUDIENCE,
  currentJwtKeyId,
  getIssuer,
  LOCAL_FORWARD_AUDIENCE,
  NODE_MANAGEMENT_AUDIENCE,
  PORT_ACCESS_AUDIENCE,
  TERMINAL_AUDIENCE,
} from './jwt-keys';
import type { LocalForwardTokenPayload } from './jwt-verify';

// Verification and the JWKS document live in jwt-verify.ts; re-exported so importers keep using
// this module.
export type {
  CallbackTokenPayload,
  CallbackTokenScope,
  LocalForwardTokenPayload,
  PortAccessTokenPayload,
  TerminalTokenPayload,
} from './jwt-verify';
export {
  getJWKS,
  verifyCallbackToken,
  verifyLocalForwardToken,
  verifyPortAccessToken,
  verifyTerminalToken,
} from './jwt-verify';

const IDENTITY_TOKEN_TYPE = 'identity';

/**
 * A token's expiry: `expiryMs` from now, but never later than `notAfter` when given. Session
 * routes pass an agent sign-in session's hard expiry (`credentialNotAfter`), so a token minted by
 * that session cannot outlive it.
 */
function cappedExpiry(expiryMs: number, notAfter?: Date): Date {
  const now = Date.now();
  // requireAuth already refuses a session past its cap; never mint an already-dead token.
  if (notAfter && notAfter.getTime() <= now) throw new Error('Session credential cap has passed');
  const expiresAt = now + expiryMs;
  return new Date(notAfter ? Math.min(expiresAt, notAfter.getTime()) : expiresAt);
}

/**
 * Get terminal token expiry in milliseconds.
 * Default: 1 hour.
 */
function getTerminalTokenExpiry(env: Env): number {
  const envValue = env.TERMINAL_TOKEN_EXPIRY_MS;
  return envValue ? parseInt(envValue, 10) : DEFAULT_TERMINAL_TOKEN_EXPIRY_MS;
}

/**
 * Get callback token expiry in milliseconds.
 * Default: 24 hours (86400000ms)
 */
function getCallbackTokenExpiry(env: Env): number {
  const envValue = env.CALLBACK_TOKEN_EXPIRY_MS;
  return envValue ? parseInt(envValue, 10) : 24 * 60 * 60 * 1000;
}

/**
 * Sign a terminal access token for a user and workspace.
 * Used by browser to authenticate WebSocket connections to VM Agent.
 */
export async function signTerminalToken(
  userId: string,
  workspaceId: string,
  env: Env,
  options: { sessionToken?: string | null; notAfter?: Date } = {}
): Promise<{ token: string; expiresAt: string }> {
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  const expiresAt = cappedExpiry(getTerminalTokenExpiry(env), options.notAfter);
  const issuer = getIssuer(env);

  const token = await new SignJWT({
    workspace: workspaceId,
    ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
    // The VM agent turns this token into its own session cookie (SESSION_TTL, 24 h by default)
    // and caps that session here (packages/vm-agent/internal/auth/session.go sessionExpiry), so a
    // capped control-plane session's terminal access ends with it even off the Worker path.
    ...(options.notAfter ? { sessionNotAfter: Math.floor(options.notAfter.getTime() / 1000) } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: currentJwtKeyId(env) })
    .setIssuer(issuer)
    .setSubject(userId)
    .setAudience(TERMINAL_AUDIENCE)
    .setExpirationTime(expiresAt)
    .setIssuedAt()
    .sign(privateKey);

  return {
    token,
    expiresAt: expiresAt.toISOString(),
  };
}

export interface SignCallbackTokenOptions {
  /** Generation issue time (seconds) to preserve when renewing an existing token. */
  generationIssuedAtSeconds?: number;
  /**
   * The row's current credential generation (`callback_generation`). Required, so every
   * signer states which runtime the token belongs to; null when the row was never rotated.
   */
  callbackGeneration: string | null;
}

export interface SignNodeCallbackTokenOptions {
  /** The node row's current credential generation; null when never rotated. */
  callbackGeneration: string | null;
}

function credentialGenerationClaim(generation: string | null): Record<string, string> {
  // `!generation`: never mint an empty claim, which the verifier rejects as malformed.
  return !generation ? {} : { [CALLBACK_TOKEN_CREDENTIAL_GENERATION_CLAIM]: generation };
}

/**
 * Sign a workspace-scoped callback token for VM-to-API authentication.
 * Used by VM agent to call back to control plane for workspace-specific operations
 * (agent-key, runtime-assets, boot-log, messages, ready, etc.)
 *
 * The `scope: 'workspace'` claim restricts this token to the specific workspace.
 * Node-scoped tokens cannot be used for workspace-scoped endpoints.
 */
export async function signCallbackToken(
  workspaceId: string,
  env: Env,
  options: SignCallbackTokenOptions
): Promise<string> {
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  const expiry = getCallbackTokenExpiry(env);
  const expiresAt = new Date(Date.now() + expiry);
  const issuer = getIssuer(env);
  const generationIssuedAt = options.generationIssuedAtSeconds;

  const token = await new SignJWT({
    workspace: workspaceId,
    type: 'callback',
    scope: 'workspace',
    ...(generationIssuedAt !== undefined
      ? { [CALLBACK_TOKEN_GENERATION_ISSUED_AT_CLAIM]: generationIssuedAt }
      : {}),
    ...credentialGenerationClaim(options.callbackGeneration),
  })
    .setProtectedHeader({ alg: 'RS256', kid: currentJwtKeyId(env) })
    .setIssuer(issuer)
    .setSubject(workspaceId)
    .setAudience(CALLBACK_AUDIENCE)
    .setExpirationTime(expiresAt)
    .setIssuedAt()
    .sign(privateKey);

  return token;
}

/**
 * Sign a node-scoped callback token for VM-to-API authentication.
 * Used by VM agent for node-level operations (heartbeat, ready, error reporting).
 *
 * The `scope: 'node'` claim restricts this token to node-level endpoints only.
 * Node-scoped tokens CANNOT be used for workspace-scoped endpoints (agent-key,
 * runtime-assets, etc.) to prevent cross-workspace secret access on multi-tenant nodes.
 */
export async function signNodeCallbackToken(
  nodeId: string,
  env: Env,
  options: SignNodeCallbackTokenOptions
): Promise<string> {
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  const expiry = getCallbackTokenExpiry(env);
  const expiresAt = new Date(Date.now() + expiry);
  const issuer = getIssuer(env);

  const token = await new SignJWT({
    workspace: nodeId,
    type: 'callback',
    scope: 'node',
    ...credentialGenerationClaim(options.callbackGeneration),
  })
    .setProtectedHeader({ alg: 'RS256', kid: currentJwtKeyId(env) })
    .setIssuer(issuer)
    .setSubject(nodeId)
    .setAudience(CALLBACK_AUDIENCE)
    .setExpirationTime(expiresAt)
    .setIssuedAt()
    .sign(privateKey);

  return token;
}

/**
 * Sign a workspace callback token for the workspace row's CURRENT credential generation
 * (one D1 read). For credentials handed to the runtime that is being created or dispatched
 * now. Paths that renew or deliver to an existing runtime must instead carry the generation
 * they verified or bound, so a retired runtime is never handed a current-generation token.
 */
export async function signCurrentWorkspaceCallbackToken(
  workspaceId: string,
  env: Env
): Promise<string> {
  const generation = await loadCallbackCredentialGeneration(env, 'workspace', workspaceId);
  return signCallbackToken(workspaceId, env, { callbackGeneration: generation ?? null });
}

/** Node counterpart of {@link signCurrentWorkspaceCallbackToken}. */
export async function signCurrentNodeCallbackToken(nodeId: string, env: Env): Promise<string> {
  const generation = await loadCallbackCredentialGeneration(env, 'node', nodeId);
  return signNodeCallbackToken(nodeId, env, { callbackGeneration: generation ?? null });
}

/**
 * Sign a management token for Control Plane -> Node Agent API calls.
 */
export async function signNodeManagementToken(
  userId: string,
  nodeId: string,
  workspaceId: string | null,
  env: Env,
  options: { notAfter?: Date } = {}
): Promise<{ token: string; expiresAt: string }> {
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  const expiresAt = cappedExpiry(getTerminalTokenExpiry(env), options.notAfter);
  const issuer = getIssuer(env);

  const token = await new SignJWT({
    type: 'node-management',
    node: nodeId,
    ...(workspaceId ? { workspace: workspaceId } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: currentJwtKeyId(env) })
    .setIssuer(issuer)
    .setSubject(userId)
    .setAudience(NODE_MANAGEMENT_AUDIENCE)
    .setExpirationTime(expiresAt)
    .setIssuedAt()
    .sign(privateKey);

  return {
    token,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Get port access token expiry in milliseconds.
 * Default: 15 minutes (900000ms) — short-lived URL token.
 */
function getPortAccessTokenExpiry(env: Env): number {
  const envValue = env.PORT_ACCESS_TOKEN_EXPIRY_MS;
  return envValue ? parseInt(envValue, 10) : 15 * 60 * 1000;
}

function getLocalForwardTokenExpiry(env: Env): number {
  const envValue = env.LOCAL_FORWARD_TOKEN_EXPIRY_MS;
  return envValue ? Number.parseInt(envValue, 10) : 5 * 60 * 1000;
}

/**
 * Sign a port access token for exposed port authentication.
 * Embedded in the expose_port URL; validated once, then exchanged for a cookie.
 *
 * Per-port scoping: token for port 3000 cannot access port 8080.
 */
export async function signPortAccessToken(
  userId: string,
  workspaceId: string,
  port: number,
  env: Env,
  options: { notAfter?: Date } = {}
): Promise<string> {
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  const expiresAt = cappedExpiry(getPortAccessTokenExpiry(env), options.notAfter);
  const issuer = getIssuer(env);

  const token = await new SignJWT({
    workspace: workspaceId,
    port,
  })
    .setProtectedHeader({ alg: 'RS256', kid: currentJwtKeyId(env) })
    .setIssuer(issuer)
    .setSubject(userId)
    .setAudience(PORT_ACCESS_AUDIENCE)
    .setExpirationTime(expiresAt)
    .setIssuedAt()
    .sign(privateKey);

  return token;
}

export async function signLocalForwardToken(
  claims: Omit<LocalForwardTokenPayload, 'subject'>,
  env: Env,
  options: { notAfter?: Date } = {}
): Promise<{ token: string; expiresAt: string }> {
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  const expiresAt = cappedExpiry(getLocalForwardTokenExpiry(env), options.notAfter);
  const issuer = getIssuer(env);

  const token = await new SignJWT({
    type: 'local-forward',
    userId: claims.userId,
    workspace: claims.workspaceId,
    node: claims.nodeId,
    remotePort: claims.remotePort,
    mode: claims.mode,
    localAuthority: claims.localAuthority,
  })
    .setProtectedHeader({ alg: 'RS256', kid: currentJwtKeyId(env) })
    .setIssuer(issuer)
    .setSubject(claims.userId)
    .setAudience(LOCAL_FORWARD_AUDIENCE)
    .setExpirationTime(expiresAt)
    .setIssuedAt()
    .sign(privateKey);

  return {
    token,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Check whether a callback token should be refreshed.
 * Returns true if the token is past the refresh threshold (default: 50% of lifetime).
 *
 * This enables automatic token renewal during heartbeats, preventing
 * nodes from going unhealthy after the initial token expires.
 */
export function shouldRefreshCallbackToken(token: string, env: Env): boolean {
  try {
    const claims = decodeJwt(token);
    if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') {
      return true; // Missing claims — refresh to be safe
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const totalLifetime = claims.exp - claims.iat;
    const elapsed = nowSeconds - claims.iat;

    const ratioStr = env.CALLBACK_TOKEN_REFRESH_THRESHOLD_RATIO;
    const ratio = ratioStr ? parseFloat(ratioStr) : 0.5;
    const threshold = Math.max(0.1, Math.min(0.9, Number.isFinite(ratio) ? ratio : 0.5));

    return elapsed >= totalLifetime * threshold;
  } catch {
    return true; // Can't decode — refresh to be safe
  }
}

/**
 * Get the identity token expiry in seconds.
 * Default: 600 (10 minutes — only needed for STS exchange).
 */
function getIdentityTokenExpiry(env: Env): number {
  const envValue = env.GCP_IDENTITY_TOKEN_EXPIRY_SECONDS;
  return envValue ? parseInt(envValue, 10) : DEFAULT_GCP_IDENTITY_TOKEN_EXPIRY_SECONDS;
}

/**
 * Claims for OIDC identity tokens used in cloud provider federation.
 */
export interface IdentityTokenClaims {
  /** User ID */
  userId: string;
  /** Project ID */
  projectId: string;
  /** Optional workspace ID */
  workspaceId?: string;
  /** Optional node ID */
  nodeId?: string;
  /** Target audience (GCP WIF provider resource URI) */
  audience: string;
}

/**
 * Sign an OIDC identity token for cloud provider federation (e.g., GCP Workload Identity).
 * This JWT is exchanged via STS for temporary cloud provider credentials.
 *
 * Uses the same RS256 key pair as other SAM JWTs. The token includes workspace/project
 * claims that can be mapped to cloud provider attributes for fine-grained access control.
 */
export async function signIdentityToken(
  claims: IdentityTokenClaims,
  env: Env,
  expirySecondsOverride?: number
): Promise<string> {
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  const expirySeconds = expirySecondsOverride ?? getIdentityTokenExpiry(env);
  const issuer = getIssuer(env);

  const token = await new SignJWT({
    type: IDENTITY_TOKEN_TYPE,
    user_id: claims.userId,
    project_id: claims.projectId,
    ...(claims.workspaceId ? { workspace_id: claims.workspaceId } : {}),
    ...(claims.nodeId ? { node_id: claims.nodeId } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: currentJwtKeyId(env) })
    .setIssuer(issuer)
    .setSubject(`project:${claims.projectId}`)
    .setAudience(claims.audience)
    .setExpirationTime(`${expirySeconds}s`)
    .setIssuedAt()
    .sign(privateKey);

  return token;
}

/**
 * Get the OIDC Discovery document content.
 * Published at /.well-known/openid-configuration for cloud providers to discover SAM's OIDC endpoints.
 */
export function getOidcDiscovery(env: Env) {
  const issuer = getIssuer(env);
  return {
    issuer,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ['id_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    claims_supported: [
      'iss',
      'sub',
      'aud',
      'exp',
      'iat',
      'workspace_id',
      'project_id',
      'user_id',
      'node_id',
    ],
  };
}
