ALTER TABLE platform_feedback_triages ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE platform_feedback_triages ADD COLUMN last_failure_reason TEXT;
ALTER TABLE platform_feedback_triages ADD COLUMN last_failed_at INTEGER;
ALTER TABLE platform_feedback_triages ADD COLUMN rejected_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_platform_feedback_triages_rejected ON platform_feedback_triages(rejected_at);
