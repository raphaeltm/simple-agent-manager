-- Persist node placement evidence even when a trial fails before creating a workspace.
ALTER TABLE trials ADD COLUMN placement_explanation_json TEXT;
