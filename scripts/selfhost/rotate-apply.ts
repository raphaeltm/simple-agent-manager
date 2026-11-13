/**
 * The one way `rotate` changes what the Worker runs with: a patch over the newest bundle, sealed,
 * recorded in the journal BEFORE the file is written (so a crash can never leave an unrecorded
 * bundle that a later step would treat as the base), deployed, adopted and checked.
 *
 * A step interrupted after recording resumes by deploying the recorded bundle again (the deploy
 * and the adoption are idempotent) instead of sealing new values: a key value that may already
 * be in use is never thrown away.
 */
import type { Secrets } from '../../deploy/selfhost/key-agent/bundle.ts';
import type { RotatableKey } from './rotate-catalog';
import type { Journal, Phase, RotationStore, StepState } from './rotate-store';

export interface RotateDeps {
  log: (message: string) => void;
  now: () => number;
  /** Takes the pre-rotation backup; returns where, or null when skipped. */
  backup: () => string | null;
  /** `pnpm selfhost:deploy` (it runs with the newest bundle). */
  deploy: () => Promise<void>;
  /** celld adopts the deployment now; the first request to it must be healthy. */
  adoptAndCheck: () => Promise<{ healthy: boolean; detail: string }>;
  /** Recreates the containers that read gateway.env (Caddy, frps, sam-mx when running). */
  restartGatewayConsumers: () => Promise<void>;
  /** POST to the Worker's key-rotation control endpoint, signed with `controlKey`. */
  control: (controlKey: string, body: Record<string, unknown>) => Promise<unknown>;
  /** GET a Worker path on loopback (JWKS, VAPID public key). */
  getJson: (path: string) => Promise<{ status: number; body: unknown }>;
  /** HTTP status the Worker answers frps's plugin call with this gateway secret. */
  probeGateway: (secret: string) => Promise<number>;
}

export interface Patch {
  set?: Readonly<Record<string, string>>;
  remove?: readonly string[];
}

export interface StepContext {
  journal: Journal;
  step: StepState;
  key: RotatableKey;
  store: RotationStore;
  deps: RotateDeps;
  stateDir: string;
  save: () => void;
}

export class ApplyFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyFailedError';
  }
}

export function patched(base: Secrets, patch: Patch): Secrets {
  const next: Secrets = { ...base, ...(patch.set ?? {}) };
  for (const name of patch.remove ?? []) delete next[name];
  return next;
}

/** Applies `patch`, or resumes the one already recorded; on success the step is in `then`. */
export async function applyPatch(ctx: StepContext, patch: Patch, then: Phase): Promise<void> {
  const { step, store, deps } = ctx;
  let bundleId =
    step.phase === 'staging' && step.stagedFor === then ? step.stagedBundleId : undefined;
  if (bundleId && !store.hasBundle(bundleId)) bundleId = undefined;
  if (bundleId) {
    const head = await store.head();
    if (head.bundle.bundleId !== bundleId) {
      throw new ApplyFailedError(
        `the bundle this step recorded (${bundleId}) is no longer the newest (${head.bundle.bundleId}); something else sealed a bundle meanwhile`
      );
    }
    deps.log(`  resuming: deploying the recorded bundle ${bundleId} again`);
  } else {
    const { secrets } = await store.head();
    const bundle = await store.seal(patched(secrets, patch));
    step.stagedFrom = step.phase === 'staging' ? step.stagedFrom : step.phase;
    step.stagedBundleId = bundle.bundleId;
    step.stagedFor = then;
    step.phase = 'staging';
    ctx.save();
    store.write(bundle);
    bundleId = bundle.bundleId;
  }
  await deps.deploy();
  const check = await deps.adoptAndCheck();
  if (!check.healthy) throw new ApplyFailedError(`the new version is not healthy: ${check.detail}`);
  step.phase = then;
  delete step.stagedBundleId;
  delete step.stagedFor;
  delete step.stagedFrom;
  ctx.save();
  for (const removed of store.prune([bundleId])) deps.log(`  removed old bundle ${removed}`);
}
