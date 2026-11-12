/**
 * SandboxDO: the Sandbox SDK's Durable Object, with permanent container-engine start failures
 * reported as permanent.
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
 * reports the engine error only as the rejection of the run's `ctx.container.monitor()` promise,
 * not in the SDK's 503 (which by then says "the container is not running"), so the latest monitor
 * promise is teed at construction and read too, bounded to `DEFAULT_ENGINE_EXIT_PROBE_MS`. On
 * Cloudflare those messages never occur and every answer passes through unchanged.
 */
import { Sandbox } from '@cloudflare/sandbox';

import type { Env } from '../env';
import {
  failFastOnPermanentStartup,
  teeContainerMonitor,
} from '../services/sandbox-startup-errors';

export class SandboxDO extends Sandbox<Env> {
  /** The latest run's `ctx.container.monitor()` promise (see `teeContainerMonitor`). */
  private lastStartExit: Promise<unknown> | null = null;

  constructor(ctx: ConstructorParameters<typeof Sandbox<Env>>[0], env: Env) {
    super(ctx, env);
    teeContainerMonitor(ctx.container, (exit) => {
      this.lastStartExit = exit;
    });
  }

  override async containerFetch(
    ...args: Parameters<Sandbox<Env>['containerFetch']>
  ): Promise<Response> {
    return failFastOnPermanentStartup(await super.containerFetch(...args), this.lastStartExit);
  }
}
