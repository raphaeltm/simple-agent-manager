import { SignJWT, jwtVerify, decodeJwt, importPKCS8, exportJWK, importSPKI } from 'jose';
import type { Env } from '../index';

// Key ID format: key-YYYY-MM (rotates monthly)
const KEY_ID = `key-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

// Audiences for different token types
const TERMINAL_AUDIENCE = 'workspace-terminal';
const CALLBACK_AUDIENCE = 'workspace-callback';
const NODE_MANAGEMENT_AUDIENCE = 'node-management';
const IDENTITY_TOKEN_TYPE = 'identity';

/**
 * Get the JWT issuer URL from environment.
 * Derives from BASE_DOMAIN per constitution principle XI (no hardcoded values).
 */
function getIssuer(env: Env): string {
  return `https://api.${env.BASE_DOMAIN}`;
}

/**
 * Get terminal token expiry in milliseconds.
 * Default: 1 hour (3600000ms)
 */
function getTerminalTokenExpiry(env: Env): number {
  const envValue = env.TERMINAL_TOKEN_EXPIRY_MS;
  return envValue ? parseInt(envValue, 10) : 60 * 60 * 1000;
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
  env: Env
): Promise<{ token: string; expiresAt: string }> {
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  const expiry = getTerminalTokenExpiry(env);
  const expiresAt = new Date(Date.now() + expiry);
  const issuer = getIssuer(env);

  const token = await new SignJWT({
    workspace: workspaceId,
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

/**
 * Sign a callback token for VM-to-API authentication.
 * Used by VM agent to call back to control plane (heartbeat, ready, etc.)
 */
export async function signCallbackToken(
  workspaceId: string,
  env: Env
): Promise<string> {
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  const expiry = getCallbackTokenExpiry(env);
  const expiresAt = new Date(Date.now() + expiry);
  const issuer = getIssuer(env);

  const token = await new SignJWT({
    workspace: workspaceId,
    type: 'callback',
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
 * Sign a management token for Control Plane -> Node Agent API calls.
 */
export async function signNodeManagementToken(
  userId: string,
  nodeId: string,
  workspaceId: string | null,
  env: Env
): Promise<{ token: string; expiresAt: string }> {
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  const expiry = getTerminalTokenExpiry(env);
  const expiresAt = new Date(Date.now() + expiry);
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

/**
 * Payload structure for verified callback tokens.
 */
export interface CallbackTokenPayload {
  workspace: string;
  type: 'callback';
}

/**
 * Verify a callback token from VM Agent.
 * Returns the workspace ID if valid, throws on invalid token.
 *
 * @throws Error if token is invalid, expired, or has wrong audience
 */
export async function verifyCallbackToken(
  token: string,
  env: Env
): Promise<CallbackTokenPayload> {
  const publicKey = await importSPKI(env.JWT_PUBLIC_KEY, 'RS256');
  const issuer = getIssuer(env);

  const { payload } = await jwtVerify(token, publicKey, {
    issuer,
    audience: CALLBACK_AUDIENCE,
  });

  // Validate required claims
  if (payload.type !== 'callback') {
    throw new Error('Invalid token type');
  }

  if (typeof payload.workspace !== 'string') {
    throw new Error('Missing workspace claim');
  }

  return {
    workspace: payload.workspace,
    type: 'callback',
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
  return envValue ? parseInt(envValue, 10) : 600;
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
  env: Env
): Promise<string> {
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  const expirySeconds = getIdentityTokenExpiry(env);
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
      'iss', 'sub', 'aud', 'exp', 'iat',
      'workspace_id', 'project_id', 'user_id',
      'node_id',
    ],
  };
}
