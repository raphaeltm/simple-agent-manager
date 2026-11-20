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
/** A wait up to this long is waited out in the run; a longer one ends the run until `--resume`. */
export const MAX_IN_RUN_WAIT_MS = 15 * 60_000;
/**
 * Values outside D1/R2 that expire on their own: ACP interaction details (InteractionStore DO,
 * DEFAULT_ACP_INTERACTION_MAX_DEADLINE_MS 4 h + DEFAULT_ACP_INTERACTION_SENSITIVE_PURGE_MS 1 h)
 * and bootstrap tokens (KV, BOOTSTRAP_TOKEN_TTL_SECONDS 15 min), plus a margin. The floor of the
 * wait: an install that raised those settings waits for what its Worker reports instead.
 */
export const DEFAULT_STORED_LIFETIME_MINUTES = 5 * 60 + 15;
/** Added to the lifetime the Worker reports (clock skew, a value written just after the switch). */
export const STORED_LIFETIME_MARGIN_MINUTES = 15;

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
      if (!base.BETTER_AUTH_SECRET || base.BETTER_AUTH_SECRET === old) {
        pins.BETTER_AUTH_SECRET = old;
        // The old value keeps signing sessions until better-auth-secret replaces it; rotate-run.ts
        // chains that step, and the summary says so while it is not done.
        ctx.step.signInSecretPinned = true;
      }
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
  const attempted = versionOf(head[BA.version]);
  // The old secret goes back under its own version: tokens still enveloped as `$ba$<that>$`
  // (the ones the forward migration could not move) must keep a matching key. Only an
  // unversioned original (bare-hex tokens, read with the current secret as legacy) gets a new one.
  const original = versionOf(snapshot[BA.version]);
  return {
    set: {
      [BA.secret]: snapshot[BA.secret] || snapshot.ENCRYPTION_KEY || '',
      [BA.version]: String(original > 0 ? original : attempted + 1),
      [BA.previous]: head[BA.secret] ?? '',
      [BA.previousVersion]: String(attempted),
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
  let round = step.migrateRounds ?? 0;
  // A run that stopped after a round's migrate was recorded finishes that round's verify first
  // (runPass resumes it from its cursors), instead of starting the next round: in the last round
  // that would verify nothing and roll back a migration that had in fact completed.
  let verifyRecordedRound = round > 0;
  for (;;) {
    if (!verifyRecordedRound) {
      round += 1;
      if (round > MAX_MIGRATE_ROUNDS) break;
      const migrated = await pass(`migrate:${round}`, 'migrate');
      deps.log(`  round ${round}: ${migrated.migrated} value(s) re-encrypted`);
      step.migrateRounds = round;
      ctx.save();
    }
    verifyRecordedRound = false;
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
  // A fresh, complete pass every time: never resume a retire verification from cursors an
  // earlier run left, which would skip locations checked hours ago.
  resetData(step);
  ctx.save();
  const failure = await migrateUntilProven(ctx, kind, `${tag}:retire`);
  if (failure || !step.proof) {
    throw new Error(
      `refusing to retire the old key: ${failure ?? 'no verification proves every value reads under the new key'}`
    );
  }
}

/**
 * How long to wait after the switch before retiring an ENCRYPTION_KEY-family key: the operator's
 * --stored-lifetime-minutes when given, else the larger of the default and what the deployed
 * Worker reports from its own settings (control.ts `unreachableValueLifetimeMs`), plus a margin.
 */
async function storedLifetimeMinutes(ctx: StepContext, explicit: number | null): Promise<number> {
  if (explicit !== null) return explicit;
  const call = await controlCall(ctx);
  const status = (await call({ op: 'status', purpose: 'stored-lifetime' }).catch(() => null)) as {
    unreachableValueLifetimeMs?: unknown;
  } | null;
  const reported = status?.unreachableValueLifetimeMs;
  if (typeof reported !== 'number' || !Number.isFinite(reported) || reported <= 0) {
    // Fail closed: retiring the old key early would make values outside D1/R2 unreadable.
    throw new Error(
      'the Worker did not report how long values outside D1/R2 live; run rotate --resume again, or set the wait with --stored-lifetime-minutes'
    );
  }
  return Math.max(
    DEFAULT_STORED_LIFETIME_MINUTES,
    Math.ceil(reported / 60_000) + STORED_LIFETIME_MARGIN_MINUTES
  );
}

/** Nodes whose tunnel credential is still derived from the old key (reported, see control.ts). */
async function recordLegacyTunnelLeases(ctx: StepContext): Promise<void> {
  const { step, deps } = ctx;
  const call = await controlCall(ctx);
  const status = (await call({ op: 'status', before: step.switchedAt })) as {
    legacyTunnelLeases?: unknown;
  };
  const count = typeof status.legacyTunnelLeases === 'number' ? status.legacyTunnelLeases : null;
  step.legacyTunnelLeases = count;
  ctx.save();
  if (count === null) {
    deps.log('  WARNING: could not count reverse-tunnel nodes created before the switch');
  } else if (count > 0) {
    deps.log(
      `  WARNING: ${count} reverse-tunnel node(s) created before the switch keep a tunnel credential derived from the old ENCRYPTION_KEY: whoever holds that key and an old backup can still log in to frps as them. Replace them (delete each node; SAM provisions new ones on demand).`
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
  /** aes only: minutes to wait after the switch; null derives it (storedLifetimeMinutes). */
  waitMinutes: number | null,
  /**
   * The least time between the switch and the retirement: a request that started on the
   * previous deployment still finishes on it (celld) and may write under the old value, so the
   * old value stays readable until every such request is past its handler budget.
   */
  drainMinutes: number
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
    if (step.reverse) step.reverseSwitchedAt = new Date(deps.now()).toISOString();
    else step.switchedAt = new Date(deps.now()).toISOString();
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
      step.reverseSwitchedAt = new Date(deps.now()).toISOString();
      ctx.save();
      return await advanceData(ctx, kind, waitMinutes, drainMinutes);
    }
    // A rollback drains from its own (reverse) deployment: requests still running on the forward
    // deployment may write under the new value until then.
    const anchor = step.reverse ? step.reverseSwitchedAt : step.switchedAt;
    const switched = Date.parse(anchor ?? new Date(deps.now()).toISOString());
    step.verifiedAt = new Date(deps.now()).toISOString();
    // Requests still running on the other deployment can write under the value being retired
    // until the drain ends, and such a write to KV or a Durable Object (no pass reaches those)
    // lives for the stored-value lifetime after it: the old value stays readable for both,
    // added, in either direction (a rollback retires the new value the same way). BetterAuth's
    // values all live in D1, which the retire proof re-reads, so it needs only the drain.
    const lifetime = kind === 'better-auth' ? 0 : await storedLifetimeMinutes(ctx, waitMinutes);
    const waitFor = drainMinutes + lifetime;
    step.waitUntil = new Date(switched + waitFor * 60_000).toISOString();
    step.phase = 'waiting';
    ctx.save();
  }
  const finalPhase = step.reverse ? 'rolled-back' : 'done';
  if (step.phase === 'waiting' || (step.phase === 'staging' && step.stagedFor === finalPhase)) {
    if (step.phase === 'waiting') {
      const remaining = Date.parse(step.waitUntil ?? '') - deps.now();
      // A short wait (the request drain) is waited out in this run; a long one needs a resume.
      if (remaining > 0 && (!deps.sleep || remaining > MAX_IN_RUN_WAIT_MS)) return;
      if (remaining > 0 && deps.sleep) {
        deps.log(
          `  ${ctx.key.name}: waiting ${Math.ceil(remaining / 1000)} s for requests still running on the previous version`
        );
        await deps.sleep(remaining);
      }
    }
    // Proven right before the old key leaves, also when resuming an interrupted retire.
    try {
      await assertRetireProof(ctx, kind, tag);
    } catch (error) {
      step.phase = 'blocked';
      step.resumePhase = 'waiting';
      step.error = message(error);
      ctx.save();
      throw error;
    }
    if (kind === 'aes' && keyName(ctx) === 'ENCRYPTION_KEY' && !step.reverse) {
      await recordLegacyTunnelLeases(ctx);
    }
    await applyPatch(ctx, { remove: previousNames(ctx, kind) }, finalPhase);
    deps.log(`  ${ctx.key.name}: the old value is retired from the Worker`);
  }
}
