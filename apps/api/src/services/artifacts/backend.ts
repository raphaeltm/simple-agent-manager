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
 * flag, project creation, browsing and git tokens cannot disagree. Deletion uses the same
 * selection without the enable flag, so disabling the feature cannot orphan existing repositories.
 */
import type { Env } from '../../env';

export type ArtifactsBackend = NonNullable<Env['ARTIFACTS']>;
type ArtifactsRepo = Awaited<ReturnType<ArtifactsBackend['get']>>;

/** Preserve the native binding's RPC contract; fallback tokens can bind runtime identity. */
export function createArtifactsRuntimeToken(
  env: Env,
  repo: ArtifactsRepo,
  scope: 'read' | 'write',
  ttl: number,
  context: NonNullable<Parameters<ArtifactsRepo['createToken']>[2]>
): ReturnType<ArtifactsRepo['createToken']> {
  return env.ARTIFACTS ? repo.createToken(scope, ttl) : repo.createToken(scope, ttl, context);
}

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
  return resolveArtifactsBackendForCleanup(env);
}

/** Existing repositories still need cleanup after the feature is disabled. Never use for serving. */
export function resolveArtifactsBackendForCleanup(env: Env): ArtifactsBackend | null {
  return env.ARTIFACTS ?? fallback?.(env) ?? null;
}

/** Whether this install can create and serve SAM-native (Artifacts) repositories. */
export function isArtifactsAvailable(env: Env): boolean {
  return resolveArtifactsBackend(env) !== null;
}
