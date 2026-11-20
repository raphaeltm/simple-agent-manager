/** Durable ownership proof for the two renames that publish restored installation state. */
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { readRecord } from '../../deploy/selfhost/created-resources.mjs';
import type { BoxContext } from './backup-lib';
import { expectedComposeProjectFor, SELFHOST_ENVIRONMENT } from './install-record';
import { assertOperatorExecution } from './operator-only';
import { removePrivateTree } from './private-tree';
import { replacePrivateFile } from './secret-files';

type Context = Pick<BoxContext, 'stateDir' | 'envFile' | 'box'>;
interface Identity {
  device: string;
  inode: string;
}
interface Swap {
  version: 1;
  scope: string;
  installation: string;
  stage: string;
  stageIdentity: Identity;
  original: Identity;
  replacement: Identity;
}
function receipt(ctx: Context): string {
  return join(dirname(resolve(ctx.stateDir)), `.${basename(ctx.stateDir)}.rollback-state.json`);
}
function scope(ctx: Context): string {
  return JSON.stringify([
    resolve(ctx.stateDir),
    resolve(ctx.envFile),
    ctx.box.SAM_DOMAIN ?? '',
    ctx.box.CELLD_BUCKET ?? '',
  ]);
}
function identity(path: string): Identity | null {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return null;
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error('Rollback state swap refuses a replaced directory');
  return { device: String(info.dev), inode: String(info.ino) };
}
function same(left: Identity | null, right: Identity): boolean {
  return left?.device === right.device && left.inode === right.inode;
}
function isIdentity(value: unknown): value is Identity {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<Identity>;
  return (
    typeof v.device === 'string' &&
    /^\d+$/.test(v.device) &&
    typeof v.inode === 'string' &&
    /^\d+$/.test(v.inode)
  );
}
function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function assertParent(ctx: Context): void {
  const parent = dirname(resolve(ctx.stateDir));
  if (realpathSync(parent) !== parent)
    throw new Error('Rollback state swap refuses symlink parents');
}
function assertLedger(ctx: Context, path: string, id: string, expected: Identity): void {
  const record = readRecord(join(path, 'created-resources.json'));
  const active = record.resources.filter(
    (r) => r.cloud === 'box' && r.action === 'created' && !r.removedAt
  );
  const state = active.filter((r) => r.kind === 'state-dir');
  const install = active.filter((r) => r.kind === 'installation');
  if (
    state.length !== 1 ||
    state[0]?.name !== ctx.stateDir ||
    state[0]?.attributes?.installation !== id ||
    state[0]?.attributes?.device !== expected.device ||
    state[0]?.attributes?.inode !== expected.inode ||
    install.length !== 1 ||
    install[0]?.name !== id ||
    install[0]?.attributes?.domain !== (ctx.box.SAM_DOMAIN ?? '') ||
    install[0]?.attributes?.environment !== SELFHOST_ENVIRONMENT ||
    install[0]?.attributes?.composeProject !== expectedComposeProjectFor(ctx.box, ctx.stateDir, id)
  )
    throw new Error('Rollback state swap ownership or scope changed');
  let keys: unknown;
  try {
    keys = JSON.parse(readFileSync(join(path, 'platform-keys.json'), 'utf8'));
  } catch {
    throw new Error('Cannot verify rollback state swap installation');
  }
  if (
    !keys ||
    typeof keys !== 'object' ||
    !('SAM_INSTALLATION_ID' in keys) ||
    keys.SAM_INSTALLATION_ID !== id
  )
    throw new Error('Rollback state swap installation changed');
}

/** Run before any preflight reads state, including direct recovery/manual rollback calls. */
export function recoverRollbackState(ctx: Context): void {
  assertOperatorExecution();
  const path = receipt(ctx);
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return;
  assertParent(ctx);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.mode & 0o077 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error('Invalid rollback state swap receipt');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: unknown;
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.mode & 0o077 ||
      stat.dev !== info.dev ||
      stat.ino !== info.ino ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('Invalid rollback state swap receipt');
    raw = JSON.parse(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid rollback state swap receipt');
  const swap = raw as Partial<Swap>;
  if (
    swap.version !== 1 ||
    swap.scope !== scope(ctx) ||
    typeof swap.installation !== 'string' ||
    !/^[a-f0-9]{32}$/.test(swap.installation) ||
    typeof swap.stage !== 'string' ||
    dirname(swap.stage) !== dirname(resolve(ctx.stateDir)) ||
    !/^\.rollback-state-[a-zA-Z0-9]+$/.test(basename(swap.stage)) ||
    !isIdentity(swap.stageIdentity) ||
    !isIdentity(swap.original) ||
    !isIdentity(swap.replacement)
  )
    throw new Error('Invalid rollback state swap scope');
  const staged = join(swap.stage, 'restored');
  const previous = join(swap.stage, 'previous');
  const stage = identity(swap.stage);
  if (stage && !same(stage, swap.stageIdentity))
    throw new Error('Rollback state staging directory changed');
  let live = identity(ctx.stateDir);
  if (!live) {
    if (
      !stage ||
      !same(identity(previous), swap.original) ||
      !same(identity(staged), swap.replacement)
    )
      throw new Error('Cannot prove interrupted rollback state directories');
    assertLedger(ctx, previous, swap.installation, swap.original);
    renameSync(previous, ctx.stateDir);
    syncDirectory(swap.stage);
    syncDirectory(dirname(ctx.stateDir));
    live = identity(ctx.stateDir);
  }
  if (!same(live, swap.original) && !same(live, swap.replacement))
    throw new Error('Rollback state directory identity changed');
  assertLedger(ctx, ctx.stateDir, swap.installation, live as Identity);
  if (stage) {
    const old = identity(previous),
      next = identity(staged);
    if ((old && !same(old, swap.original)) || (next && !same(next, swap.replacement)))
      throw new Error('Rollback state staging contents changed');
    // Cleanup may itself be interrupted. Keep the receipt until cleanup and directory sync finish.
    removePrivateTree(swap.stage);
    syncDirectory(dirname(ctx.stateDir));
  }
  const current = lstatSync(path);
  if (current.dev !== info.dev || current.ino !== info.ino || !current.isFile())
    throw new Error('Rollback state swap receipt changed');
  rmSync(path);
  syncDirectory(dirname(path));
}

/** The caller already authenticated the snapshot and copied live ownership history into staged. */
export function publishRollbackState(ctx: Context, stage: string, id: string): void {
  assertOperatorExecution();
  assertParent(ctx);
  const staged = join(stage, 'restored');
  const original = identity(ctx.stateDir),
    replacement = identity(staged),
    stageIdentity = identity(stage);
  if (!original || !replacement || !stageIdentity)
    throw new Error('Missing rollback state directory');
  assertLedger(ctx, ctx.stateDir, id, original);
  const ledger = readRecord(join(staged, 'created-resources.json'));
  const state = ledger.resources.find(
    (r) => r.cloud === 'box' && r.kind === 'state-dir' && !r.removedAt
  );
  if (!state?.attributes) throw new Error('Missing rollback state ownership');
  state.attributes.device = replacement.device;
  state.attributes.inode = replacement.inode;
  replacePrivateFile(
    join(staged, 'created-resources.json'),
    `${JSON.stringify(ledger, null, 2)}\n`
  );
  assertLedger(ctx, staged, id, replacement);
  syncDirectory(stage);
  if (lstatSync(receipt(ctx), { throwIfNoEntry: false }))
    throw new Error('Rollback state swap already pending');
  const swap: Swap = {
    version: 1,
    scope: scope(ctx),
    installation: id,
    stage,
    stageIdentity,
    original,
    replacement,
  };
  replacePrivateFile(receipt(ctx), JSON.stringify(swap));
  if (
    !same(identity(ctx.stateDir), original) ||
    !same(identity(stage), stageIdentity) ||
    !same(identity(staged), replacement)
  )
    throw new Error('Rollback state swap directory identity changed before publication');
  renameSync(ctx.stateDir, join(stage, 'previous'));
  syncDirectory(stage);
  syncDirectory(dirname(ctx.stateDir));
  if (
    identity(ctx.stateDir) ||
    !same(identity(stage), stageIdentity) ||
    !same(identity(staged), replacement) ||
    !same(identity(join(stage, 'previous')), original)
  )
    throw new Error('Rollback state swap directory identity changed during publication');
  renameSync(staged, ctx.stateDir);
  syncDirectory(stage);
  syncDirectory(dirname(ctx.stateDir));
  recoverRollbackState(ctx);
}

/** A published intent owns cleanup; never delete the sole surviving original in a finally block. */
export function rollbackStatePending(ctx: Context): boolean {
  return Boolean(lstatSync(receipt(ctx), { throwIfNoEntry: false }));
}
