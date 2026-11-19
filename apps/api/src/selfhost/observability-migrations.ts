/**
 * Paths relative to apps/api/src. The self-host packager appends these to
 * OBSERVABILITY_DATABASE's flat migration projection AFTER the shared observability SQL.
 * Never add them to wrangler.toml's observability `migrations_dir`: Cloudflare installs must not
 * create self-host-only tables. The filename matches the one the integration branch shipped in
 * the shared directory, so a box that already applied it records it as applied.
 */
export const SELFHOST_OBSERVABILITY_MIGRATIONS = [
  'selfhost/migrations/observability/0002_analytics_events.sql',
] as const;
