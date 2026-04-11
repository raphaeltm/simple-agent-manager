-- Add directory support to project file library
-- Directories are virtual (metadata in D1), R2 keys remain unchanged.
-- Path format: always starts and ends with '/', root is '/'.

-- SQLite requires table recreation for constraint changes.
-- Step 1: Create new table with directory column and updated unique constraint.
CREATE TABLE project_files_new (
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
  directory TEXT NOT NULL DEFAULT '/',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, directory, filename)
);

-- Step 2: Copy existing data (all existing files go to root directory '/').
INSERT INTO project_files_new (
  id, project_id, filename, mime_type, size_bytes, description,
  uploaded_by, upload_source, upload_session_id, upload_task_id,
  replaced_at, replaced_by, status, r2_key, extracted_text_preview,
  directory, created_at, updated_at
)
SELECT
  id, project_id, filename, mime_type, size_bytes, description,
  uploaded_by, upload_source, upload_session_id, upload_task_id,
  replaced_at, replaced_by, status, r2_key, extracted_text_preview,
  '/', created_at, updated_at
FROM project_files;

-- Step 3: Drop old table and rename.
DROP TABLE project_files;
ALTER TABLE project_files_new RENAME TO project_files;

-- Step 4: Recreate indexes.
CREATE INDEX idx_project_files_project_id ON project_files(project_id);
CREATE INDEX idx_project_files_project_status ON project_files(project_id, status);
CREATE INDEX idx_project_files_project_source ON project_files(project_id, upload_source);
CREATE INDEX idx_project_files_project_mime ON project_files(project_id, mime_type);
CREATE UNIQUE INDEX idx_project_files_project_dir_filename ON project_files(project_id, directory, filename);
CREATE INDEX idx_project_files_project_dir ON project_files(project_id, directory);
