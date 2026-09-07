-- Durable proof for the exact workspace runtime deletion. Replacement and
-- recovery must not infer absence from a mutable workspace/node status label.
ALTER TABLE workspaces ADD COLUMN runtime_deletion_confirmed_at TEXT;
ALTER TABLE workspaces ADD COLUMN runtime_deletion_proof TEXT;
