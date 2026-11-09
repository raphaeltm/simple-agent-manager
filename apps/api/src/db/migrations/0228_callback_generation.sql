-- Credential generation for workspace and node callback credentials (task
-- 2026-11-08-workspace-credential-generation-revocation).
--
-- Every callback JWT and workspace MCP token minted for a runtime carries the generation
-- of its workspace or node row. Reactivating the same workspace ID under a new runtime
-- (VM restart/rebuild, Instant recovery) rotates the value, so the previous runtime's
-- unexpired credentials stop authenticating. NULL means the row has not been rotated since
-- this column existed: credentials minted before it (which carry no generation) keep working
-- until the first rotation. Additive only: both tables are FK parents (rule 31).
ALTER TABLE workspaces ADD COLUMN callback_generation TEXT DEFAULT NULL;
ALTER TABLE nodes ADD COLUMN callback_generation TEXT DEFAULT NULL;
