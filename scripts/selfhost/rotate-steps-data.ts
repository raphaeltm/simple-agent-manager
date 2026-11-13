/**
 * `rotate` steps for keys that protect stored data: `reencrypt` (ENCRYPTION_KEY and its
 * purpose-specific overrides) and `better-auth` (the BetterAuth secret).
 *
 *  1. Deploy a bundle with the new key current and the old one as `<NAME>_PREVIOUS` (and the
 *     rotation's control key). From here the Worker writes under the new key and reads both.
 *  2. Verify once to record the values that were already unreadable (the baseline: they are
 *     reported, never touched, and never count against the rotation).
 *  3. Migrate every value still under the old key, then verify; up to MAX_MIGRATE_ROUNDS.
 *  4. Wait until values the passes cannot reach have expired (ENCRYPTION_KEY only: interaction
 *     details in Durable Objects, bootstrap tokens in KV).
 *  5. Retire: verify again, right now, and remove `<NAME>_PREVIOUS` only if nothing is left
 *     under the old key (assertRetireProof). The old key also stays in the step's sealed
 *     snapshot until the operator deletes it.
 *
 * A failed verification rolls back the same way in reverse (old key current, new previous,
 * migrate, verify); if even that cannot be proven the step stops as `blocked` with both keys
 * still readable. Data is never left under a key the Worker cannot read.
 */
import { randomBytes } from 'node:crypto';

import { applyPatch, type Patch, type StepContext } from './rotate-apply';
import { type ControlCall, type PassTotals, rotationTargets, runPass } from './rotate-data';
import { message } from './rotate-steps';
import type { RowRef, StepState } from './rotate-store';

export const CONTROL_KEY = 'SAM_KEY_ROTATION_CONTROL_KEY';
export const MAX_MIGRATE_ROUNDS = 3;
/**
 * Values outside D1/R2 that expire on their own: ACP interaction details (InteractionStore DO,
 * DEFAULT_ACP_INTERACTION_MAX_DEADLINE_MS 4 h + DEFAULT_ACP_INTERACTION_SENSITIVE_PURGE_MS 1 h)
 * and bootstrap tokens (KV, BOOTSTRAP_TOKEN_TTL_SECONDS 15 min), plus a margin.
 */
export const DEFAULT_STORED_LIFETIME_MINUTES = 5 * 60 + 15;

const BA = {
  secret: 'BETTER_AUTH_SECRET',
  version: 'BETTER_AUTH_SECRET_VERSION',
  previous: 'BETTER_AUTH_SECRET_PREVIOUS',
  previousVersion: 'BETTER_AUTH_SECRET_PREVIOUS_VERSION',
} as const;

type Kind = 'aes' | 'better-auth';

function keyName(ctx: StepContext): string {
  return ctx.key.secrets[0] ?? '';
}

function previousNames(ctx: StepContext, kind: Kind): string[] {
  return kind === 'aes' ? [`${keyName(ctx)}_PREVIOUS`] : [BA.previous, BA.previousVersion];
}

function versionOf(value: string | undefined): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

async function forwardPatch(ctx: StepContext, kind: Kind): Promise<Patch> {
  const base = (await ctx.store.head()).secrets;
  const control = base[CONTROL_KEY] || randomBytes(32).toString('hex');
  const fresh = ctx.key.generate();
  if (kind === 'aes') {
    const name = keyName(ctx);
    const old = base[name];
    if (!old) throw new Error(`${name} is not in the sealed bundle`);
    const pins: Record<string, string> = {};
    if (name === 'ENCRYPTION_KEY') {
      // Behaviour-preserving pins: both fall back to ENCRYPTION_KEY when unset.
      if (!base.BETTER_AUTH_SECRET) pins.BETTER_AUTH_SECRET = old;
      if (!base.TOKEN_HASH_KEY) pins.TOKEN_HASH_KEY = old;
    }
    return { set: { ...pins, ...fresh, [`${name}_PREVIOUS`]: old, [CONTROL_KEY]: control } };
  }
  const old = base[BA.secret] || base.ENCRYPTION_KEY || '';
  const version = versionOf(base[BA.version]);
  return {
    set: {
      [BA.secret]: fresh[BA.secret] ?? '',
      [BA.version]: String(version + 1),
      [BA.previous]: old,
      ...(version > 0 ? { [BA.previousVersion]: String(version) } : {}),
      [CONTROL_KEY]: control,
    },
    remove: version > 0 ? [] : [BA.previousVersion],
  };
}

/** Old value current again, the new one previous: rollback is the same migration in reverse. */
async function reversePatch(ctx: StepContext, kind: Kind): Promise<Patch> {
  const head = (await ctx.store.head()).secrets;
  const snapshot = await ctx.store.readSnapshot(ctx.journal.id, ctx.key.name);
  if (kind === 'aes') {
    const name = keyName(ctx);
    return { set: { [name]: snapshot[name] ?? '', [`${name}_PREVIOUS`]: head[name] ?? '' } };
  }
  const version = versionOf(head[BA.version]);
  return {
    set: {
      [BA.secret]: snapshot[BA.secret] || snapshot.ENCRYPTION_KEY || '',
      [BA.version]: String(version + 1),
      [BA.previous]: head[BA.secret] ?? '',
      [BA.previousVersion]: String(version),
    },
  };
}

function withinBaseline(totals: PassTotals, baseline: StepState['baseline']): boolean {
  const known = baseline ?? { unreadable: 0, rows: [], complete: true };
  if (totals.unreadable > known.unreadable) return false;
  if (!known.complete) return true;
  const key = (r: RowRef) => `${r.location}\u0000${r.id}\u0000${r.column}`;
  const seen = new Set(known.rows.map(key));
  return totals.unreadableRows.every((row) => seen.has(key(row)));
}

async function controlCall(ctx: StepContext): Promise<ControlCall> {
  const control = (await ctx.store.head()).secrets[CONTROL_KEY];
  if (!control) throw new Error(`${CONTROL_KEY} is not in the deployed bundle`);
  return async (body) => await ctx.deps.control(control, body);
}

/** Migrate + verify rounds; sets `step.proof` and returns null, or returns why it failed. */
async function migrateUntilProven(
  ctx: StepContext,
  kind: Kind,
  tag: string
): Promise<string | null> {
  const { step, deps } = ctx;
  const call = await controlCall(ctx);
  const targets = await rotationTargets(call, kind);
  const pass = (label: string, mode: 'migrate' | 'verify') =>
    runPass(step, `${tag}:${label}`, targets, mode, call, ctx.save, deps.log);
  if (!step.baseline) {
    const first = await pass('verify:baseline', 'verify');
    step.baseline = {
      unreadable: first.unreadable,
      rows: first.unreadableRows,
      complete: first.unreadable <= first.unreadableRows.length,
    };
    ctx.save();
    if (first.unreadable > 0) {
      deps.log(
        `  ${first.unreadable} stored value(s) were already unreadable before the rotation; reported, left untouched`
      );
    }
  }
  let last: PassTotals | null = null;
  for (let round = (step.migrateRounds ?? 0) + 1; round <= MAX_MIGRATE_ROUNDS; round += 1) {
    const migrated = await pass(`migrate:${round}`, 'migrate');
    deps.log(`  round ${round}: ${migrated.migrated} value(s) re-encrypted`);
    step.migrateRounds = round;
    ctx.save();
    last = await pass(`verify:${round}`, 'verify');
    if (!withinBaseline(last, step.baseline)) {
      return `${last.unreadable} value(s) are unreadable under both keys (${step.baseline?.unreadable ?? 0} were before the rotation)`;
    }
    if (last.previous === 0) {
      step.proof = {
        at: new Date(deps.now()).toISOString(),
        current: last.current,
        unreadable: last.unreadable,
      };
      ctx.save();
      return null;
    }
  }
  return `${last?.previous ?? '?'} value(s) are still under the old key after ${MAX_MIGRATE_ROUNDS} rounds`;
}

/**
 * The guard: the old key leaves the Worker only after a complete verification, run now, found
 * nothing left under it and nothing newly unreadable. A value written under the old key after
 * the earlier proof (a restore, a writer the passes do not know) is migrated first.
 */
export async function assertRetireProof(ctx: StepContext, kind: Kind, tag: string): Promise<void> {
  const { step } = ctx;
  delete step.proof;
  step.migrateRounds = 0;
  ctx.save();
  const failure = await migrateUntilProven(ctx, kind, `${tag}:retire`);
  if (failure || !step.proof) {
    throw new Error(
      `refusing to retire the old key: ${failure ?? 'no verification proves every value reads under the new key'}`
    );
  }
}

function resetData(step: StepState): void {
  delete step.pass;
  delete step.cursors;
  delete step.finishedLocations;
  delete step.counts;
  delete step.proof;
  step.migrateRounds = 0;
}

export async function advanceData(
  ctx: StepContext,
  kind: Kind,
  waitMinutes: number
): Promise<void> {
  const { step, deps } = ctx;
  const tag = step.reverse ? 'reverse' : 'forward';
  if (step.phase === 'pending') {
    const head = await ctx.store.head();
    await ctx.store.writeSnapshot(ctx.journal.id, ctx.key.name, head.secrets);
  }
  if (step.phase === 'pending' || (step.phase === 'staging' && step.stagedFor === 'migrating')) {
    await applyPatch(
      ctx,
      step.reverse ? await reversePatch(ctx, kind) : await forwardPatch(ctx, kind),
      'migrating'
    );
    if (!step.reverse) step.switchedAt = new Date(deps.now()).toISOString();
    ctx.save();
    deps.log(`  ${ctx.key.name}: the Worker writes under the new value and reads both`);
  }
  if (step.phase === 'migrating') {
    const failure = await migrateUntilProven(ctx, kind, tag);
    if (failure) {
      step.error = failure;
      if (step.reverse) {
        step.phase = 'blocked';
        step.resumePhase = 'migrating';
        ctx.save();
        throw new Error(
          `${ctx.key.name}: rollback could not be proven (${failure}); both keys stay readable`
        );
      }
      deps.log(
        `  ${ctx.key.name} FAILED verification: ${failure}; rolling back by re-encrypting under the old value`
      );
      step.reverse = true;
      resetData(step);
      ctx.save();
      await applyPatch(ctx, await reversePatch(ctx, kind), 'migrating');
      return await advanceData(ctx, kind, waitMinutes);
    }
    const switched = Date.parse(step.switchedAt ?? new Date(deps.now()).toISOString());
    step.verifiedAt = new Date(deps.now()).toISOString();
    step.waitUntil = new Date(
      step.reverse || kind === 'better-auth' ? deps.now() : switched + waitMinutes * 60_000
    ).toISOString();
    step.phase = 'waiting';
    ctx.save();
  }
  const finalPhase = step.reverse ? 'rolled-back' : 'done';
  if (step.phase === 'waiting' || (step.phase === 'staging' && step.stagedFor === finalPhase)) {
    if (step.phase === 'waiting') {
      if (deps.now() < Date.parse(step.waitUntil ?? '')) return;
      try {
        await assertRetireProof(ctx, kind, tag);
      } catch (error) {
        step.phase = 'blocked';
        step.resumePhase = 'waiting';
        step.error = message(error);
        ctx.save();
        throw error;
      }
    }
    await applyPatch(ctx, { remove: previousNames(ctx, kind) }, finalPhase);
    deps.log(`  ${ctx.key.name}: the old value is retired from the Worker`);
  }
}
