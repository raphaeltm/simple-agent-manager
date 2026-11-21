/** Build-time projection; celld accepts one flat migration directory per database. */
import { SELFHOST_DNS_MIGRATIONS } from '../../apps/api/src/selfhost/dns-migrations.js';
import { REVERSE_TUNNEL_MIGRATIONS } from '../../apps/api/src/selfhost/reverse-tunnel-migrations.js';
import { appendSelfhostMigrations } from './selfhost-migrations.js';

/** Called after celld-project creates DATABASE's shared migration links: self-host-only DATABASE tables. */
export function appendReverseTunnelMigrations(apiDir: string, databaseMigrationDir: string): void {
  appendSelfhostMigrations(apiDir, databaseMigrationDir, REVERSE_TUNNEL_MIGRATIONS);
  // The box's DNS zone (selfhost/dns/) lives in the same database.
  appendSelfhostMigrations(apiDir, databaseMigrationDir, SELFHOST_DNS_MIGRATIONS);
}
