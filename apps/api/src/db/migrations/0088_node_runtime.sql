-- Runtime discriminator for nodes.
-- vm = traditional cloud VM. cf-container = Cloudflare Container virtual node.
ALTER TABLE nodes ADD COLUMN runtime TEXT NOT NULL DEFAULT 'vm';

CREATE INDEX IF NOT EXISTS idx_nodes_runtime ON nodes(runtime);
