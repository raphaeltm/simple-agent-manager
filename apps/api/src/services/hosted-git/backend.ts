/**
 * The SAM-native repository backend: one answer to "which `Env.ARTIFACTS` does this install use?".
 *
 * - `ARTIFACTS_ENABLED !== 'true'`: none.
 * - A Cloudflare Artifacts binding is present: that binding. This is every Cloudflare deployment.
 * - Otherwise, the fallback backend the self-host build registered, if any. The Cloudflare build
 *   registers none, so on Cloudflare the result is exactly the binding or null.
 *
 * The self-host build (`apps/api/src/selfhost/`, never imported by `src/index.ts`) registers SAM's own
 * git server here. This module holds only the selection, so the Cloudflare bundle carries no
 * hosted-git implementation.
 *
 * Every caller that needs the backend goes through `resolveArtifactsBackend`, so the capability
 * flag, project creation, browsing, git tokens and deletion cannot disagree.
 */
import type { Env } from '../../env';

export type ArtifactsBackend = NonNullable<Env['ARTIFACTS']>;

/** Builds the fallback backend for an install with no Artifacts binding, or returns null. */
export type ArtifactsBackendFallback = (env: Env) => ArtifactsBackend | null;

let fallback: ArtifactsBackendFallback | null = null;

/**
 * Installs the backend used when Artifacts is enabled but no Cloudflare binding exists. Called once
 * at module load by the self-host build. Passing null removes it (tests).
 */
export function registerArtifactsBackendFallback(factory: ArtifactsBackendFallback | null): void {
  fallback = factory;
}

/** The backend this install uses for SAM-native repositories, or null when it has none. */
export function resolveArtifactsBackend(env: Env): ArtifactsBackend | null {
  if (env.ARTIFACTS_ENABLED !== 'true') return null;
  if (env.ARTIFACTS) return env.ARTIFACTS;
  return fallback?.(env) ?? null;
}

/** Whether this install can create and serve SAM-native (Artifacts) repositories. */
export function isArtifactsAvailable(env: Env): boolean {
  return resolveArtifactsBackend(env) !== null;
}
