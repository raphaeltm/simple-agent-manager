import { decodeJwt } from 'jose';

import type { Env } from '../env';

/**
 * Staleness guard for VM-agent → control-plane DESTRUCTIVE callbacks (S2).
 *
 * Instant (cf-container) sessions recover by replacing a dead container with a
 * NEW generation under the SAME nodeId. Callback tokens are stateless RS256 JWTs
 * with no jti/revocation, minted fresh per cold wake, so a superseded (dead)
 * container's token stays valid. A mid-turn rollout can make the OLD container
 * fire a fire-and-forget `error` / `failed` callback that lands AFTER the DO has
 * recovered a new container to running. Left unguarded, that late callback
 * regresses the freshly recovered, healthy session to error/failed.
 *
 * We reject a destructive callback only when it is provably OLDER than a
 * completed D1 reconciliation of the target row: the row's `updated_at` (written
 * by the Durable Object recovery via `persistRuntimeRecovered` /
 * `persistRuntimeRecovering`) is newer than the callback token's `iat` by more
 * than a configurable freshness margin.
 *
 * Fail-open by construction: any ambiguity (non-Instant runtime, missing iat,
 * unparseable timestamp, gap within the margin) PROCESSES the callback, so a
 * genuinely crashed CURRENT container still fails its session (requirement #2).
 */

/**
 * Default freshness margin (ms). Chosen to sit comfortably ABOVE the worst-case
 * same-generation gap (a recovered container mints its token just BEFORE the
 * snapshot restore that later writes `updated_at`, so its own genuine later
 * error has an `updated_at - iat` gap bounded by the restore duration — a few
 * seconds) yet BELOW a typical superseded-container lifetime (a real user turn),
 * so a stale generation's callback is reliably rejected.
 */
export const DEFAULT_INSTANT_STALE_CALLBACK_MARGIN_MS = 60_000;

export function getInstantStaleCallbackMarginMs(env: Env): number {
  const raw = env.INSTANT_STALE_CALLBACK_MARGIN_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_INSTANT_STALE_CALLBACK_MARGIN_MS;
}

/**
 * Read the `iat` (issued-at) claim from an ALREADY-VERIFIED callback token and
 * return it in milliseconds. The token MUST have been verified by
 * `verifyCallbackToken` first — `decodeJwt` does not verify the signature; it is
 * used here only to read a claim `verifyCallbackToken` does not surface.
 *
 * Returns null when the token cannot be decoded or has no numeric `iat`.
 */
export function callbackTokenIssuedAtMs(token: string): number | null {
  try {
    const claims = decodeJwt(token);
    return typeof claims.iat === 'number' ? claims.iat * 1000 : null;
  } catch {
    return null;
  }
}

export interface SupersededInstantCallbackInput {
  /** Runtime of the node backing the target row (`nodes.runtime`). */
  runtime: string | null | undefined;
  /** ISO-8601 `updated_at` of the D1 row a completed recovery reconciles. */
  rowUpdatedAt: string | null | undefined;
  /** Callback token `iat` in ms (see {@link callbackTokenIssuedAtMs}). */
  tokenIssuedAtMs: number | null;
  /** Freshness margin in ms (see {@link getInstantStaleCallbackMarginMs}). */
  marginMs: number;
}

/**
 * True when a destructive callback provably originates from a superseded Instant
 * container generation (older than a completed recovery). See file header.
 */
export function isSupersededInstantCallback(input: SupersededInstantCallbackInput): boolean {
  // Only Instant (cf-container) has the same-nodeId generation-replacement race.
  // VM-runtime nodes never swap generations under a still-valid old token.
  if (input.runtime !== 'cf-container') return false;
  // Cannot establish the token's generation age → fail open (process the error).
  if (input.tokenIssuedAtMs === null) return false;
  if (!input.rowUpdatedAt) return false;
  const rowMs = Date.parse(input.rowUpdatedAt);
  if (!Number.isFinite(rowMs)) return false;
  // Reconciliation strictly newer than the token by more than the margin ⇒ a
  // recovery completed after this token's generation cold-woke ⇒ superseded.
  return rowMs > input.tokenIssuedAtMs + input.marginMs;
}
