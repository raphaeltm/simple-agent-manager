/** Build-time projection; celld accepts one flat migration directory per database. */
import { existsSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { REVERSE_TUNNEL_MIGRATIONS } from '../../apps/api/src/selfhost/reverse-tunnel-migrations.js';

/** Called after celld-project creates DATABASE's shared migration links. */
export function appendReverseTunnelMigrations(apiDir: string, databaseMigrationDir: string): void {
  for (const migration of REVERSE_TUNNEL_MIGRATIONS) {
    const source = resolve(apiDir, 'src', migration);
    const target = join(databaseMigrationDir, basename(migration));
    if (existsSync(target) || (() => { try { return lstatSync(target).isSymbolicLink(); } catch { return false; } })()) {
      if (lstatSync(target).isSymbolicLink() && readlinkSync(target) === source) continue;
      throw new Error(`Self-host migration filename collision: ${basename(migration)}`);
    }
    if (!existsSync(source)) throw new Error(`Missing self-host migration: ${basename(migration)}`);
    symlinkSync(source, target);
  }
}
