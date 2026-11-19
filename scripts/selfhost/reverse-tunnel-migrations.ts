/** Build-time projection; celld accepts one flat migration directory per database. */
import { REVERSE_TUNNEL_MIGRATIONS } from '../../apps/api/src/selfhost/reverse-tunnel-migrations.js';
import { appendSelfhostMigrations } from './selfhost-migrations.js';

/** Called after celld-project creates DATABASE's shared migration links. */
export function appendReverseTunnelMigrations(apiDir: string, databaseMigrationDir: string): void {
  appendSelfhostMigrations(apiDir, databaseMigrationDir, REVERSE_TUNNEL_MIGRATIONS);
}
