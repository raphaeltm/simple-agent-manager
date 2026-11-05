-- Emergency fix for staging (2026-11-04). An earlier draft of 0218 added AFTER UPDATE triggers on
-- workspaces, nodes and session_snapshots that wrote a second row per status change. D1 counts
-- trigger writes in `meta.changes`, so every compare-and-set that requires `changes === 1` (for
-- example `provisionNode`'s final running write) read a successful update as a lost race, and node
-- provisioning destroyed the VMs it had just created. The triggers never reached production; this
-- removes them wherever that draft was applied. Never add triggers that write to these tables.
DROP TRIGGER IF EXISTS trg_workspaces_status_transition;
DROP TRIGGER IF EXISTS trg_workspaces_status_changed_at;
DROP TRIGGER IF EXISTS trg_workspaces_status_changed_at_insert;
DROP TRIGGER IF EXISTS trg_nodes_status_transition;
DROP TRIGGER IF EXISTS trg_nodes_status_changed_at;
DROP TRIGGER IF EXISTS trg_nodes_status_changed_at_insert;
DROP TRIGGER IF EXISTS trg_session_snapshots_sleep_status_transition;
DROP TRIGGER IF EXISTS trg_session_snapshots_sleep_status_changed_at;
DROP TRIGGER IF EXISTS trg_session_snapshots_recovery_status_transition;
DROP TRIGGER IF EXISTS trg_session_snapshots_recovery_status_changed_at;
DROP TRIGGER IF EXISTS trg_session_snapshots_status_changed_at_insert;
