/**
 * D1 migrations that were applied under one file name and are now carried under another. A
 * ledger entry with the legacy name is the same migration as the current file, so it is neither
 * pending (d1-migration-safety.ts) nor newer than the source (installer-engine-adoption.ts).
 */
export interface D1MigrationAliasRepair {
  binding: string;
  table: string;
  legacyName: string;
  currentName: string;
  requiredColumns: readonly string[];
}

export const D1_MIGRATION_ALIAS_REPAIRS: readonly D1MigrationAliasRepair[] = [
  {
    binding: 'DATABASE',
    table: 'workspaces',
    legacyName: '0157_workspace_eviction_fencing.sql',
    currentName: '0164_workspace_eviction_fencing.sql',
    requiredColumns: ['eviction_generation', 'eviction_finalized_at', 'stop_runtime_confirmed_at'],
  },
] as const;
