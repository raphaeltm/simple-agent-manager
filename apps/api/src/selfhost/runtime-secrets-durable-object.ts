/**
 * Durable Objects on a sealed self-host box: the runtime secrets laid over each object's `env`,
 * bounded like the isolate's own copy (runtime-secrets.ts).
 */
import {
  cachedRuntimeSecrets,
  currentRuntimeSecrets,
  type KeyAgentEnv,
  loadRuntimeSecrets,
  refreshInBackground,
  type RuntimeSecrets,
  RuntimeSecretsUnavailableError,
} from './runtime-secrets';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a mixin constructor must accept any arguments
type DurableObjectClass = abstract new (...args: any[]) => object;

/**
 * A secret as a resident Durable Object reads it: this isolate's current copy, refreshed in the
 * background once due. Past SAM_RUNTIME_SECRETS_MAX_STALE_MS, or once the agent refused, the copy
 * is gone and the read throws, so the object's event fails closed (the loader's own rules).
 */
function residentSecret(env: KeyAgentEnv, name: string): string | undefined {
  const { secrets, ageMs, ttlMs, maxStaleMs } = currentRuntimeSecrets(env);
  if (!secrets || ageMs >= maxStaleMs) {
    refreshInBackground(env);
    throw new RuntimeSecretsUnavailableError(
      'SECRETS_EXPIRED',
      'runtime secrets are no longer available to this object'
    );
  }
  if (ageMs >= ttlMs) refreshInBackground(env);
  return secrets[name];
}

/** Lays the secrets over `merged` as getters (same override rule as withRuntimeSecrets). */
function defineResidentSecrets(
  merged: Record<string, unknown>,
  env: KeyAgentEnv & Record<string, unknown>,
  secrets: RuntimeSecrets
): void {
  for (const name of Object.keys(secrets)) {
    const existing = env[name];
    if (existing !== undefined && typeof existing !== 'string') continue;
    Object.defineProperty(merged, name, {
      configurable: true,
      enumerable: true,
      get: () => residentSecret(env, name),
    });
  }
}

/**
 * A Durable Object class whose instances see the runtime secrets in `env`. The constructor gets
 * a copy of the runtime's env; when this isolate already has the secrets they are in it before
 * the original constructor runs, otherwise `blockConcurrencyWhile` holds every event until they
 * are, and a failure there fails the object's events (fail closed). Each secret in `env` is a
 * getter over this isolate's copy, so a resident object follows the loader's bounds: refreshed
 * after SAM_RUNTIME_SECRETS_TTL_MS, and unreadable after SAM_RUNTIME_SECRETS_MAX_STALE_MS or a
 * refusal. A value the object copied out of `env` itself is not bounded.
 */
export function wrapDurableObject<C extends DurableObjectClass>(Base: C): C {
  // @ts-expect-error -- TS cannot type a mixin over an abstract constructor with a custom constructor
  class WithRuntimeSecrets extends Base {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forwards the runtime's arguments
    constructor(...args: any[]) {
      const [ctx, env] = args as [DurableObjectState, KeyAgentEnv & Record<string, unknown>];
      const hit = cachedRuntimeSecrets(env);
      const merged: Record<string, unknown> = { ...env };
      if (hit) defineResidentSecrets(merged, env, hit);
      super(ctx, merged, ...args.slice(2));
      if (!hit) {
        void ctx.blockConcurrencyWhile(async () => {
          defineResidentSecrets(merged, env, await loadRuntimeSecrets(env));
        });
      }
    }
  }
  return WithRuntimeSecrets as unknown as C;
}
