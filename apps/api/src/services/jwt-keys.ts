/**
 * Platform JWT signing-key identity and the bounded previous-key overlap window.
 *
 * The Worker signs every internal JWT (callback, terminal, node-management, port-access,
 * local-forward, identity) with `JWT_PRIVATE_KEY`. A self-hosted install rotates that key by
 * setting the new pair as current and the old public key as `JWT_PUBLIC_KEY_PREVIOUS`, bounded by
 * `JWT_PUBLIC_KEY_PREVIOUS_UNTIL`. While the window is open the Worker verifiers still accept
 * tokens the old key signed (VM agents treat a 401 on their callback token as terminal), and both
 * JWKS documents publish the old key so VM agents and federated verifiers keep validating tokens
 * minted before the rotation.
 *
 * With none of the rotation variables set, behaviour is exactly the pre-rotation behaviour: one
 * key, kid `key-YYYY-MM`.
 */
import type { Env } from '../env';

// Legacy key ID format: key-YYYY-MM, fixed at module load. Used whenever JWT_KEY_ID is unset.
export const LEGACY_JWT_KEY_ID = `key-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

// Audiences for different token types
export const TERMINAL_AUDIENCE = 'workspace-terminal';
export const CALLBACK_AUDIENCE = 'workspace-callback';
export const NODE_MANAGEMENT_AUDIENCE = 'node-management';
export const PORT_ACCESS_AUDIENCE = 'port-access';
export const LOCAL_FORWARD_AUDIENCE = 'local-forward';

/**
 * Get the JWT issuer URL from environment.
 * Derives from BASE_DOMAIN per constitution principle XI (no hardcoded values).
 */
export function getIssuer(env: Env): string {
  return `https://api.${env.BASE_DOMAIN}`;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** kid stamped on tokens signed with the current key, and published for it in /.well-known/jwks.json. */
export function currentJwtKeyId(env: Env): string {
  return nonEmpty(env.JWT_KEY_ID) ?? LEGACY_JWT_KEY_ID;
}

// An explicit offset is required: an ISO-8601 instant without one is local time, and the
// Worker's local time is not something an operator can reason about.
const ISO_8601_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Parse `JWT_PUBLIC_KEY_PREVIOUS_UNTIL`; null when absent, empty, or not an ISO-8601 instant. */
export function parsePreviousJwtKeyUntil(value: string | undefined): number | null {
  const raw = nonEmpty(value);
  if (!raw || !ISO_8601_INSTANT.test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export interface PreviousJwtKey {
  /** SPKI PEM of the previous public key. */
  publicKeyPem: string;
  /** kid published for the previous key in /.well-known/jwks.json. */
  kid: string;
  /** End of the overlap window (epoch ms, exclusive). */
  untilMs: number;
}

/**
 * The previous public key while its overlap window is open at `nowMs`, else null.
 *
 * Fails closed: an absent key, or an absent, empty or unparseable `JWT_PUBLIC_KEY_PREVIOUS_UNTIL`,
 * means the previous key is ignored entirely, so a rotation can never leave an unbounded overlap.
 */
export function activePreviousJwtKey(env: Env, nowMs: number): PreviousJwtKey | null {
  const publicKeyPem = nonEmpty(env.JWT_PUBLIC_KEY_PREVIOUS);
  if (!publicKeyPem) return null;
  const untilMs = parsePreviousJwtKeyUntil(env.JWT_PUBLIC_KEY_PREVIOUS_UNTIL);
  if (untilMs === null || nowMs >= untilMs) return null;
  return {
    publicKeyPem,
    kid: nonEmpty(env.JWT_PREVIOUS_KEY_ID) ?? LEGACY_JWT_KEY_ID,
    untilMs,
  };
}
