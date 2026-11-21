/**
 * `rotate` steps for keys whose old value protects no stored data: `swap`, `gateway` and the JWT
 * `overlap`. Each verifies what the Worker actually serves after the change and, if that fails,
 * restores the old values from the step's sealed snapshot (rotate-store.ts) and redeploys.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Secrets } from '../../deploy/selfhost/key-agent/bundle.ts';
import { DNS_ENV_FILE, renderDnsEnv } from './dns-settings';
import { ApplyFailedError, applyPatch, type Patch, type StepContext } from './rotate-apply';
import { jwtKeyId } from './rotate-catalog';
import { replacePrivateFile } from './secret-files';

export const GATEWAY_SECRET = 'REVERSE_TUNNEL_GATEWAY_SECRET';
export const GATEWAY_ALTERNATE = 'REVERSE_TUNNEL_GATEWAY_SECRET_ALTERNATE';
export const JWT_OVERLAP_NAMES = [
  'JWT_KEY_ID',
  'JWT_PUBLIC_KEY_PREVIOUS',
  'JWT_PREVIOUS_KEY_ID',
  'JWT_PUBLIC_KEY_PREVIOUS_UNTIL',
] as const;
/** The Worker's callback-token lifetime when CALLBACK_TOKEN_EXPIRY_MS is unset (services/jwt.ts). */
export const DEFAULT_CALLBACK_TOKEN_LIFETIME_MS = 24 * 3_600_000;
/**
 * The latest point in a workspace callback token's life at which a VM agent offers it for
 * renewal: the top of the ratio range the agent accepts (WORKSPACE_CALLBACK_TOKEN_REFRESH_RATIO,
 * MaxWorkspaceCallbackTokenRefreshRatio in packages/vm-agent/internal/config/callback_token_renewal.go).
 */
export const MAX_AGENT_RENEWAL_RATIO = 0.9;
export const JWT_OVERLAP_MARGIN_HOURS = 1;

/**
 * How long the Worker still accepts callback tokens signed with the old key, unless
 * --jwt-overlap-hours says otherwise. Nodes get a new-key token on their next heartbeat
 * (shouldRefreshCallbackToken refreshes a non-current kid), but a VM agent offers a workspace
 * callback token for renewal only once it has used MAX_AGENT_RENEWAL_RATIO of its lifetime at
 * the latest, so the overlap covers that point of the deployed lifetime (the bundle's
 * CALLBACK_TOKEN_EXPIRY_MS, else the Worker default) plus a margin: 23 h with the defaults.
 * Terminal, port and local-forward tokens never use the old key. 0 is a hard cut: running nodes
 * lose their control-plane connection and must be replaced.
 */
export function defaultJwtOverlapHours(bundle: Readonly<Record<string, string>>): number {
  const configured = Number.parseInt(bundle.CALLBACK_TOKEN_EXPIRY_MS ?? '', 10);
  const lifetimeMs =
    Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CALLBACK_TOKEN_LIFETIME_MS;
  return Math.ceil((lifetimeMs * MAX_AGENT_RENEWAL_RATIO) / 3_600_000) + JWT_OVERLAP_MARGIN_HOURS;
}

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
  // A replacer function: a `$` in the value must not be read as a replacement pattern.
  const next = text.replace(line, () => `${GATEWAY_SECRET}=${secret}`);
  if (next === text) return false;
  replacePrivateFile(path, next);
  return true;
}

async function expectGateway(ctx: StepContext, secret: string, accepted: boolean, what: string) {
  const status = await ctx.deps.probeGateway(secret);
  // Only the plugin's documented answers prove anything: 200 (authenticated verdict) or 401
  // (refused before authentication). A 5xx after authentication is not acceptance.
  if (status !== 200 && status !== 401) {
    throw new ApplyFailedError(
      `the gateway probe for the ${what} secret answered HTTP ${status}, expected 200 or 401`
    );
  }
  if ((status === 200) !== accepted) {
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
  // `always`: on a resumed rollback gateway.env may already hold the old value while the restart
  // that should have loaded it failed, so restart regardless of whether the file changed.
  const restoreConsumers = async (always: boolean) => {
    const snapshot = await ctx.store.readSnapshot(ctx.journal.id, key.name);
    const changed = writeGatewayEnv(ctx, snapshot[GATEWAY_SECRET] ?? '');
    if (changed || always) await deps.restartGatewayConsumers();
  };
  // A recorded failure that has not reached `rolled-back` is a rollback the run did not finish
  // (restoring the consumers failed, or the process stopped): finish it rather than carry on.
  if (isResumingRollback(ctx) || (step.error !== undefined && step.phase !== 'rolled-back')) {
    await restoreConsumers(true);
    return await rollBack(ctx, names, step.error ?? 'interrupted');
  }
  // Outside the rollback catch: a failure before the snapshot exists changed nothing, so the step
  // stays pending and a resume simply starts it again.
  if (step.phase === 'pending') await snapshotOnce(ctx);
  try {
    if (
      step.phase === 'pending' ||
      (step.phase === 'staging' && step.stagedFor === 'accepting-both')
    ) {
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
    // Record the rollback before touching gateway.env: if restoring the consumers fails, a
    // resume must finish the rollback, not verify the new secret and mark the step done.
    step.error = message(error);
    ctx.save();
    await restoreConsumers(false);
    await rollBack(ctx, names, step.error);
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
 * Checks the deployed overlap and records its deadline (`step.waitUntil`). The Worker publishes
 * only the current key: VM agents and relying parties never trust the old one (it is accepted
 * only for callback tokens, by the Worker itself). Throws when the JWKS or the deadline is wrong.
 */
async function recordOverlapDeadline(ctx: StepContext): Promise<void> {
  const head = (await ctx.store.head()).secrets;
  const kids = await jwksKids(ctx);
  if (kids.length !== 1 || kids[0] !== head.JWT_KEY_ID) {
    throw new ApplyFailedError(
      `the JWKS publishes ${kids.join(', ') || 'nothing'}, expected only ${head.JWT_KEY_ID}`
    );
  }
  const until = head.JWT_PUBLIC_KEY_PREVIOUS_UNTIL;
  if (!until || !Number.isFinite(Date.parse(until))) {
    throw new ApplyFailedError('the deployed bundle has no valid JWT_PUBLIC_KEY_PREVIOUS_UNTIL');
  }
  ctx.step.waitUntil = until;
  ctx.save();
}

/**
 * Resuming an overlap bundle that was sealed but whose deploy never finished: the deadline
 * sealed into it started running at sealing time, while the box was offline. Deploying it as
 * recorded could install an already-expired previous key and retire it at once, cutting off
 * nodes whose callback tokens the old key signed. Reseal it with the deadline counted from now,
 * keeping its key pair (the new key may already have signed tokens if the deploy got that far).
 * Returns true when the step was rolled back instead.
 */
async function reanchorStagedOverlap(
  ctx: StepContext,
  overlapHours: number,
  names: string[]
): Promise<boolean> {
  const { step, store, deps } = ctx;
  if (!step.stagedBundleId || !(await store.hasBundle(step.stagedBundleId))) return false;
  const head = await store.head();
  // Another bundle sealed meanwhile: applyPatch refuses that, as before.
  if (head.bundle.bundleId !== step.stagedBundleId) return false;
  const until = deps.now() + overlapHours * 3_600_000;
  const sealed = Date.parse(head.secrets.JWT_PUBLIC_KEY_PREVIOUS_UNTIL ?? '');
  if (Number.isFinite(sealed) && sealed >= until) return false;
  delete step.stagedBundleId; // seal a fresh bundle on top of the recorded one
  ctx.save();
  try {
    await applyPatch(
      ctx,
      { set: { JWT_PUBLIC_KEY_PREVIOUS_UNTIL: new Date(until).toISOString() } },
      'waiting'
    );
    await recordOverlapDeadline(ctx);
  } catch (error) {
    await rollBack(ctx, names, message(error));
    return true;
  }
  return false;
}

/**
 * New key pair with its own kid; the old public key stays accepted (and published) until
 * JWT_PUBLIC_KEY_PREVIOUS_UNTIL. `rotate --resume` after that time removes it.
 */
export async function advanceOverlap(ctx: StepContext, overlapHours: number): Promise<void> {
  const { step, key, deps } = ctx;
  const names = [...key.secrets, ...JWT_OVERLAP_NAMES];
  if (isResumingRollback(ctx)) return await rollBack(ctx, names, step.error ?? 'interrupted');
  if (step.phase === 'staging' && step.stagedFor === 'waiting') {
    if (await reanchorStagedOverlap(ctx, overlapHours, names)) return;
  }
  if (step.phase === 'pending' || (step.phase === 'staging' && step.stagedFor === 'waiting')) {
    const base =
      step.phase === 'pending'
        ? await snapshotOnce(ctx)
        : await ctx.store.readSnapshot(ctx.journal.id, key.name);
    const pair = key.generate();
    const until = new Date(deps.now() + overlapHours * 3_600_000).toISOString();
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
      await recordOverlapDeadline(ctx);
    } catch (error) {
      return await rollBack(ctx, names, message(error));
    }
  }
  if (step.phase === 'waiting' && !Number.isFinite(Date.parse(step.waitUntil ?? ''))) {
    // Stopped after the overlap deployed but before its deadline was recorded: finish that check
    // now. Never read a missing deadline as "past", which would retire the old key unverified
    // and cut off nodes still holding callback tokens it signed.
    await recordOverlapDeadline(ctx);
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

const DNS_SECRET = 'SAM_DNS_TSIG_SECRET';

function dnsEnvPath(ctx: StepContext): string {
  return join(ctx.stateDir, DNS_ENV_FILE);
}

/** dns.env rendered exactly as the deploy writes it, for `secret`; true when it changed. */
function writeDnsEnv(ctx: StepContext, secret: string): boolean {
  const path = dnsEnvPath(ctx);
  const next = renderDnsEnv(secret);
  if (existsSync(path) && readFileSync(path, 'utf8') === next) return false;
  replacePrivateFile(path, next);
  return true;
}

async function expectDnsUpdate(ctx: StepContext, secret: string, want: 'accepted' | 'refused') {
  const got = await ctx.deps.probeDnsUpdate(secret);
  if (got !== want) {
    throw new ApplyFailedError(
      `sam-dns ${got} an update signed with the ${want === 'accepted' ? 'new' : 'old'} TSIG key`
    );
  }
}

/**
 * The TSIG key Caddy signs its RFC 2136 updates to sam-dns with. Nothing stored depends on it and
 * the Worker never uses it: new bundle, dns.env rewritten, Caddy and sam-dns restarted together
 * (they read it only at start), then the new key must be accepted and the old one refused.
 */
export async function advanceDnsKey(ctx: StepContext): Promise<void> {
  const { step, key, deps } = ctx;
  const restoreConsumers = async (always: boolean) => {
    const snapshot = await ctx.store.readSnapshot(ctx.journal.id, key.name);
    const old = snapshot[DNS_SECRET];
    const changed = old ? writeDnsEnv(ctx, old) : false;
    if (changed || always) await deps.restartDnsConsumers();
  };
  if (isResumingRollback(ctx) || (step.error !== undefined && step.phase !== 'rolled-back')) {
    await restoreConsumers(true);
    return await rollBack(ctx, key.secrets, step.error ?? 'interrupted');
  }
  if (step.phase === 'pending') await snapshotOnce(ctx);
  try {
    if (step.phase === 'pending' || step.phase === 'staging') {
      await applyPatch(ctx, { set: key.generate() }, 'switched');
    }
    if (step.phase === 'switched' && !deps.dnsProfileActive()) {
      // --init stores a key on every box; without the dns profile nothing uses it, so there is
      // no consumer to restart and no sam-dns to probe. The new key is in the bundle for when
      // the profile is turned on (the next deploy writes dns.env from it).
      deps.log('  the dns profile is off: the new TSIG key is stored, nothing reads it yet');
      step.phase = 'done';
      ctx.save();
      return;
    }
    if (step.phase === 'switched') {
      writeDnsEnv(ctx, (await ctx.store.head()).secrets[DNS_SECRET] ?? '');
      deps.log('  restarting Caddy and sam-dns with the new TSIG key');
      await deps.restartDnsConsumers();
      step.phase = 'consumers-restarted';
      ctx.save();
    }
    if (step.phase === 'consumers-restarted') {
      const snapshot = await ctx.store.readSnapshot(ctx.journal.id, key.name);
      await expectDnsUpdate(ctx, (await ctx.store.head()).secrets[DNS_SECRET] ?? '', 'accepted');
      await expectDnsUpdate(ctx, snapshot[DNS_SECRET] ?? '', 'refused');
      step.phase = 'done';
      ctx.save();
    }
  } catch (error) {
    // Recorded before dns.env is touched: a resume finishes the rollback (as advanceGateway).
    step.error = message(error);
    ctx.save();
    await restoreConsumers(false);
    await rollBack(ctx, key.secrets, step.error);
  }
}
