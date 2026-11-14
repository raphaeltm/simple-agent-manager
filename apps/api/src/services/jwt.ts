import {
  DEFAULT_GCP_IDENTITY_TOKEN_EXPIRY_SECONDS,
  DEFAULT_TERMINAL_TOKEN_EXPIRY_MS,
} from '@simple-agent-manager/shared';
import {
  decodeJwt,
  exportJWK,
  importPKCS8,
  importSPKI,
  type JWTPayload,
  jwtVerify,
  SignJWT,
} from 'jose';

import type { Env } from '../env';
import { AppError } from '../middleware/error';
import {
  CALLBACK_TOKEN_CREDENTIAL_GENERATION_CLAIM,
  CALLBACK_TOKEN_GENERATION_ISSUED_AT_CLAIM,
} from './callback-token-claims';
import {
  assertCallbackCredentialGenerationCurrent,
  loadCallbackCredentialGeneration,
} from './callback-token-generation';

// Key ID format: key-YYYY-MM (rotates monthly)
const KEY_ID = `key-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

// Audiences for different token types
const TERMINAL_AUDIENCE = 'workspace-terminal';
const CALLBACK_AUDIENCE = 'workspace-callback';
const NODE_MANAGEMENT_AUDIENCE = 'node-management';
const PORT_ACCESS_AUDIENCE = 'port-access';
const LOCAL_FORWARD_AUDIENCE = 'local-forward';
const IDENTITY_TOKEN_TYPE = 'identity';

function callbackTokenUnauthorized(message = 'Invalid or expired callback token'): AppError {
  return new AppError(401, 'UNAUTHORIZED', message);
}

function callbackTokenForbidden(message: string): AppError {
  return new AppError(403, 'FORBIDDEN', message);
}

function isJoseVerificationFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === 'string' &&
    (code.startsWith('ERR_JWT_') || code.startsWith('ERR_JWS_') || code.startsWith('ERR_JOSE_'))
  );
}

/**
 * Get the JWT issuer URL from environment.
 * Derives from BASE_DOMAIN per constitution principle XI (no hardcoded values).
 */
function getIssuer(env: Env): string {
  return `https://api.${env.BASE_DOMAIN}`;
}

/**
 * A token's expiry: `expiryMs` from now, but never later than `notAfter` when given. Session
 * routes pass an agent sign-in session's hard expiry (`credentialNotAfter`), so a token minted by
 * that session cannot outlive it.
 */
function cappedExpiry(expiryMs: number, notAfter?: Date, now = Date.now()): Date {
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
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
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
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
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
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
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
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
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

/** Token scope discriminator. Every callback token names exactly one scope. */
export type CallbackTokenScope = 'node' | 'workspace';

/** Payload structure for verified callback tokens. */
export interface CallbackTokenPayload {
  workspace: string;
  type: 'callback';
  scope: CallbackTokenScope;
  /**
   * The token's credential generation (`cgen`), null when absent. Verification has already
   * proved it equals the row's current generation; renewals must carry it forward.
   */
  callbackGeneration: string | null;
}

export interface TerminalTokenPayload {
  workspace: string;
  subject: string;
  sessionToken?: string;
}

export interface PortAccessTokenPayload {
  workspace: string;
  port: number;
  subject: string;
}

export interface LocalForwardTokenPayload {
  userId: string;
  workspaceId: string;
  nodeId: string;
  remotePort: number;
  mode: 'http';
  localAuthority: string;
  subject: string;
}

/**
 * Verify a callback token from VM Agent.
 *
 * Fails closed on anything SAM never mints: a missing or unknown `scope` (unscoped tokens
 * stopped being issued in #483, and every renewal path mints scoped tokens) or a missing
 * `iat` (every signer calls `setIssuedAt`, and the Instant stale-callback guard needs it).
 *
 * Also rejects a token from a retired runtime: its `cgen` claim must equal the current
 * `callback_generation` of the workspace or node row it names (one D1 read). This is the
 * single place every callback sink inherits revocation across reactivation from, so the
 * check lives here rather than at each sink (`callback-token-generation.ts`).
 *
 * @throws AppError 401 if the token is invalid, expired, has the wrong audience, or lacks
 *   a required claim; 403 if `expectedScope` is set and does not match.
 */
export async function verifyCallbackToken(
  token: string,
  env: Env,
  options?: { expectedScope?: CallbackTokenScope }
): Promise<CallbackTokenPayload> {
  const publicKey = await importSPKI(env.JWT_PUBLIC_KEY, 'RS256');
  const issuer = getIssuer(env);

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, publicKey, {
      issuer,
      audience: CALLBACK_AUDIENCE,
    }));
  } catch (error) {
    if (isJoseVerificationFailure(error)) {
      throw callbackTokenUnauthorized();
    }
    throw error;
  }

  // Validate required claims
  if (payload.type !== 'callback') {
    throw callbackTokenUnauthorized('Invalid token type');
  }

  if (typeof payload.workspace !== 'string') {
    throw callbackTokenUnauthorized('Missing workspace claim');
  }

  const rawScope = payload.scope;
  if (rawScope !== 'node' && rawScope !== 'workspace') {
    throw callbackTokenUnauthorized(
      rawScope === undefined ? 'Missing token scope claim' : 'Invalid token scope claim'
    );
  }
  const scope: CallbackTokenScope = rawScope;

  if (typeof payload.iat !== 'number' || !Number.isSafeInteger(payload.iat) || payload.iat <= 0) {
    throw callbackTokenUnauthorized('Missing token issue time');
  }

  const rawGeneration = payload[CALLBACK_TOKEN_CREDENTIAL_GENERATION_CLAIM];
  if (rawGeneration !== undefined && (typeof rawGeneration !== 'string' || rawGeneration === '')) {
    throw callbackTokenUnauthorized('Invalid token generation claim');
  }
  const callbackGeneration: string | null =
    typeof rawGeneration === 'string' ? rawGeneration : null;

  // Enforce expected scope when specified (unified scope check — F-010)
  if (options?.expectedScope && scope !== options.expectedScope) {
    throw callbackTokenForbidden(
      `Token scope '${scope}' does not match expected '${options.expectedScope}'`
    );
  }

  await assertCallbackCredentialGenerationCurrent(
    env,
    scope,
    payload.workspace,
    callbackGeneration
  );

  return {
    workspace: payload.workspace,
    type: 'callback',
    scope,
    callbackGeneration,
  };
}

/**
 * Verify a browser-to-workspace terminal token.
 *
 * These tokens are minted after normal app authentication by
 * POST /api/terminal/token, then sent directly to workspace subdomains as a
 * query parameter because WebSocket upgrades cannot reliably attach custom
 * headers. The API workspace proxy verifies the token before forwarding the
 * request to the VM agent so token-only project chat connections do not depend
 * on cross-subdomain app cookies.
 */
export async function verifyTerminalToken(token: string, env: Env): Promise<TerminalTokenPayload> {
  const publicKey = await importSPKI(env.JWT_PUBLIC_KEY, 'RS256');
  const issuer = getIssuer(env);

  const { payload } = await jwtVerify(token, publicKey, {
    issuer,
    audience: TERMINAL_AUDIENCE,
  });

  if (typeof payload.workspace !== 'string') {
    throw new Error('Missing workspace claim');
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('Missing subject claim');
  }

  return {
    workspace: payload.workspace,
    subject: payload.sub,
    sessionToken:
      typeof payload.sessionToken === 'string' && payload.sessionToken.length > 0
        ? payload.sessionToken
        : undefined,
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
  const now = Date.now();
  const expiresAt = cappedExpiry(getPortAccessTokenExpiry(env), options.notAfter, now);
  const issuer = getIssuer(env);

  const token = await new SignJWT({
    workspace: workspaceId,
    port,
  })
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setIssuer(issuer)
    .setSubject(userId)
    .setAudience(PORT_ACCESS_AUDIENCE)
    .setExpirationTime(expiresAt)
    .setIssuedAt(Math.floor(now / 1000))
    .sign(privateKey);

  return token;
}

/**
 * Verify a port access token from an exposed port URL or cookie.
 *
 * @throws Error if token is invalid, expired, or has wrong audience
 */
export async function verifyPortAccessToken(
  token: string,
  env: Env
): Promise<PortAccessTokenPayload> {
  const publicKey = await importSPKI(env.JWT_PUBLIC_KEY, 'RS256');
  const issuer = getIssuer(env);

  const { payload } = await jwtVerify(token, publicKey, {
    issuer,
    audience: PORT_ACCESS_AUDIENCE,
  });

  if (typeof payload.workspace !== 'string') {
    throw new Error('Missing workspace claim');
  }
  if (typeof payload.port !== 'number') {
    throw new Error('Missing port claim');
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('Missing subject claim');
  }

  return {
    workspace: payload.workspace,
    port: payload.port,
    subject: payload.sub,
  };
}

export async function signLocalForwardToken(
  claims: Omit<LocalForwardTokenPayload, 'subject'>,
  env: Env,
  options: { notAfter?: Date } = {}
): Promise<{ token: string; expiresAt: string }> {
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  const now = Date.now();
  const expiresAt = cappedExpiry(getLocalForwardTokenExpiry(env), options.notAfter, now);
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
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setIssuer(issuer)
    .setSubject(claims.userId)
    .setAudience(LOCAL_FORWARD_AUDIENCE)
    .setExpirationTime(expiresAt)
    .setIssuedAt(Math.floor(now / 1000))
    .sign(privateKey);

  return {
    token,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function verifyLocalForwardToken(
  token: string,
  env: Env
): Promise<LocalForwardTokenPayload> {
  const publicKey = await importSPKI(env.JWT_PUBLIC_KEY, 'RS256');
  const issuer = getIssuer(env);

  const { payload } = await jwtVerify(token, publicKey, {
    issuer,
    audience: LOCAL_FORWARD_AUDIENCE,
  });

  if (payload.type !== 'local-forward') {
    throw new Error('Invalid token type');
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('Missing subject claim');
  }
  if (typeof payload.userId !== 'string' || payload.userId !== payload.sub) {
    throw new Error('Invalid user claim');
  }
  if (typeof payload.workspace !== 'string') {
    throw new TypeError('Missing workspace claim');
  }
  if (typeof payload.node !== 'string') {
    throw new TypeError('Missing node claim');
  }
  if (
    typeof payload.remotePort !== 'number' ||
    payload.remotePort < 1 ||
    payload.remotePort > 65535
  ) {
    throw new Error('Invalid remote port claim');
  }
  if (payload.mode !== 'http') {
    throw new Error('Invalid local forward mode');
  }
  if (typeof payload.localAuthority !== 'string' || payload.localAuthority.length === 0) {
    throw new Error('Missing local authority claim');
  }

  return {
    userId: payload.userId,
    workspaceId: payload.workspace,
    nodeId: payload.node,
    remotePort: payload.remotePort,
    mode: payload.mode,
    localAuthority: payload.localAuthority,
    subject: payload.sub,
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
 * Get the JWKS (JSON Web Key Set) for JWT validation.
 * Published at /.well-known/jwks.json for VM Agent to fetch.
 */
export async function getJWKS(env: Env) {
  const publicKey = await importSPKI(env.JWT_PUBLIC_KEY, 'RS256');
  const jwk = await exportJWK(publicKey);

  return {
    keys: [
      {
        ...jwk,
        kid: KEY_ID,
        use: 'sig',
        alg: 'RS256',
      },
    ],
  };
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
  const issuedAt = Math.floor(Date.now() / 1000);
  const issuer = getIssuer(env);

  const token = await new SignJWT({
    type: IDENTITY_TOKEN_TYPE,
    user_id: claims.userId,
    project_id: claims.projectId,
    ...(claims.workspaceId ? { workspace_id: claims.workspaceId } : {}),
    ...(claims.nodeId ? { node_id: claims.nodeId } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setIssuer(issuer)
    .setSubject(`project:${claims.projectId}`)
    .setAudience(claims.audience)
    .setExpirationTime(issuedAt + expirySeconds)
    .setIssuedAt(issuedAt)
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
