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
 * engine error names one of those failures into the SDK's own permanent-failure answer (500,
 * `INTERNAL_ERROR`), so the client stops retrying and the caller fails within seconds. celld
 * reports the engine error through the container's exit result (`ctx.container.monitor()`), not
 * in the SDK's 503 (which by then says "the container is not running"), so that is read too,
 * bounded to `DEFAULT_ENGINE_EXIT_PROBE_MS`. On
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

function matchesPermanent(error: string): boolean {
  const lower = error.toLowerCase();
  return PERMANENT_ENGINE_START_ERRORS.some((fragment) => lower.includes(fragment));
}

/** The engine error inside a 503 startup answer, when it is one a retry cannot fix. */
export function permanentEngineStartError(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { context } = body as StartupErrorBody;
  if (!context || context.phase !== 'startup' || typeof context.error !== 'string') return null;
  return matchesPermanent(context.error) ? context.error : null;
}

/** Default wait for a stopped container's exit result; celld answers at once for a failed start. */
export const DEFAULT_ENGINE_EXIT_PROBE_MS = 250;

/**
 * The container's own exit result, when it already holds a permanent start failure. celld
 * reports why a start failed (`Create container failed with [403] sam-docker-proxy refused: …`)
 * only through `ctx.container.monitor()`; by the time the SDK classifies the failure the message
 * has become a generic "the container is not running". Bounded: a container that is merely
 * starting has no exit result yet, and the probe gives up after `waitMs`.
 */
export async function permanentEngineExitError(
  container: { monitor(): Promise<unknown> } | undefined,
  waitMs = DEFAULT_ENGINE_EXIT_PROBE_MS
): Promise<string | null> {
  if (!container) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      container.monitor().then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs);
      }),
    ]);
    return outcome !== null && matchesPermanent(outcome) ? outcome : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function startupStatus(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  return (body as StartupErrorBody).context?.phase === 'startup';
}

/**
 * Rewrites a retryable 503 startup answer that is really permanent; anything else unchanged.
 * The engine error is read from the answer itself, or else from the container's exit result.
 */
export async function failFastOnPermanentStartup(
  response: Response,
  container?: { monitor(): Promise<unknown> }
): Promise<Response> {
  if (response.status !== 503) return response;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  if (!startupStatus(body)) return response;
  const engineError =
    permanentEngineStartError(body) ?? (await permanentEngineExitError(container));
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
