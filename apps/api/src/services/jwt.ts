import { SignJWT, jwtVerify, importPKCS8, exportJWK, importSPKI } from 'jose';
import type { Env } from '../index';

// Key ID format: key-YYYY-MM (rotates monthly)
const KEY_ID = `key-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

// Audiences for different token types
const TERMINAL_AUDIENCE = 'workspace-terminal';
const CALLBACK_AUDIENCE = 'workspace-callback';
const NODE_MANAGEMENT_AUDIENCE = 'node-management';

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
