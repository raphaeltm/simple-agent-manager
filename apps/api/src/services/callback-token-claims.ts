/**
 * Claim readers for callback JWTs that `verifyCallbackToken` does not surface.
 *
 * Kept apart from `jwt.ts` (signing and verification) so the guards that read these
 * claims do not depend on the signer module. Every function here uses `decodeJwt`,
 * which does NOT verify the signature: callers must verify the token first.
 */
import { decodeJwt } from 'jose';

/**
 * Claim carried by a RENEWED workspace callback token: the `iat` (seconds) of the first
 * token in its renewal chain. Renewal must not move a token's generation forward, because
 * the Instant stale-callback guard compares the generation's issue time with the most
 * recent recovery (see `routes/_stale-callback-guard.ts`). First issuance omits the claim;
 * the token's own `iat` is then the generation.
 */
export const CALLBACK_TOKEN_GENERATION_ISSUED_AT_CLAIM = 'gen_iat';

function positiveIntegerClaim(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Generation issue time (seconds) of an already-verified callback token: the `gen_iat`
 * claim a renewal preserved, else the token's own `iat`. Null when neither is a positive
 * integer.
 */
export function callbackTokenGenerationIssuedAtSeconds(token: string): number | null {
  try {
    const claims = decodeJwt(token);
    return (
      positiveIntegerClaim(claims[CALLBACK_TOKEN_GENERATION_ISSUED_AT_CLAIM]) ??
      positiveIntegerClaim(claims.iat)
    );
  } catch {
    return null;
  }
}

/** `exp` (ms) of an already-verified callback token; null if absent. */
export function callbackTokenExpiresAtMs(token: string): number | null {
  try {
    const exp = positiveIntegerClaim(decodeJwt(token).exp);
    return exp === null ? null : exp * 1000;
  } catch {
    return null;
  }
}
