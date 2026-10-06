CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'admin', 'maintainer', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'suspended', 'removed')),
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_members_user_status
ON project_members(user_id, status);

CREATE INDEX IF NOT EXISTS idx_project_members_project_status
ON project_members(project_id, status);

INSERT OR IGNORE INTO project_members (
  project_id,
  user_id,
  role,
  status,
  invited_by,
  created_at,
  updated_at
)
SELECT
  id,
  user_id,
  'owner',
  'active',
  created_by,
  created_at,
  updated_at
FROM projects;
