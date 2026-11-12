/**
 * SandboxDO turns a retryable 503 startup answer whose underlying engine error can never resolve
 * (runtime not installed, Docker socket proxy refusal, engine or image gone) into the SDK's own
 * permanent-failure answer, so the Sandbox client stops its ~2 minute start retries.
 *
 * The SDK base class is replaced by a stand-in whose containerFetch answers exactly what
 * @cloudflare/sandbox 0.12.10 answers for an unrecognised startup error (sandbox.js
 * `containerFetch`, the "unrecognized_error" branch); the override under test is SAM's real class.
 */
import { describe, expect, it, vi } from 'vitest';

let baseAnswer: Response = new Response('ok');
let monitor: () => Promise<unknown> = () => new Promise(() => undefined);

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class {
    ctx: { container: { monitor(): Promise<unknown> } };
    constructor(ctx: { container: { monitor(): Promise<unknown> } }) {
      this.ctx = ctx;
    }
    // As @cloudflare/containers does on every start: call monitor() right after start(), then
    // answer the SDK's startup 503 once the port check finds the container not running.
    async containerFetch(): Promise<Response> {
      void this.ctx.container.monitor().catch(() => undefined);
      return baseAnswer;
    }
  },
}));

const { SandboxDO } = await import('../../../src/durable-objects/sandbox-do');
const { DEFAULT_ENGINE_EXIT_PROBE_MS, PERMANENT_STARTUP_MESSAGE, permanentEngineStartError } =
  await import('../../../src/services/sandbox-startup-errors');

/** The SDK's 503 for a startup error it does not recognise. */
function sdkStartup503(error: string): Response {
  return new Response(
    JSON.stringify({
      code: 'INTERNAL_ERROR',
      message: 'Container is starting. Please retry in a moment.',
      context: { phase: 'startup', error },
      httpStatus: 503,
      timestamp: new Date().toISOString(),
    }),
    { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '3' } }
  );
}

async function fetchThroughSubclass(
  answer: Response,
  exit: () => Promise<unknown> = () => new Promise(() => undefined)
): Promise<Response> {
  baseAnswer = answer;
  monitor = exit;
  const ctx = { container: { monitor: () => monitor() } };
  const instance = new (
    SandboxDO as unknown as new (
      ctx: unknown,
      env: unknown
    ) => {
      containerFetch(url: string): Promise<Response>;
    }
  )(ctx, {});
  return instance.containerFetch('http://container/api/execute');
}

describe('SandboxDO permanent container start failures', () => {
  it.each([
    'Create container failed with [400] unknown or invalid runtime name: runsc',
    'Create container failed with [403] sam-docker-proxy refused: HostConfig: Runtime must be runsc',
    'load image failed with [403] sam-docker-proxy refused: POST /images/load is not allowed',
    'connect to the container engine at /run/sam-docker-proxy/docker.sock: No such file or directory',
    'image celld-image:abc is not present in the container engine',
    'fence the container bridges: the fence container exited with 1',
  ])('answers 500 permanent for "%s"', async (error) => {
    const response = await fetchThroughSubclass(sdkStartup503(error));
    expect(response.status).toBe(500);
    const body = (await response.json()) as { message: string; context: { error: string } };
    expect(body.message).toBe(PERMANENT_STARTUP_MESSAGE);
    expect(body.context.error).toBe(error);
  });

  it.each([
    'Container is not listening on port 3000',
    'Container did not start after 8000ms',
    'Create container failed with [409] Conflict. The container name is already in use',
    'Network connection lost.',
  ])('leaves a transient startup error retryable: "%s"', async (error) => {
    const response = await fetchThroughSubclass(sdkStartup503(error));
    expect(response.status).toBe(503);
  });

  it('passes every non-startup answer through untouched', async () => {
    const ok = new Response('{"stdout":"hi"}', { status: 200 });
    expect(await fetchThroughSubclass(ok)).toBe(ok);
    const unavailable = new Response(
      '{"context":{"phase":"other","error":"unknown or invalid runtime name"}}',
      {
        status: 503,
      }
    );
    expect((await fetchThroughSubclass(unavailable)).status).toBe(503);
    const notJson = new Response('busy', { status: 503 });
    expect((await fetchThroughSubclass(notJson)).status).toBe(503);
  });

  // What celld 0.6.3 actually produces (seen on the prototype box): the SDK's 503 carries a
  // generic "the container is not running", and celld's real reason is only the rejection of
  // that run's ctx.container.monitor() promise (a later monitor() call is refused).
  it.each([
    'Create container failed with [403] sam-docker-proxy refused: HostConfig: Runtime must be runsc',
    'Create container failed with [400] Error response from daemon: unknown or invalid runtime name: runsc',
  ])('answers 500 when the container exit result is permanent: "%s"', async (exitError) => {
    const response = await fetchThroughSubclass(sdkStartup503('the container is not running'), () =>
      Promise.reject(exitError)
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as { message: string; context: { error: string } };
    expect(body.message).toBe(PERMANENT_STARTUP_MESSAGE);
    expect(body.context.error).toBe(exitError);
  });

  it('stays retryable while the container is still starting (no exit result within the probe)', async () => {
    vi.useFakeTimers();
    try {
      const pending = fetchThroughSubclass(sdkStartup503('the container is not running'));
      await vi.advanceTimersByTimeAsync(DEFAULT_ENGINE_EXIT_PROBE_MS);
      expect((await pending).status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays retryable for an exit that is not a permanent engine failure', async () => {
    expect(
      (
        await fetchThroughSubclass(sdkStartup503('the container is not running'), () =>
          Promise.reject(new Error('container exited with code 1'))
        )
      ).status
    ).toBe(503);
    expect(
      (await fetchThroughSubclass(sdkStartup503('x'), () => Promise.resolve(undefined))).status
    ).toBe(503);
  });

  it('only reads startup-phase errors', () => {
    expect(
      permanentEngineStartError({
        context: { phase: 'startup', error: 'Unknown Or Invalid Runtime Name: x' },
      })
    ).toBe('Unknown Or Invalid Runtime Name: x');
    expect(
      permanentEngineStartError({
        context: { phase: 'exec', error: 'unknown or invalid runtime name' },
      })
    ).toBeNull();
    expect(permanentEngineStartError(null)).toBeNull();
  });
});
