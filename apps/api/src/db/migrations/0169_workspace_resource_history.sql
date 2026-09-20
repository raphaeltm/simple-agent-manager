CREATE TABLE workspace_resource_summaries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL,
  skill_id TEXT REFERENCES skills(id) ON DELETE SET NULL,
  agent_type TEXT,
  runtime TEXT NOT NULL DEFAULT 'vm',
  source_version INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  gap_count INTEGER NOT NULL DEFAULT 0,
  cpu_mean_millis REAL,
  cpu_peak_millis REAL,
  memory_mean_bytes INTEGER,
  memory_peak_bytes INTEGER,
  memory_kernel_peak_bytes INTEGER,
  io_read_bytes INTEGER,
  io_write_bytes INTEGER,
  oom_count INTEGER NOT NULL DEFAULT 0,
  tool_span_count INTEGER NOT NULL DEFAULT 0,
  completeness_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  first_chunk_id TEXT,
  latest_chunk_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_workspace_resource_summaries_project_session
  ON workspace_resource_summaries(project_id, session_id, ended_at);

CREATE INDEX idx_workspace_resource_summaries_project_workspace
  ON workspace_resource_summaries(project_id, workspace_id, ended_at);

CREATE INDEX idx_workspace_resource_summaries_project_task
  ON workspace_resource_summaries(project_id, task_id, ended_at);

CREATE TABLE workspace_resource_chunks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  summary_id TEXT REFERENCES workspace_resource_summaries(id) ON DELETE SET NULL,
  session_id TEXT,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  chunk_sequence INTEGER NOT NULL,
  source_version INTEGER NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  storage_format TEXT NOT NULL,
  compressed_bytes INTEGER NOT NULL,
  uncompressed_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  gap_count INTEGER NOT NULL DEFAULT 0,
  tool_span_count INTEGER NOT NULL DEFAULT 0,
  completeness_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  uploaded_by_node_id TEXT
);

CREATE INDEX idx_workspace_resource_chunks_identity
  ON workspace_resource_chunks(project_id, workspace_id, session_id, task_id, chunk_sequence, source_version);

CREATE INDEX idx_workspace_resource_chunks_project_session
  ON workspace_resource_chunks(project_id, session_id, started_at);

CREATE INDEX idx_workspace_resource_chunks_project_workspace
  ON workspace_resource_chunks(project_id, workspace_id, started_at);

CREATE INDEX idx_workspace_resource_chunks_expires
  ON workspace_resource_chunks(expires_at);
