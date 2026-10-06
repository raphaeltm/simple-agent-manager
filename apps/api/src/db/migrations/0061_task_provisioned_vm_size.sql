-- Migration 0061: Record the VM size actually provisioned for a task.
-- Differs from requested_vm_size only when size-fallback descended on transient
-- capacity exhaustion (auto-provisioning a brand-new node). Nullable TEXT; null
-- until an auto-provisioned node succeeds at a size smaller than requested.

ALTER TABLE tasks ADD COLUMN provisioned_vm_size TEXT;
