-- Persist the VM-agent's generation-scoped capture failure so the sleep
-- waiter can degrade with the real capture error instead of a generic idle
-- timeout.
ALTER TABLE session_snapshots ADD COLUMN capture_error TEXT;
