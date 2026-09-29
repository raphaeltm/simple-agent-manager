-- Per-minute resource rollup for each stored chunk, computed on upload from the
-- decoded chunk payload. It lets the session resource timeline draw a whole
-- multi-day session from D1 alone, without downloading every R2 chunk.
--
-- Existing rows stay NULL. They remain fully readable: the timeline falls back
-- to the chunk's own summary_json (one aggregate spanning the chunk), and the
-- full-resolution detail is still read from R2 on zoom.
ALTER TABLE workspace_resource_chunks ADD COLUMN rollup_json TEXT;
