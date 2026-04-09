-- Project File Library: per-project encrypted file storage
-- Spec: project-file-library (Part 1 — backend core)

CREATE TABLE project_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  description TEXT,
  uploaded_by TEXT NOT NULL,
  upload_source TEXT NOT NULL DEFAULT 'user',
  upload_session_id TEXT,
  upload_task_id TEXT,
  replaced_at TEXT,
  replaced_by TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  r2_key TEXT NOT NULL,
  extracted_text_preview TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, filename)
);

CREATE INDEX idx_project_files_project_id ON project_files(project_id);
CREATE INDEX idx_project_files_project_status ON project_files(project_id, status);
CREATE INDEX idx_project_files_project_source ON project_files(project_id, upload_source);
CREATE INDEX idx_project_files_project_mime ON project_files(project_id, mime_type);

CREATE TABLE project_file_tags (
  file_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  tag_source TEXT NOT NULL DEFAULT 'user',
  PRIMARY KEY (file_id, tag),
  FOREIGN KEY (file_id) REFERENCES project_files(id) ON DELETE CASCADE
);

CREATE INDEX idx_project_file_tags_tag ON project_file_tags(tag);
