ALTER TABLE platform_feedback_triages ADD COLUMN canonical_signature TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_feedback_triages_canonical_signature
  ON platform_feedback_triages(canonical_signature)
  WHERE canonical_signature IS NOT NULL;
