import { DEFAULT_GCP_IDENTITY_TOKEN_EXPIRY_SECONDS } from '@simple-agent-manager/shared';
import { decodeJwt, exportJWK, importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose';

import type { Env } from '../env';

// Key ID format: key-YYYY-MM (rotates monthly)
const KEY_ID = `key-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

// Audiences for different token types
const TERMINAL_AUDIENCE = 'workspace-terminal';
const CALLBACK_AUDIENCE = 'workspace-callback';
const NODE_MANAGEMENT_AUDIENCE = 'node-management';
const PORT_ACCESS_AUDIENCE = 'port-access';
const LOCAL_FORWARD_AUDIENCE = 'local-forward';
const IDENTITY_TOKEN_TYPE = 'identity';
// Browser -> API WebSocket auth for the ephemeral credential-setup terminal
// (Cloudflare Sandbox). Scoped to a single {userId, setupSessionId}; NOT a
// workspace-terminal token — a setup session has no workspace.
const CREDENTIAL_SETUP_TERMINAL_AUDIENCE = 'credential-setup-terminal';

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
 * Get credential-setup terminal token expiry in milliseconds.
 * Short-lived: this token only authenticates a single WebSocket handshake to
 * the ephemeral setup sandbox. Default: 5 minutes (300000ms).
 */
function getCredentialSetupTerminalTokenExpiry(env: Env): number {
  const envValue = env.CREDENTIAL_SETUP_TERMINAL_TOKEN_EXPIRY_MS;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 5 * 60 * 1000;
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
 * Sign a credential-setup terminal token for a user + setup session.
 * Used by the browser to authenticate the WebSocket connection to the ephemeral
 * Cloudflare Sandbox terminal running the provider login CLI. Scoped to a single
 * setup session so it cannot be used to reach any other resource.
 */
export async function signCredentialSetupTerminalToken(
  userId: string,
  setupSessionId: string,
  env: Env
): Promise<{ token: string; expiresAt: string }> {
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  const expiry = getCredentialSetupTerminalTokenExpiry(env);
  const expiresAt = new Date(Date.now() + expiry);
  const issuer = getIssuer(env);

  const token = await new SignJWT({
    setupSession: setupSessionId,
  })
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setIssuer(issuer)
    .setSubject(userId)
    .setAudience(CREDENTIAL_SETUP_TERMINAL_AUDIENCE)
    .setExpirationTime(expiresAt)
    .setIssuedAt()
    .sign(privateKey);

  return {
    token,
    expiresAt: expiresAt.toISOString(),
  };
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
  env: Env
): Promise<string> {
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  const expiry = getCallbackTokenExpiry(env);
  const expiresAt = new Date(Date.now() + expiry);
  const issuer = getIssuer(env);

  const token = await new SignJWT({
    workspace: workspaceId,
    type: 'callback',
    scope: 'workspace',
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
  env: Env
): Promise<string> {
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  const expiry = getCallbackTokenExpiry(env);
  const expiresAt = new Date(Date.now() + expiry);
  const issuer = getIssuer(env);

  const token = await new SignJWT({
    workspace: nodeId,
    type: 'callback',
    scope: 'node',
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

/** Token scope discriminator. Legacy tokens (pre-scoping) have no scope claim. */
export type CallbackTokenScope = 'node' | 'workspace';

/**
 * Payload structure for verified callback tokens.
 * `scope` is optional for backward compatibility with legacy tokens.
 */
export interface CallbackTokenPayload {
  workspace: string;
  type: 'callback';
  scope?: CallbackTokenScope;
}

export interface TerminalTokenPayload {
  workspace: string;
  subject: string;
}

export interface CredentialSetupTerminalTokenPayload {
  userId: string;
  setupSessionId: string;
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
 * Returns the payload including the optional scope claim.
 *
 * @throws Error if token is invalid, expired, or has wrong audience
 */
export async function verifyCallbackToken(
  token: string,
  env: Env,
  options?: { expectedScope?: CallbackTokenScope }
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

  // Extract and validate optional scope claim (legacy tokens won't have it)
  const rawScope = payload.scope;
  if (rawScope !== undefined && rawScope !== 'node' && rawScope !== 'workspace') {
    throw new Error('Invalid token scope claim');
  }
  const scope = rawScope as CallbackTokenScope | undefined;

  // Enforce expected scope when specified (unified scope check — F-010)
  if (options?.expectedScope && scope !== options.expectedScope) {
    throw new Error(`Token scope '${scope ?? 'none'}' does not match expected '${options.expectedScope}'`);
  }

  return {
    workspace: payload.workspace,
    type: 'callback',
    scope,
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
export async function verifyTerminalToken(
  token: string,
  env: Env
): Promise<TerminalTokenPayload> {
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
  };
}

/**
 * Verify a credential-setup terminal token.
 *
 * Sent as a `?token=` query parameter on the setup terminal WebSocket upgrade
 * (WebSocket upgrades cannot reliably attach custom headers). The route handler
 * MUST additionally assert the returned `setupSessionId` matches the session id
 * in the URL before proxying to the sandbox terminal.
 *
 * @throws Error if token is invalid, expired, or has wrong audience
 */
export async function verifyCredentialSetupTerminalToken(
  token: string,
  env: Env
): Promise<CredentialSetupTerminalTokenPayload> {
  const publicKey = await importSPKI(env.JWT_PUBLIC_KEY, 'RS256');
  const issuer = getIssuer(env);

  const { payload } = await jwtVerify(token, publicKey, {
    issuer,
    audience: CREDENTIAL_SETUP_TERMINAL_AUDIENCE,
  });

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('Missing subject claim');
  }
  if (typeof payload.setupSession !== 'string' || payload.setupSession.length === 0) {
    throw new Error('Missing setupSession claim');
  }

  return {
    userId: payload.sub,
    setupSessionId: payload.setupSession,
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
  env: Env
): Promise<string> {
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  const expiry = getPortAccessTokenExpiry(env);
  const expiresAt = new Date(Date.now() + expiry);
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
    .setIssuedAt()
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
  env: Env
): Promise<{ token: string; expiresAt: string }> {
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  const expiry = getLocalForwardTokenExpiry(env);
  const expiresAt = new Date(Date.now() + expiry);
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
    .setIssuedAt()
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
  if (typeof payload.remotePort !== 'number' || payload.remotePort < 1 || payload.remotePort > 65535) {
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
  expirySecondsOverride?: number,
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
