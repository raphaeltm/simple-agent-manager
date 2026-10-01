-- Feature coordination channel carried through dispatch (preview).
--
-- A coordinator passes `coordinationChannel` to dispatch_task; children and every
-- later descendant inherit it (explicit value, else the parent's), and retry_subtask
-- and session recovery copy it onto replacement tasks. get_instructions surfaces it
-- with guidance. The value is a project event channel name; channels stay
-- project-visible, so this column routes guidance and is not an access boundary.
--
-- Additive only: one nullable column. Existing rows keep NULL, which means "no
-- coordination channel" and changes nothing for them. No DROP, no table rebuild.

ALTER TABLE tasks ADD COLUMN coordination_channel TEXT;
