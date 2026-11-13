-- Source node_id remains NOT NULL and retains its original cascade FK.
ALTER TABLE deployment_publish_jobs ADD COLUMN executor TEXT NOT NULL DEFAULT 'node' CHECK (executor IN ('node', 'cloudflare'));
ALTER TABLE deployment_publish_jobs ADD COLUMN context_r2_key TEXT;
ALTER TABLE deployment_publish_jobs ADD COLUMN context_bytes INTEGER;
ALTER TABLE deployment_publish_jobs ADD COLUMN context_sha256 TEXT;
ALTER TABLE deployment_publish_jobs ADD COLUMN queued_at TEXT;
-- status has always been unconstrained TEXT; collecting/context_ready are additive.
