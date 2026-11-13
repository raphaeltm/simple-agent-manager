/**
 * Trust configuration for agent sign-in through workload identity.
 *
 * A SAM instance explicitly configured as a test instance lets an agent running on another,
 * trusted SAM instance sign in as an allowed user, by presenting the workload identity (OIDC)
 * token that instance issues (`services/workload-identity-token.ts` there).
 *
 * The whole configuration is ONE deploy-time Worker secret, `AGENT_SIGN_IN_TRUST`, holding JSON.
 * It is deliberately not an admin setting: a compromised admin account must not be able to open
 * a sign-in door. Absent, empty or malformed configuration means the feature is off and the
 * endpoint behaves as if it did not exist. Unknown keys are malformed, so a typo can never
 * silently loosen trust.
 */
import * as v from 'valibot';

import type { Env } from '../../env';
import { log } from '../../lib/logger';

/** The exchange endpoint, mounted under `/api/auth`. Its full URL is the expected audience. */
export const AGENT_SIGN_IN_ROUTE = '/workload-identity-login';
export const AGENT_SIGN_IN_PATH = `/api/auth${AGENT_SIGN_IN_ROUTE}`;

/** The explicit "any user on this instance" value for `allowedTargets`. Dangerous; see docs. */
export const ANY_TARGET_USER = '*';

export const DEFAULT_AGENT_SIGN_IN_SESSION_TTL_SECONDS = 3600;
export const MIN_AGENT_SIGN_IN_SESSION_TTL_SECONDS = 60;
export const MAX_AGENT_SIGN_IN_SESSION_TTL_SECONDS = 86_400;

/** Accepted sign-ins per source principal (issuer + project + user) per rolling hour. */
export const DEFAULT_AGENT_SIGN_IN_MAX_PER_HOUR = 20;
export const MAX_AGENT_SIGN_IN_MAX_PER_HOUR = 1000;
export const AGENT_SIGN_IN_RATE_WINDOW_MS = 60 * 60 * 1000;

/** Coarse per-IP bound on exchange attempts (KV, best effort) before any token is verified. */
export const DEFAULT_AGENT_SIGN_IN_MAX_ATTEMPTS_PER_IP_PER_HOUR = 60;
export const MAX_AGENT_SIGN_IN_MAX_ATTEMPTS_PER_IP_PER_HOUR = 10_000;

/** How long the issuer's published keys are cached per isolate. */
export const DEFAULT_AGENT_SIGN_IN_JWKS_CACHE_SECONDS = 600;
export const MIN_AGENT_SIGN_IN_JWKS_CACHE_SECONDS = 30;
/** Bounded so a key the issuer has rotated out stops being trusted within an hour. */
export const MAX_AGENT_SIGN_IN_JWKS_CACHE_SECONDS = 3600;

/** Timeout for fetching the issuer's keys. The key document is static and normally fast. */
export const DEFAULT_AGENT_SIGN_IN_JWKS_TIMEOUT_SECONDS = 5;
export const MAX_AGENT_SIGN_IN_JWKS_TIMEOUT_SECONDS = 30;

/** Allowed clock skew for exp/iat between the two instances. */
export const DEFAULT_AGENT_SIGN_IN_CLOCK_TOLERANCE_SECONDS = 30;
export const MAX_AGENT_SIGN_IN_CLOCK_TOLERANCE_SECONDS = 300;

const NonEmptyId = v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256));

function integerIn(min: number, max: number) {
  return v.pipe(v.number(), v.integer(), v.minValue(min), v.maxValue(max));
}

const IssuerSchema = v.pipe(
  v.string(),
  v.check((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        // Exact, canonical form: the token's `iss` is compared byte for byte.
        url.href === value &&
        !value.endsWith('/')
      );
    } catch {
      return false;
    }
  }, 'issuer must be a canonical https URL without a trailing slash, query or fragment')
);

const TargetsSchema = v.union([
  v.literal(ANY_TARGET_USER),
  v.pipe(
    v.array(
      v.pipe(
        NonEmptyId,
        v.check((value) => value !== ANY_TARGET_USER, 'use "allowedTargets": "*" for any user')
      )
    ),
    v.minLength(1)
  ),
]);

const AgentSignInTrustSchema = v.strictObject({
  issuer: IssuerSchema,
  allowedSources: v.pipe(
    v.array(
      v.strictObject({
        projectId: NonEmptyId,
        userId: NonEmptyId,
        /** Optional: also require this agent profile (the token's agent_profile_id). */
        agentProfileId: v.optional(NonEmptyId),
      })
    ),
    v.minLength(1)
  ),
  allowedTargets: TargetsSchema,
  sessionTtlSeconds: v.optional(
    integerIn(MIN_AGENT_SIGN_IN_SESSION_TTL_SECONDS, MAX_AGENT_SIGN_IN_SESSION_TTL_SECONDS),
    DEFAULT_AGENT_SIGN_IN_SESSION_TTL_SECONDS
  ),
  maxSignInsPerHour: v.optional(
    integerIn(1, MAX_AGENT_SIGN_IN_MAX_PER_HOUR),
    DEFAULT_AGENT_SIGN_IN_MAX_PER_HOUR
  ),
  maxAttemptsPerIpPerHour: v.optional(
    integerIn(1, MAX_AGENT_SIGN_IN_MAX_ATTEMPTS_PER_IP_PER_HOUR),
    DEFAULT_AGENT_SIGN_IN_MAX_ATTEMPTS_PER_IP_PER_HOUR
  ),
  jwksCacheSeconds: v.optional(
    integerIn(MIN_AGENT_SIGN_IN_JWKS_CACHE_SECONDS, MAX_AGENT_SIGN_IN_JWKS_CACHE_SECONDS),
    DEFAULT_AGENT_SIGN_IN_JWKS_CACHE_SECONDS
  ),
  jwksTimeoutSeconds: v.optional(
    integerIn(1, MAX_AGENT_SIGN_IN_JWKS_TIMEOUT_SECONDS),
    DEFAULT_AGENT_SIGN_IN_JWKS_TIMEOUT_SECONDS
  ),
  clockToleranceSeconds: v.optional(
    integerIn(0, MAX_AGENT_SIGN_IN_CLOCK_TOLERANCE_SECONDS),
    DEFAULT_AGENT_SIGN_IN_CLOCK_TOLERANCE_SECONDS
  ),
});

export type AgentSignInTrust = v.InferOutput<typeof AgentSignInTrustSchema>;

// Per-isolate memo of the last parsed secret, so a malformed value is logged once, not per call.
let memo: { raw: string; trust: AgentSignInTrust | null } | null = null;

/**
 * The active trust configuration, or `null` when the feature is off. Never throws: a malformed
 * value is logged (issue paths only, never the value) and treated as off.
 */
export function resolveAgentSignInTrust(
  env: Pick<Env, 'AGENT_SIGN_IN_TRUST'>
): AgentSignInTrust | null {
  const raw = env.AGENT_SIGN_IN_TRUST?.trim() ?? '';
  if (!raw) return null;
  if (memo?.raw === raw) return memo.trust;
  let trust: AgentSignInTrust | null = null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.error('agent_sign_in.config_invalid', { reason: 'not_json', action: 'feature_off' });
    memo = { raw, trust: null };
    return null;
  }
  const result = v.safeParse(AgentSignInTrustSchema, parsed);
  if (result.success) {
    trust = result.output;
  } else {
    log.error('agent_sign_in.config_invalid', {
      reason: 'schema',
      // Paths and messages only. Messages for literal/union failures do not echo values.
      issues: result.issues.slice(0, 5).map((issue) => ({
        path: v.getDotPath(issue),
        kind: issue.type,
      })),
      action: 'feature_off',
    });
  }
  memo = { raw, trust };
  return trust;
}

/** Whether this instance accepts agent sign-in (published as a boolean on the sign-in page). */
export function isAgentSignInEnabled(env: Pick<Env, 'AGENT_SIGN_IN_TRUST'>): boolean {
  return resolveAgentSignInTrust(env) !== null;
}

/** This instance's expected audience: its own exchange endpoint URL, built from BASE_DOMAIN. */
export function agentSignInAudience(env: Pick<Env, 'BASE_DOMAIN'>): string {
  return `https://api.${env.BASE_DOMAIN}${AGENT_SIGN_IN_PATH}`;
}

/** The trusted issuer's key set, at the path every SAM issuer publishes it. */
export function agentSignInJwksUrl(trust: AgentSignInTrust): URL {
  return new URL(`${trust.issuer}/.well-known/jwks.json`);
}

export function isAllowedSource(
  trust: AgentSignInTrust,
  source: { projectId: string; userId: string; agentProfileId: string | null }
): boolean {
  return trust.allowedSources.some(
    (allowed) =>
      allowed.projectId === source.projectId &&
      allowed.userId === source.userId &&
      (allowed.agentProfileId === undefined || allowed.agentProfileId === source.agentProfileId)
  );
}

/**
 * Whether the resolved target account is allowed. Matched on the stored row (id, or the stored
 * email case-insensitively), never on the caller's spelling of the target.
 */
export function isAllowedTarget(
  trust: AgentSignInTrust,
  user: { id: string; email: string | null }
): boolean {
  if (trust.allowedTargets === ANY_TARGET_USER) return true;
  const email = user.email?.trim().toLowerCase();
  return trust.allowedTargets.some(
    (entry) => entry === user.id || (entry.includes('@') && entry.toLowerCase() === email)
  );
}
