-- Provenance for nodes.runtime_termination_confirmed_at. Set to the same value as
-- the proof only when the owner attested deletion (POST /api/nodes/:id/manual-deletion);
-- every strict proof write sets it NULL. A proof is owner-attested only while the two
-- columns are equal, so writers that later replace or clear the proof need no change.
-- Existing rows stay NULL: every proof written before this column existed was strict.
ALTER TABLE nodes ADD COLUMN runtime_termination_attested_at TEXT;
