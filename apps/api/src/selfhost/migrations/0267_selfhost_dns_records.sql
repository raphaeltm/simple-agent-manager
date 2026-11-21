-- The box's own DNS zone (selfhost/dns/, served by the sam-dns sidecar, deploy/selfhost/sam-dns).
--
-- Self-host only: listed in selfhost/dns-migrations.ts and linked after the shared migrations by
-- the self-host packager. Cloudflare deployments never apply it; their records live in the
-- Cloudflare zone.
--
-- One row per (name, type). `name` is a lowercase fully qualified name inside BASE_DOMAIN with no
-- trailing dot. The TTL is not stored: sam-dns serves every synced record with its own TTL
-- (SAM_DNS_TTL), so a long TTL is one setting on the box, not a column to keep consistent.
--
-- selfhost_dns_zone holds one row, the zone serial. Every write bumps it in the same D1 batch,
-- so sam-dns re-reads the records only when they changed (GET /api/self-host/gateway/dns-records).
-- Fresh installs and upgrades: additive only (IF NOT EXISTS, INSERT OR IGNORE). No triggers (they
-- would count in meta.changes).
CREATE TABLE IF NOT EXISTS selfhost_dns_records (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('A')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_selfhost_dns_records_name_type
  ON selfhost_dns_records(name, type);

CREATE TABLE IF NOT EXISTS selfhost_dns_zone (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  serial INTEGER NOT NULL
);

INSERT OR IGNORE INTO selfhost_dns_zone (id, serial) VALUES (1, 1);
