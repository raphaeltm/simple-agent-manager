-- Durable per-generation preservation receipt for a retired workspace runtime.
-- The per-chat session_snapshots row is rewritten by a successor's first capture, so the
-- source's authority to delete its files is recorded on the source workspace itself.
-- Nullable and additive: NULL means "no receipt" and the legacy snapshot-row path applies.
ALTER TABLE workspaces ADD COLUMN preservation_receipt_json TEXT;
