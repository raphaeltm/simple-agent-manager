/**
 * The Worker's handlers on a sealed self-host box: each runs with the runtime secrets laid over
 * its env (runtime-secrets.ts), or not at all.
 */
import { log } from '../lib/logger';
import { KEY_ROTATION_PATH } from './key-rotation/control-auth';
import {
  type KeyAgentEnv,
  loadRuntimeSecrets,
  type RuntimeSecrets,
  RuntimeSecretsUnavailableError,
  withRuntimeSecrets,
} from './runtime-secrets';

function unavailableResponse(error: unknown): Response {
  const code = error instanceof RuntimeSecretsUnavailableError ? error.code : 'SECRETS_UNAVAILABLE';
  log.error('runtime_secrets.unavailable', {
    code,
    message: error instanceof Error ? error.message : String(error),
    action: 'rejected',
  });
  return Response.json(
    {
      error: 'SECRETS_UNAVAILABLE',
      code,
      message: 'This SAM install cannot reach its key agent. Check `docker compose ps key-agent`.',
    },
    { status: 503, headers: { 'retry-after': '5', 'cache-control': 'no-store' } }
  );
}

interface WorkerHandlers<E> {
  fetch?: (request: Request, env: E, ctx: ExecutionContext) => Response | Promise<Response>;
  scheduled?: (
    controller: ScheduledController,
    env: E,
    ctx: ExecutionContext
  ) => void | Promise<void>;
  email?: (message: ForwardableEmailMessage, env: E, ctx: ExecutionContext) => void | Promise<void>;
}

/** The Worker's handlers, each run with the runtime secrets or not at all. */
export function wrapWorker<E extends object>(worker: WorkerHandlers<E>): WorkerHandlers<E> {
  const wrapped: WorkerHandlers<E> = {};
  if (worker.fetch) {
    const inner = worker.fetch;
    wrapped.fetch = async (request, env, ctx) => {
      let secrets: RuntimeSecrets;
      try {
        secrets = await loadRuntimeSecrets(env as KeyAgentEnv);
      } catch (error) {
        return unavailableResponse(error);
      }
      const merged = withRuntimeSecrets(env, secrets);
      // The rotation's control path never reaches the app (key-rotation/control.ts). Loaded on
      // demand: the handler pulls in the passes and their dependencies, which no other request
      // (and no tool that loads this module, like the migration preflight) needs.
      if (new URL(request.url).pathname === KEY_ROTATION_PATH) {
        const control = await import('./key-rotation/control');
        return await control.handleKeyRotationRequest(
          request,
          merged as unknown as import('./key-rotation/control').KeyRotationEnv
        );
      }
      return await inner(request, merged, ctx);
    };
  }
  if (worker.scheduled) {
    const inner = worker.scheduled;
    wrapped.scheduled = async (controller, env, ctx) => {
      // Throws when unavailable: the cron run fails visibly instead of running without keys.
      const secrets = await loadRuntimeSecrets(env as KeyAgentEnv);
      await inner(controller, withRuntimeSecrets(env, secrets), ctx);
    };
  }
  if (worker.email) {
    const inner = worker.email;
    wrapped.email = async (message, env, ctx) => {
      const secrets = await loadRuntimeSecrets(env as KeyAgentEnv);
      await inner(message, withRuntimeSecrets(env, secrets), ctx);
    };
  }
  return wrapped;
}
