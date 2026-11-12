/**
 * Permanent container-engine start failures for the Sandbox SDK (used by SandboxDO).
 *
 * When a container cannot start, the SDK's `containerFetch` answers 503 ("Container is starting,
 * retry") for every error it does not recognise, and its client retries a 503 for about two
 * minutes. On celld (self-hosted guided login) a start fails for reasons that never resolve on
 * retry: the OCI runtime is not registered with Docker (`unknown or invalid runtime name: runsc`),
 * the Docker socket proxy refused the call, the engine is unreachable, or the image is gone. The
 * prototype box showed "Preparing secure sign-in…" for 137 s before such a session failed.
 *
 * `containerFetch` is the SDK's documented override point (the SDK itself overrides Container's).
 * This class lets the SDK decide first and only rewrites a 503 startup answer whose underlying
 * error names one of those engine failures into the SDK's own permanent-failure answer (500,
 * `INTERNAL_ERROR`), so the client stops retrying and the caller fails within seconds. On
 * Cloudflare those messages never occur and every answer passes through unchanged.
 */
import { log } from '../lib/logger';

/** Lower-case fragments of container-engine start errors that a retry cannot fix. */
export const PERMANENT_ENGINE_START_ERRORS: readonly string[] = [
  // Docker: the class names a runtime the daemon does not have (gVisor not installed).
  'unknown or invalid runtime name',
  // deploy/selfhost/docker-proxy: the call is outside what celld may ask of Docker.
  'sam-docker-proxy refused',
  // celld: no engine (or no proxy) behind DOCKER_HOST.
  'connect to the container engine',
  // celld: the image is neither in the engine nor in the bucket.
  'is not present in the container engine',
  'is not in the bucket',
  // celld: the node could not fence its bridges, so it runs no container.
  'fence the container bridges',
  // celld: the daemon refused the container create as invalid or forbidden.
  'create container failed with [400]',
  'create container failed with [403]',
];

/** The message the SDK uses for its own permanent startup failures (and the caller matches). */
export const PERMANENT_STARTUP_MESSAGE =
  'Container failed to start due to a permanent error. Check your container configuration.';

interface StartupErrorBody {
  code?: unknown;
  message?: unknown;
  context?: { phase?: unknown; error?: unknown } | null;
}

/** The engine error inside a 503 startup answer, when it is one a retry cannot fix. */
export function permanentEngineStartError(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { context } = body as StartupErrorBody;
  if (!context || context.phase !== 'startup' || typeof context.error !== 'string') return null;
  const error = context.error.toLowerCase();
  return PERMANENT_ENGINE_START_ERRORS.some((fragment) => error.includes(fragment))
    ? context.error
    : null;
}

/** Rewrites a retryable 503 startup answer that is really permanent; anything else unchanged. */
export async function failFastOnPermanentStartup(response: Response): Promise<Response> {
  if (response.status !== 503) return response;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  const engineError = permanentEngineStartError(body);
  if (!engineError) return response;
  log.error('sandbox.container_start_permanent_failure', { error: engineError.slice(0, 500) });
  return new Response(
    JSON.stringify({
      code: 'INTERNAL_ERROR',
      message: PERMANENT_STARTUP_MESSAGE,
      context: { phase: 'startup', error: engineError },
      httpStatus: 500,
      timestamp: new Date().toISOString(),
      suggestion:
        'This error will not resolve with retries. Check the container runtime on the host.',
    }),
    { status: 500, headers: { 'Content-Type': 'application/json' } }
  );
}
