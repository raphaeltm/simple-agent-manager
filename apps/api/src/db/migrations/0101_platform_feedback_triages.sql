CREATE TABLE IF NOT EXISTS platform_feedback_triages (
  signature TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL,
  summary TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  occurrence_count INTEGER NOT NULL,
  evidence_refs TEXT NOT NULL,
  diagnosis_id TEXT REFERENCES debug_diagnoses(id) ON DELETE SET NULL,
  idea_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  claim_token TEXT,
  claim_expires_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_platform_feedback_triages_idea ON platform_feedback_triages(idea_id);
CREATE INDEX IF NOT EXISTS idx_platform_feedback_triages_last_seen ON platform_feedback_triages(last_seen_at);
