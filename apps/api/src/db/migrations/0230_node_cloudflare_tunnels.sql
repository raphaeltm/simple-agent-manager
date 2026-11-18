-- Managed-node Cloudflare Tunnel ownership journal (services/node-tunnel-*.ts).
--
-- One row per node runtime incarnation that SAM gave a remotely configured named tunnel.
-- The row is written BEFORE any Cloudflare or provider-VM mutation so a crash, timeout or
-- lost response can always be reconciled from it, and it is the cleanup authority:
-- node_id deliberately has NO foreign key, because several paths hard-delete node rows
-- (rejected allocations, owner deletion) and the tunnel/DNS identity must outlive them
-- until Cloudflare confirms deletion. Rows end in status 'cleaned'; nothing deletes them.
--
-- Existing rows: none. Additive only; legacy vm-public-dns nodes never get a row.
CREATE TABLE IF NOT EXISTS node_cloudflare_tunnels (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  runtime_incarnation_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  tunnel_name TEXT NOT NULL,
  tunnel_id TEXT,
  hostname TEXT NOT NULL,
  dns_record_id TEXT,
  status TEXT NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'active', 'cleanup_pending', 'cleaned')),
  cleanup_reason TEXT,
  cleanup_attempts INTEGER NOT NULL DEFAULT 0,
  cleanup_next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cleaned_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_node_cloudflare_tunnels_incarnation
  ON node_cloudflare_tunnels(node_id, runtime_incarnation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_node_cloudflare_tunnels_name
  ON node_cloudflare_tunnels(tunnel_name);
CREATE INDEX IF NOT EXISTS idx_node_cloudflare_tunnels_cleanup_due
  ON node_cloudflare_tunnels(status, cleanup_next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_node_cloudflare_tunnels_node
  ON node_cloudflare_tunnels(node_id);
