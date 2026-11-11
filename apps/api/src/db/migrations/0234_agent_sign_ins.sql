-- Agent sign-in through workload identity (services/agent-sign-in/). One row per accepted
-- sign-in: the durable audit record of which trusted-issuer workload signed in as which user.
--
-- The same row is the replay guard and the per-principal rate limit. The route claims a token
-- with one guarded INSERT ... SELECT ... WHERE (recent rows for the principal) < limit
-- ON CONFLICT(issuer, jti) DO NOTHING, which SQLite serializes, so a replayed jti or an
-- over-limit principal cannot slip in between a read and a write.
--
-- No foreign keys on purpose: the audit record must outlive sign-out (sessions rows are
-- deleted) and must not be cascaded away with a user.
--
-- sessions.hard_expires_at: a lifetime BetterAuth's refresh may not extend. Set only on agent
-- sign-in sessions; auth.ts (session.update.before) clamps every refresh of such a session to it
-- inside BetterAuth's own UPDATE. Existing session rows: NULL, meaning no cap (unchanged
-- behaviour for every ordinary session).
--
-- Additive only: one new table and one nullable column (sessions has no FK children). Numbered 0234 because 0232 is used by the
-- self-host integration branch and 0233 is already on main.
CREATE TABLE agent_sign_ins (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  jti TEXT NOT NULL,
  source_subject TEXT NOT NULL,
  source_project_id TEXT NOT NULL,
  source_user_id TEXT NOT NULL,
  source_agent_profile_id TEXT,
  source_task_id TEXT,
  source_workspace_id TEXT,
  target_user_id TEXT NOT NULL,
  session_id TEXT,
  token_expires_at INTEGER NOT NULL,
  session_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_agent_sign_ins_issuer_jti ON agent_sign_ins (issuer, jti);
CREATE INDEX idx_agent_sign_ins_principal_created
  ON agent_sign_ins (issuer, source_project_id, source_user_id, created_at);
CREATE INDEX idx_agent_sign_ins_session ON agent_sign_ins (session_id);

ALTER TABLE sessions ADD COLUMN hard_expires_at INTEGER;
