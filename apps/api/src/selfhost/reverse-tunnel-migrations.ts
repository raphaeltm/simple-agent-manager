/**
 * Paths relative to apps/api/src. The self-host packager appends these to DATABASE's
 * flat migration projection AFTER shared SQL. Never add them to wrangler.toml's directory.
 * A formerly deployed 0232 table is preserved by the additive IF NOT EXISTS DDL.
 */
export const REVERSE_TUNNEL_MIGRATIONS = [
  'selfhost/migrations/0255_node_reverse_tunnel_leases.sql',
] as const;
