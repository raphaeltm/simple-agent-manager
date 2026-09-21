ALTER TABLE capacity_pools
  ADD COLUMN deployment_strategy TEXT NOT NULL DEFAULT 'smallest-fit'
  CHECK (deployment_strategy IN ('balanced', 'pack', 'spread', 'smallest-fit'));

ALTER TABLE deployment_environments
  ADD COLUMN resolved_reservation_json TEXT;
