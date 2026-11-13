/**
 * `rotate` steps for keys whose old value protects no stored data: `swap`, `gateway` and the JWT
 * `overlap`. Each verifies what the Worker actually serves after the change and, if that fails,
 * restores the old values from the step's sealed snapshot (rotate-store.ts) and redeploys.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Secrets } from '../../deploy/selfhost/key-agent/bundle.ts';
import { ApplyFailedError, applyPatch, type Patch, type StepContext } from './rotate-apply';
import { jwtKeyId } from './rotate-catalog';
import { writePrivateFile } from './secret-files';

export const GATEWAY_SECRET = 'REVERSE_TUNNEL_GATEWAY_SECRET';
export const GATEWAY_ALTERNATE = 'REVERSE_TUNNEL_GATEWAY_SECRET_ALTERNATE';
export const JWT_OVERLAP_NAMES = [
  'JWT_KEY_ID',
  'JWT_PUBLIC_KEY_PREVIOUS',
  'JWT_PREVIOUS_KEY_ID',
  'JWT_PUBLIC_KEY_PREVIOUS_UNTIL',
] as const;
/** Callback tokens live 24 h (CALLBACK_TOKEN_EXPIRY_MS) and are re-signed after half of it. */
export const DEFAULT_JWT_OVERLAP_HOURS = 25;

/** Sets `names` back to their snapshot values; names the snapshot lacks are removed. */
export function restorePatch(snapshot: Secrets, names: readonly string[]): Patch {
  const set: Record<string, string> = {};
  const remove: string[] = [];
  for (const name of names) {
    if (snapshot[name] !== undefined) set[name] = snapshot[name];
    else remove.push(name);
  }
  return { set, remove };
}

/** Restores `names` from the snapshot and marks the step rolled back (resumable). */
export async function rollBack(ctx: StepContext, names: readonly string[], reason: string) {
  const { step, store, journal, deps } = ctx;
  step.error = reason;
  ctx.save();
  deps.log(`  ${ctx.key.name} FAILED: ${reason}; restoring the previous values`);
  const snapshot = await store.readSnapshot(journal.id, ctx.key.name);
  await applyPatch(ctx, restorePatch(snapshot, names), 'rolled-back');
  deps.log(`  ${ctx.key.name}: rolled back, the box runs with its previous values`);
}

async function snapshotOnce(ctx: StepContext): Promise<Secrets> {
  const head = await ctx.store.head();
  await ctx.store.writeSnapshot(ctx.journal.id, ctx.key.name, head.secrets);
  return head.secrets;
}

function isResumingRollback(ctx: StepContext): boolean {
  return ctx.step.phase === 'staging' && ctx.step.stagedFor === 'rolled-back';
}

async function vapidServed(ctx: StepContext): Promise<string | null> {
  const expected = (await ctx.store.head()).secrets.VAPID_PUBLIC_KEY;
  const { status, body } = await ctx.deps.getJson('/api/config/vapid-public-key');
  const served = (body as { publicKey?: unknown } | null)?.publicKey;
  return status === 200 && served === expected
    ? null
    : `the Worker serves another VAPID key (HTTP ${status})`;
}

export async function advanceSwap(ctx: StepContext): Promise<void> {
  const { step, key } = ctx;
  if (isResumingRollback(ctx)) return await rollBack(ctx, key.secrets, step.error ?? 'interrupted');
  if (step.phase === 'pending' || step.phase === 'staging') {
    if (step.phase === 'pending') await snapshotOnce(ctx);
    try {
      await applyPatch(ctx, { set: key.generate() }, 'switched');
    } catch (error) {
      return await rollBack(ctx, key.secrets, message(error));
    }
  }
  if (step.phase === 'switched') {
    const problem = key.name === 'vapid-keys' ? await vapidServed(ctx) : null;
    if (problem) return await rollBack(ctx, key.secrets, problem);
    step.phase = 'done';
    ctx.save();
  }
}

function gatewayEnvPath(ctx: StepContext): string {
  return join(ctx.stateDir, 'gateway.env');
}

/** gateway.env with only the secret's value replaced, byte-for-byte as the deploy renders it. */
function writeGatewayEnv(ctx: StepContext, secret: string): boolean {
  const path = gatewayEnvPath(ctx);
  if (!existsSync(path)) throw new ApplyFailedError(`${path} is missing: run pnpm selfhost:deploy`);
  const text = readFileSync(path, 'utf8');
  const line = new RegExp(`^${GATEWAY_SECRET}=.*$`, 'm');
  if (!line.test(text)) throw new ApplyFailedError(`${path} has no ${GATEWAY_SECRET} line`);
  const next = text.replace(line, `${GATEWAY_SECRET}=${secret}`);
  if (next === text) return false;
  writePrivateFile(path, next);
  return true;
}

async function expectGateway(ctx: StepContext, secret: string, accepted: boolean, what: string) {
  const status = await ctx.deps.probeGateway(secret);
  if ((status !== 401) !== accepted) {
    throw new ApplyFailedError(
      `the Worker ${accepted ? 'refused' : 'still accepts'} the ${what} gateway secret (HTTP ${status})`
    );
  }
}

/**
 * 1. Worker accepts old and new (ALTERNATE). 2. gateway.env gets the new value and frps, Caddy
 * and sam-mx restart (each side now sends the new value; the Worker accepts it). 3. Worker
 * accepts only the new value. No moment where the two sides disagree.
 */
export async function advanceGateway(ctx: StepContext): Promise<void> {
  const { step, key, deps } = ctx;
  const names = [GATEWAY_SECRET, GATEWAY_ALTERNATE];
  const restoreConsumers = async () => {
    const snapshot = await ctx.store.readSnapshot(ctx.journal.id, key.name);
    if (writeGatewayEnv(ctx, snapshot[GATEWAY_SECRET] ?? '')) await deps.restartGatewayConsumers();
  };
  if (isResumingRollback(ctx)) {
    await restoreConsumers();
    return await rollBack(ctx, names, step.error ?? 'interrupted');
  }
  try {
    if (
      step.phase === 'pending' ||
      (step.phase === 'staging' && step.stagedFor === 'accepting-both')
    ) {
      if (step.phase === 'pending') await snapshotOnce(ctx);
      await applyPatch(
        ctx,
        { set: { [GATEWAY_ALTERNATE]: key.generate()[GATEWAY_SECRET] ?? '' } },
        'accepting-both'
      );
    }
    const snapshot = await ctx.store.readSnapshot(ctx.journal.id, key.name);
    const oldSecret = snapshot[GATEWAY_SECRET] ?? '';
    if (step.phase === 'accepting-both') {
      const next = (await ctx.store.head()).secrets[GATEWAY_ALTERNATE] ?? '';
      await expectGateway(ctx, next, true, 'new');
      await expectGateway(ctx, oldSecret, true, 'current');
      writeGatewayEnv(ctx, next);
      deps.log('  restarting Caddy, frps and sam-mx with the new gateway secret');
      await deps.restartGatewayConsumers();
      step.phase = 'consumers-restarted';
      ctx.save();
    }
    if (
      step.phase === 'consumers-restarted' ||
      (step.phase === 'staging' && step.stagedFor === 'switched')
    ) {
      const head = (await ctx.store.head()).secrets;
      const next = head[GATEWAY_ALTERNATE] ?? head[GATEWAY_SECRET] ?? '';
      await applyPatch(
        ctx,
        { set: { [GATEWAY_SECRET]: next }, remove: [GATEWAY_ALTERNATE] },
        'switched'
      );
    }
    if (step.phase === 'switched') {
      const current = (await ctx.store.head()).secrets[GATEWAY_SECRET] ?? '';
      await expectGateway(ctx, current, true, 'new');
      await expectGateway(ctx, oldSecret, false, 'old');
      step.phase = 'done';
      ctx.save();
    }
  } catch (error) {
    await restoreConsumers();
    await rollBack(ctx, names, message(error));
  }
}

/** The kid the old key's tokens carry when the box never set one: jwt-keys.ts's legacy kid. */
export function legacyJwtKeyId(nowMs: number): string {
  const date = new Date(nowMs);
  return `key-${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function jwksKids(ctx: StepContext): Promise<string[]> {
  const { status, body } = await ctx.deps.getJson('/.well-known/jwks.json');
  const keys = (body as { keys?: Array<{ kid?: unknown }> } | null)?.keys ?? [];
  if (status !== 200) throw new ApplyFailedError(`/.well-known/jwks.json answered HTTP ${status}`);
  return keys.map((k) => String(k.kid));
}

/**
 * New key pair with its own kid; the old public key stays accepted (and published) until
 * JWT_PUBLIC_KEY_PREVIOUS_UNTIL. `rotate --resume` after that time removes it.
 */
export async function advanceOverlap(ctx: StepContext, overlapHours: number): Promise<void> {
  const { step, key, deps } = ctx;
  const names = [...key.secrets, ...JWT_OVERLAP_NAMES];
  if (isResumingRollback(ctx)) return await rollBack(ctx, names, step.error ?? 'interrupted');
  if (step.phase === 'pending' || (step.phase === 'staging' && step.stagedFor === 'waiting')) {
    const base =
      step.phase === 'pending'
        ? await snapshotOnce(ctx)
        : await ctx.store.readSnapshot(ctx.journal.id, key.name);
    const pair = key.generate();
    const until = new Date(deps.now() + overlapHours * 3600_000).toISOString();
    try {
      await applyPatch(
        ctx,
        {
          set: {
            ...pair,
            JWT_KEY_ID: jwtKeyId(pair.JWT_PUBLIC_KEY ?? ''),
            JWT_PUBLIC_KEY_PREVIOUS: base.JWT_PUBLIC_KEY ?? '',
            JWT_PREVIOUS_KEY_ID: base.JWT_KEY_ID || legacyJwtKeyId(deps.now()),
            JWT_PUBLIC_KEY_PREVIOUS_UNTIL: until,
          },
        },
        'waiting'
      );
      const head = (await ctx.store.head()).secrets;
      const kids = await jwksKids(ctx);
      for (const kid of [head.JWT_KEY_ID, head.JWT_PREVIOUS_KEY_ID]) {
        if (!kids.includes(kid ?? ''))
          throw new ApplyFailedError(
            `the JWKS does not publish kid ${kid} (it publishes ${kids.join(', ') || 'nothing'})`
          );
      }
      step.waitUntil = head.JWT_PUBLIC_KEY_PREVIOUS_UNTIL;
      ctx.save();
    } catch (error) {
      return await rollBack(ctx, names, message(error));
    }
  }
  if (step.phase === 'waiting' || (step.phase === 'staging' && step.stagedFor === 'done')) {
    if (step.phase === 'waiting' && deps.now() < Date.parse(step.waitUntil ?? '')) return;
    await applyPatch(
      ctx,
      {
        remove: ['JWT_PUBLIC_KEY_PREVIOUS', 'JWT_PREVIOUS_KEY_ID', 'JWT_PUBLIC_KEY_PREVIOUS_UNTIL'],
      },
      'done'
    );
    deps.log('  jwt-keys: the previous key is no longer accepted or published');
  }
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
