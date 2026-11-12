/**
 * Verification of a trusted issuer's workload identity token for agent sign-in.
 *
 * Checks, in order: header shape (RS256 with a key ID), signature against the issuer's
 * published keys, exact issuer and audience, expiry and issue time (with a maximum age equal to
 * SAM's maximum workload identity lifetime), then the SAM workload identity claim shape.
 * Signature, issuer, audience and time checks are jose's `jwtVerify`; nothing is trusted from
 * the token before it returns.
 */
import { MAX_WORKLOAD_IDENTITY_TOKEN_TTL_SECONDS } from '@simple-agent-manager/shared';
import {
  createRemoteJWKSet,
  customFetch,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
} from 'jose';
import * as v from 'valibot';

import { log } from '../../lib/logger';
import { guardedFetch, OutboundRequestRefusedError } from '../../lib/network-hosts';
import { AppError } from '../../middleware/error';
import { agentSignInJwksUrl, type AgentSignInTrust } from './config';

/**
 * Minimum time between key refetches triggered by an unknown key ID (jose's default). Fixed on
 * purpose: it bounds how often a caller presenting made-up key IDs can make this instance fetch
 * the issuer's keys, and loosening it only weakens that bound.
 */
export const DEFAULT_AGENT_SIGN_IN_JWKS_COOLDOWN_MS = 30_000;
const MAX_TOKEN_LENGTH = 16_384;

type RemoteJwks = ReturnType<typeof createRemoteJWKSet>;
const jwksByIssuer = new Map<string, { settings: string; jwks: RemoteJwks }>();

/**
 * The key fetch goes through the guarded outbound fetch: the issuer host is classified before
 * the request (public HTTPS only; loopback, private ranges and the metadata address are refused)
 * and no redirect is followed. An operator writes the issuer into the trust, but the URL is
 * still fetched by the Worker, and on a self-hosted runtime the Worker sits next to services a
 * public host must never be able to reach. SAM's key document never redirects, so
 * `maxRedirects: 0` costs nothing. jose's timeout signal arrives as `init.signal` and still
 * bounds the request.
 */
const fetchIssuerKeys = (url: string, init: RequestInit): Promise<Response> =>
  guardedFetch(url, init, { maxRedirects: 0 });

/** Per-isolate key cache for the trusted issuer. Rebuilt when its cache or timeout settings change. */
function issuerKeys(trust: AgentSignInTrust): RemoteJwks {
  const settings = `${trust.jwksCacheSeconds}:${trust.jwksTimeoutSeconds}`;
  const cached = jwksByIssuer.get(trust.issuer);
  if (cached && cached.settings === settings) return cached.jwks;
  const jwks = createRemoteJWKSet(agentSignInJwksUrl(trust), {
    cacheMaxAge: trust.jwksCacheSeconds * 1000,
    cooldownDuration: DEFAULT_AGENT_SIGN_IN_JWKS_COOLDOWN_MS,
    timeoutDuration: trust.jwksTimeoutSeconds * 1000,
    [customFetch]: fetchIssuerKeys,
  });
  jwksByIssuer.set(trust.issuer, { settings, jwks });
  return jwks;
}

export function __resetAgentSignInKeyCacheForTest(): void {
  jwksByIssuer.clear();
}

const OptionalId = v.optional(v.pipe(v.string(), v.maxLength(256)));
const RequiredId = v.pipe(v.string(), v.nonEmpty(), v.maxLength(256));

/** The claims SAM's workload identity issuer always sets, plus the IDs audited when present. */
const AgentSignInClaimsSchema = v.object({
  iss: v.string(),
  sub: RequiredId,
  jti: RequiredId,
  iat: v.number(),
  exp: v.number(),
  type: v.literal('workload-identity'),
  project_id: RequiredId,
  user_id: RequiredId,
  agent_profile_id: OptionalId,
  task_id: OptionalId,
  workspace_id: OptionalId,
});

export type AgentSignInClaims = v.InferOutput<typeof AgentSignInClaimsSchema>;

/** A rejection reason from a fixed set: safe to return to an unauthenticated caller. */
export type AgentSignInTokenRejection =
  | 'malformed'
  | 'algorithm'
  | 'unknown_key'
  | 'signature'
  | 'issuer'
  | 'audience'
  | 'expired'
  | 'not_yet_valid'
  | 'too_old'
  | 'claims';

export class AgentSignInTokenError extends AppError {
  constructor(public readonly reason: AgentSignInTokenRejection) {
    super(401, 'UNAUTHORIZED', `Workload identity token rejected (${reason})`);
  }
}

function rejectionFor(err: unknown): AgentSignInTokenRejection | null {
  // jose reports both an expired `exp` and an `iat` older than maxTokenAge as JWTExpired.
  if (err instanceof joseErrors.JWTExpired) return err.claim === 'iat' ? 'too_old' : 'expired';
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.reason === 'missing') return 'claims';
    if (err.claim === 'iss') return 'issuer';
    if (err.claim === 'aud') return 'audience';
    if (err.claim === 'iat' || err.claim === 'nbf') return 'not_yet_valid';
    return 'claims';
  }
  if (err instanceof joseErrors.JOSEAlgNotAllowed) return 'algorithm';
  if (
    err instanceof joseErrors.JWKSNoMatchingKey ||
    err instanceof joseErrors.JWKSMultipleMatchingKeys
  ) {
    return 'unknown_key';
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return 'signature';
  if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) {
    return 'malformed';
  }
  return null;
}

/**
 * Verify `token` against `trust` and `audience`. Throws `AgentSignInTokenError` (401) for a
 * token that is not acceptable, and a 503 when the issuer's keys cannot be fetched: an
 * unreachable issuer has proved nothing about the token, so it is not reported as a bad token.
 */
export async function verifyAgentSignInToken(
  token: string,
  trust: AgentSignInTrust,
  audience: string
): Promise<AgentSignInClaims> {
  if (!token || token.length > MAX_TOKEN_LENGTH) throw new AgentSignInTokenError('malformed');
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new AgentSignInTokenError('malformed');
  }
  // RS256 only. Rejecting here keeps `alg: none` and HMAC tokens (for example HS256 keyed with
  // the issuer's public key) away from any key lookup; jwtVerify enforces the same list.
  if (header.alg !== 'RS256') throw new AgentSignInTokenError('algorithm');
  if (typeof header.kid !== 'string' || !header.kid) throw new AgentSignInTokenError('unknown_key');

  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, issuerKeys(trust), {
      algorithms: ['RS256'],
      issuer: trust.issuer,
      audience,
      clockTolerance: trust.clockToleranceSeconds,
      maxTokenAge: MAX_WORKLOAD_IDENTITY_TOKEN_TTL_SECONDS,
      requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'jti'],
    }));
  } catch (err) {
    const reason = rejectionFor(err);
    if (reason) throw new AgentSignInTokenError(reason);
    if (err instanceof OutboundRequestRefusedError) {
      // The operator's issuer URL (or its redirect) is not a host this Worker may fetch.
      log.error('agent_sign_in.issuer_keys_refused', {
        issuer: trust.issuer,
        host: err.host,
        reason: err.reason,
        action: 'rejected',
      });
    }
    throw new AppError(
      503,
      'ISSUER_KEYS_UNAVAILABLE',
      'The trusted issuer’s signing keys could not be fetched; try again shortly'
    );
  }

  const claims = v.safeParse(AgentSignInClaimsSchema, payload);
  if (!claims.success) throw new AgentSignInTokenError('claims');
  // A token whose lifetime exceeds what any SAM issuer can mint is not a SAM workload token.
  if (claims.output.exp - claims.output.iat > MAX_WORKLOAD_IDENTITY_TOKEN_TTL_SECONDS) {
    throw new AgentSignInTokenError('too_old');
  }
  return claims.output;
}
