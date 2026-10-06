-- Custom HTTP headers for bring-your-own MCP servers.
--
-- Some providers authenticate with an API-key header rather than a bearer token or a
-- pre-signed URL (Composio requires `x-api-key`). Headers are independent of `auth_type`.
--
-- `encrypted_headers` is the AES-256-GCM ciphertext of the full JSON list of
-- `{ "name", "value" }` pairs, with its own IV. It is the only column injection reads.
-- `header_names` is a plaintext JSON array of the same names, written in the same statement,
-- so the list endpoint can show which headers are set without decrypting anything or ever
-- returning a value.
--
-- Additive only: three new columns with defaults/NULL, so every existing row keeps its
-- current meaning (no headers). No DROP, no table rebuild.

ALTER TABLE mcp_connections ADD COLUMN header_names TEXT NOT NULL DEFAULT '[]';
ALTER TABLE mcp_connections ADD COLUMN encrypted_headers TEXT;
ALTER TABLE mcp_connections ADD COLUMN headers_iv TEXT;
