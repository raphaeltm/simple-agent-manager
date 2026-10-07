-- Additive only: NULL records retain conservative legacy recovery.
ALTER TABLE agent_sessions ADD COLUMN runtime_contract_json TEXT;
ALTER TABLE session_snapshots ADD COLUMN runtime_contract_json TEXT;
