/**
 * Verification of platform-signed JWTs and the /.well-known/jwks.json document.
 *
 * Every verifier goes through {@link verifyPlatformJwt}, which tries the current public key and,
 * only when that fails on the signature, the previous key while its overlap window is open
 * (`jwt-keys.ts:activePreviousJwtKey`). Claim checks are the same jose options on both paths.
 */
import {
  exportJWK,
  importSPKI,
  type JWTPayload,
  jwtVerify,
  type JWTVerifyOptions,
  type JWTVerifyResult,
} from 'jose';

import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { AppError } from '../middleware/error';
import { CALLBACK_TOKEN_CREDENTIAL_GENERATION_CLAIM } from './callback-token-claims';
import { assertCallbackCredentialGenerationCurrent } from './callback-token-generation';
import {
  activePreviousJwtKey,
  CALLBACK_AUDIENCE,
  currentJwtKeyId,
  getIssuer,
  LOCAL_FORWARD_AUDIENCE,
  PORT_ACCESS_AUDIENCE,
  TERMINAL_AUDIENCE,
} from './jwt-keys';

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

function callbackTokenUnauthorized(message = 'Invalid or expired callback token'): AppError {
  return new AppError(401, 'UNAUTHORIZED', message);
}

function callbackTokenForbidden(message: string): AppError {
  return new AppError(403, 'FORBIDDEN', message);
}

function joseErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isJoseVerificationFailure(error: unknown): boolean {
  const code = joseErrorCode(error);
  return (
    code !== undefined &&
    (code.startsWith('ERR_JWT_') || code.startsWith('ERR_JWS_') || code.startsWith('ERR_JOSE_'))
  );
}

// The only failure a different key can change. A claim failure (iss, aud, exp, ...) means the
// current key verified the signature, so retrying with the previous key cannot help. A token whose
// kid names the previous key fails here too, because verification uses one key, not a key set.
function isSignatureFailure(error: unknown): boolean {
  return joseErrorCode(error) === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED';
}

/**
 * Verify a platform-signed JWT: current key first, then the previous key while its overlap window
 * is open at `nowMs`, and only when the current key rejected the signature. `options` (issuer,
 * audience, ...) apply unchanged on both paths. A previous key that does not verify the signature
 * either, or that cannot be imported, surfaces the current key's error.
 */
export async function verifyPlatformJwt(
  token: string,
  env: Env,
  options: JWTVerifyOptions,
  nowMs: number = Date.now()
): Promise<JWTVerifyResult> {
  const currentKey = await importSPKI(env.JWT_PUBLIC_KEY, 'RS256');
  try {
    return await jwtVerify(token, currentKey, options);
  } catch (currentError) {
    if (!isSignatureFailure(currentError)) throw currentError;
    const previous = activePreviousJwtKey(env, nowMs);
    if (!previous) throw currentError;

    let previousKey: CryptoKey;
    try {
      previousKey = await importSPKI(previous.publicKeyPem, 'RS256');
    } catch (importError) {
      log.error('jwt.previous_key_import_failed', {
        ...serializeError(importError),
        previousKid: previous.kid,
        action: 'previous_key_ignored',
      });
      throw currentError;
    }

    try {
      const result = await jwtVerify(token, previousKey, options);
      log.info('jwt.previous_key_accepted', {
        audience: options.audience,
        previousKid: previous.kid,
        until: new Date(previous.untilMs).toISOString(),
      });
      return result;
    } catch (previousError) {
      throw isSignatureFailure(previousError) ? currentError : previousError;
    }
  }
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
  const issuer = getIssuer(env);

  let payload: JWTPayload;
  try {
    ({ payload } = await verifyPlatformJwt(token, env, {
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
  const issuer = getIssuer(env);

  const { payload } = await verifyPlatformJwt(token, env, {
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
 * Verify a port access token from an exposed port URL or cookie.
 *
 * @throws Error if token is invalid, expired, or has wrong audience
 */
export async function verifyPortAccessToken(
  token: string,
  env: Env
): Promise<PortAccessTokenPayload> {
  const issuer = getIssuer(env);

  const { payload } = await verifyPlatformJwt(token, env, {
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

export async function verifyLocalForwardToken(
  token: string,
  env: Env
): Promise<LocalForwardTokenPayload> {
  const issuer = getIssuer(env);

  const { payload } = await verifyPlatformJwt(token, env, {
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
 * Get the JWKS (JSON Web Key Set) for JWT validation.
 * Published at /.well-known/jwks.json for VM Agent to fetch.
 *
 * The current key comes first. The previous key is added while its overlap window is open, under
 * its own kid; if that kid equals the current one it is left out, since a key set with two keys
 * under one kid cannot be resolved by kid.
 */
export async function getJWKS(env: Env, nowMs: number = Date.now()) {
  const currentKid = currentJwtKeyId(env);
  const keys = [
    {
      ...(await exportJWK(await importSPKI(env.JWT_PUBLIC_KEY, 'RS256'))),
      kid: currentKid,
      use: 'sig',
      alg: 'RS256',
    },
  ];

  const previous = activePreviousJwtKey(env, nowMs);
  if (!previous) return { keys };
  if (previous.kid === currentKid) {
    log.warn('jwt.previous_key_kid_collision', {
      kid: currentKid,
      action: 'previous_key_not_published',
    });
    return { keys };
  }
  try {
    const jwk = await exportJWK(await importSPKI(previous.publicKeyPem, 'RS256'));
    keys.push({ ...jwk, kid: previous.kid, use: 'sig', alg: 'RS256' });
  } catch (error) {
    log.error('jwt.previous_key_import_failed', {
      ...serializeError(error),
      previousKid: previous.kid,
      action: 'previous_key_not_published',
    });
  }
  return { keys };
}
