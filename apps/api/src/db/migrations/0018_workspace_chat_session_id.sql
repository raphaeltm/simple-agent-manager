-- Add chatSessionId to workspaces for linking to ProjectData DO chat sessions
ALTER TABLE workspaces ADD COLUMN chat_session_id TEXT DEFAULT NULL;
