/** Build-time projection; celld accepts one flat migration directory per database. */
import { existsSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Links self-host-only migrations (paths relative to apps/api/src) into a database's flat
 * migration directory AFTER its shared migrations. Re-running is a no-op; any other file with
 * the same name is a collision and fails the build.
 */
export function appendSelfhostMigrations(
  apiDir: string,
  migrationDir: string,
  migrations: readonly string[]
): void {
  for (const migration of migrations) {
    const source = resolve(apiDir, 'src', migration);
    const target = join(migrationDir, basename(migration));
    if (existsSync(target) || isSymlink(target)) {
      if (isSymlink(target) && readlinkSync(target) === source) continue;
      throw new Error(`Self-host migration filename collision: ${basename(migration)}`);
    }
    if (!existsSync(source)) throw new Error(`Missing self-host migration: ${basename(migration)}`);
    symlinkSync(source, target);
  }
}
