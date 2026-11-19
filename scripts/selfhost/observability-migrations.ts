/** Build-time projection; celld accepts one flat migration directory per database. */
import { SELFHOST_OBSERVABILITY_MIGRATIONS } from '../../apps/api/src/selfhost/observability-migrations.js';
import { appendSelfhostMigrations } from './selfhost-migrations.js';

/** Called after celld-project creates OBSERVABILITY_DATABASE's shared migration links. */
export function appendSelfhostObservabilityMigrations(
  apiDir: string,
  observabilityMigrationDir: string
): void {
  appendSelfhostMigrations(apiDir, observabilityMigrationDir, SELFHOST_OBSERVABILITY_MIGRATIONS);
}
