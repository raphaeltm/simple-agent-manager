-- Reverse-tunnel (frp) loopback port leases for managed nodes (services/node-reverse-tunnel-*.ts).
--
-- One row per node runtime incarnation that SAM provisioned with VM_AGENT_TRANSPORT='reverse-tunnel'.
-- The row is written BEFORE the provider VM is requested and is the authority the frps server plugin
-- checks: the node's frpc may only log in with the credential whose SHA-256 is stored here, and may
-- only bind `port`. node_id deliberately has NO foreign key (same reason as node_cloudflare_tunnels):
-- some paths hard-delete node rows, and the lease must stay visible until it is released.
--
-- Atomic allocation: the port is chosen and written by ONE INSERT ... SELECT, and the partial unique
-- index below makes two active leases on one port impossible even if two writers raced.
-- Release frees the port: status becomes 'released' (rows are never deleted). Released rows keep
-- their port for history and for least-recently-released port reuse.
--
-- Existing rows: none. Additive only; no triggers (D1 counts trigger writes in meta.changes, which
-- would break the compare-and-set writers of this table).
CREATE TABLE IF NOT EXISTS node_reverse_tunnel_leases (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  runtime_incarnation_id TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  credential_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  release_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  released_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_node_reverse_tunnel_leases_incarnation
  ON node_reverse_tunnel_leases(node_id, runtime_incarnation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_node_reverse_tunnel_leases_active_port
  ON node_reverse_tunnel_leases(port) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_node_reverse_tunnel_leases_port
  ON node_reverse_tunnel_leases(port, released_at);
CREATE INDEX IF NOT EXISTS idx_node_reverse_tunnel_leases_status
  ON node_reverse_tunnel_leases(status, node_id);
