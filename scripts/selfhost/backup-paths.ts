/** Validate backup/restore filesystem boundaries before any mutation. */
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { BoxContext } from './backup-lib';
/** Refuse ambiguous paths before reading a bucket or changing any local/cloud state. */
export function assertOperationPaths(ctx: BoxContext): void {
  const paths = [ctx.stateDir, ctx.envFile, ctx.encryptionKeyFile]
    .filter((p): p is string => Boolean(p))
    .map((p) => resolve(p));
  const canonical = (path: string): void => {
    let current = path;
    while (!existsSync(current)) {
      const parent = dirname(current);
      if (parent === current) throw new Error('Invalid operation path');
      current = parent;
    }
    if (realpathSync(current) !== current || lstatSync(current).isSymbolicLink())
      throw new Error('Operation paths must not use symlinks');
  };
  paths.forEach(canonical);
  const state = resolve(ctx.stateDir);
  const repo = resolve(import.meta.dirname, '../..');
  const scratch = resolve(repo, '.tmp/selfhost-backups');
  if (
    [repo, homedir(), scratch].some(
      (protectedPath) => state === protectedPath || protectedPath.startsWith(`${state}/`)
    ) ||
    state === '/'
  ) {
    throw new Error('Unsafe installation state path');
  }
  for (let i = 0; i < paths.length; i++)
    for (let j = i + 1; j < paths.length; j++) {
      const left = paths[i] as string,
        right = paths[j] as string;
      if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`))
        throw new Error('State, environment and backup key paths must not overlap');
    }
}

/** Backup payload paths may never contain or live inside installation state/key paths. */
export function assertBackupOutside(ctx: BoxContext, path: string): void {
  const root = resolve(path);
  for (const value of [ctx.stateDir, ctx.envFile, ctx.encryptionKeyFile]) {
    if (!value) continue;
    const other = resolve(value);
    if (root === other || root.startsWith(`${other}/`) || other.startsWith(`${root}/`))
      throw new Error('Backup and installation paths must not overlap');
  }
}
