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
import { DEFAULT_KEPT_BUNDLES } from './key-service';
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
  /**
   * Whether the box runs DNS on the box (the `dns` compose profile). Off, nothing reads the TSIG key
   * (no dns.env, no sam-dns), so a rotation only stores it. Keyed on the profile, not on sam-dns
   * running: with the profile on, a stopped sam-dns must fail the probe and roll back.
   */
  dnsProfileActive: () => boolean;
  /** Recreates the containers that read dns.env (Caddy, and sam-dns when running). */
  restartDnsConsumers: () => Promise<void>;
  /** Whether the running sam-dns accepts an RFC 2136 update signed with this TSIG key. */
  probeDnsUpdate: (secret: string) => Promise<'accepted' | 'refused'>;
  /** Waits `ms` (a short drain before a retirement); absent, such waits end the run instead. */
  sleep?: (ms: number) => Promise<void>;
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
  const next: Secrets = { ...base, ...patch.set };
  for (const name of patch.remove ?? []) delete next[name];
  return next;
}

/** A recorded staged bundle is current again (or made current), or the step stops. */
async function resumeStaged(ctx: StepContext, bundleId: string): Promise<void> {
  const { step, store, deps } = ctx;
  let head = await store.head();
  // Stopped after writing the staged bundle but before making it current: the bundle it was
  // sealed over is still current, so finish that step.
  if (head.bundle.bundleId !== bundleId && step.stagedOver === head.bundle.bundleId) {
    await store.makeCurrent(bundleId, head.bundle.bundleId);
    head = await store.head();
  }
  if (head.bundle.bundleId !== bundleId) {
    throw new ApplyFailedError(
      `the bundle this step recorded (${bundleId}) is no longer the current one (${head.bundle.bundleId}); something else sealed a bundle meanwhile`
    );
  }
  deps.log(`  resuming: deploying the recorded bundle ${bundleId} again`);
}

/** Seals the patch, records it in the journal, then writes it and makes it current. */
async function stageAndMakeCurrent(ctx: StepContext, patch: Patch, then: Phase): Promise<string> {
  const { step, store } = ctx;
  let current = await store.head();
  // A box without a head yet (bundle-head.ts) records one naming the current bundle first, so a
  // staged bundle written below can never become the date fallback's choice before it is made
  // current, and a resume always has a head to compare with.
  if (!current.basis) {
    await store.makeCurrent(current.bundle.bundleId, current.bundle.bundleId);
    current = await store.head();
  }
  const bundle = await store.seal(patched(current.secrets, patch));
  step.stagedFrom = step.phase === 'staging' ? step.stagedFrom : step.phase;
  step.stagedBundleId = bundle.bundleId;
  step.stagedFor = then;
  step.stagedOver = current.bundle.bundleId;
  step.phase = 'staging';
  ctx.save();
  // Writes it and makes it current (bundle-head.ts): the deploy runs with it whatever the clock.
  await store.write(bundle, current.basis);
  const nowCurrent = (await store.head()).bundle.bundleId;
  if (nowCurrent !== bundle.bundleId) {
    throw new ApplyFailedError(
      `the bundle just sealed (${bundle.bundleId}) is not the current one (${nowCurrent}); something else sealed a bundle meanwhile`
    );
  }
  return bundle.bundleId;
}

/** Applies `patch`, or resumes the one already recorded; on success the step is in `then`. */
export async function applyPatch(ctx: StepContext, patch: Patch, then: Phase): Promise<void> {
  const { step, store, deps } = ctx;
  let bundleId =
    step.phase === 'staging' && step.stagedFor === then ? step.stagedBundleId : undefined;
  if (bundleId && !(await store.hasBundle(bundleId))) bundleId = undefined;
  if (bundleId) {
    await resumeStaged(ctx, bundleId);
  } else {
    bundleId = await stageAndMakeCurrent(ctx, patch, then);
  }
  await deps.deploy();
  const check = await deps.adoptAndCheck();
  if (!check.healthy) throw new ApplyFailedError(`the new version is not healthy: ${check.detail}`);
  // The bundle this step replaced: the previous Worker version may still ask for it, and a clock
  // that moved back can rank it below older bundles, so it is kept by name (not by date).
  const replaced = step.stagedOver;
  step.phase = then;
  delete step.stagedBundleId;
  delete step.stagedFor;
  delete step.stagedFrom;
  delete step.stagedOver;
  ctx.save();
  const removed = await store.prune(replaced ? [bundleId, replaced] : [bundleId]);
  if (removed.length === 0) return;
  for (const id of removed) {
    deps.log(`  removed old bundle ${id} (the box keeps the newest ${DEFAULT_KEPT_BUNDLES})`);
  }
  ctx.journal.removedBundles = [...(ctx.journal.removedBundles ?? []), ...removed];
  ctx.save();
}
