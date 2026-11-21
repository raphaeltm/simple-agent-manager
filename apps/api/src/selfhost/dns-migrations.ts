/**
 * Paths relative to apps/api/src. The self-host packager appends these to DATABASE's flat
 * migration projection AFTER shared SQL (scripts/selfhost/reverse-tunnel-migrations.ts). Never add
 * them to wrangler.toml's directory: the box's DNS zone does not exist on Cloudflare.
 */
export const SELFHOST_DNS_MIGRATIONS = ['selfhost/migrations/0267_selfhost_dns_records.sql'] as const;
