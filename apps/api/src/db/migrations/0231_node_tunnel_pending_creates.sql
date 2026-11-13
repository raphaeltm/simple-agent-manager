-- Journal external mutation intent before POST. A lost response or process death cannot
-- establish absence; keep cleanup reconciliation scheduled until the request is settled.
ALTER TABLE node_cloudflare_tunnels ADD COLUMN pending_create_count INTEGER NOT NULL
  DEFAULT 0 CHECK (pending_create_count >= 0);
