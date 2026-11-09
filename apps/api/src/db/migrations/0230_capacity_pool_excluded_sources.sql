-- Accounts switched off in a compute pool (tasks/active/2026-11-09-compute-pool-editor-redesign.md).
--
-- A JSON array of capacity source ids a person switched off in this pool. Their candidate rows
-- keep their statuses (so switching the account back on restores its machines), but placement
-- skips them: no new VMs and no reuse of their running nodes. NULL means every source is on,
-- which is exactly the behaviour before this column existed, so no existing pool changes.
-- Additive only: capacity_pools is a FK parent and must never be recreated (rule 31).
ALTER TABLE capacity_pools ADD COLUMN excluded_source_ids_json TEXT DEFAULT NULL
  CHECK (excluded_source_ids_json IS NULL OR json_valid(excluded_source_ids_json));
