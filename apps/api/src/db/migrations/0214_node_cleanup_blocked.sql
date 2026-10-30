ALTER TABLE nodes ADD COLUMN cleanup_blocked_since TEXT;
ALTER TABLE nodes ADD COLUMN cleanup_blocked_reason TEXT;
ALTER TABLE nodes ADD COLUMN cleanup_blocked_alerted_at TEXT;
ALTER TABLE nodes ADD COLUMN cleanup_retirement_sources_json TEXT;
