/**
 * The credential box Caddy presents to a deployment node's agent for app traffic
 * (`X-SAM-Node-Authorization`, `app-route.ts`). Purpose-limited on purpose: audience
 * `node-app-ingress`, bound to one node and one app hostname, valid for
 * SELF_HOST_APP_INGRESS_TOKEN_TTL_SECONDS (300 s by default). The agent accepts it only on
 * `/deployment/app-ingress/<that hostname>` (`ValidateAppIngressToken`,
 * packages/vm-agent/internal/auth/jwt.go), never on its management API. A leaked copy can do
 * no more than send app requests the box would have sent anyway, for a few minutes.
 *
 * Tokens are reused until shortly before they expire, so an app's page load (dozens of
 * requests, one decision each) signs once per hostname, not once per request. An expired entry is
 * replaced on its next read, so the cache holds at most one entry per live app hostname.
 */
import { importPKCS8, SignJWT } from 'jose';

import { currentJwtKeyId, getIssuer } from '../../services/jwt-keys';
import type { ReverseTunnelEnv as Env } from './env';

export const APP_INGRESS_AUDIENCE = 'node-app-ingress';
export const APP_INGRESS_TOKEN_TYPE = 'app-ingress';
export const DEFAULT_APP_INGRESS_TOKEN_TTL_SECONDS = 300;
/** Upper bound for the TTL setting: the credential must stay short-lived. */
const MAX_APP_INGRESS_TOKEN_TTL_SECONDS = 3600;
/** A cached token is renewed once less than this share of its lifetime remains. */
const RENEW_REMAINING_FRACTION = 0.2;

const cache = new Map<string, { token: string; renewAtMs: number }>();

export function appIngressTokenTtlSeconds(
  env: Pick<Env, 'SELF_HOST_APP_INGRESS_TOKEN_TTL_SECONDS'>
): number {
  const raw = env.SELF_HOST_APP_INGRESS_TOKEN_TTL_SECONDS?.trim();
  const value = raw ? Number(raw) : DEFAULT_APP_INGRESS_TOKEN_TTL_SECONDS;
  return Number.isInteger(value) && value >= 30 && value <= MAX_APP_INGRESS_TOKEN_TTL_SECONDS
    ? value
    : DEFAULT_APP_INGRESS_TOKEN_TTL_SECONDS;
}

export async function appIngressToken(
  env: Env,
  claims: { userId: string; nodeId: string; host: string }
): Promise<string> {
  const key = `${claims.userId}\n${claims.nodeId}\n${claims.host}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now < cached.renewAtMs) return cached.token;

  const ttlSeconds = appIngressTokenTtlSeconds(env);
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  const issuedAt = Math.floor(now / 1000);
  const token = await new SignJWT({
    type: APP_INGRESS_TOKEN_TYPE,
    node: claims.nodeId,
    appHost: claims.host,
  })
    .setProtectedHeader({ alg: 'RS256', kid: currentJwtKeyId(env) })
    .setIssuer(getIssuer(env))
    .setSubject(claims.userId)
    .setAudience(APP_INGRESS_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .sign(privateKey);
  cache.set(key, { token, renewAtMs: now + ttlSeconds * 1000 * (1 - RENEW_REMAINING_FRACTION) });
  return token;
}

/** Test seam. */
export function resetAppIngressTokenCacheForTests(): void {
  cache.clear();
}
