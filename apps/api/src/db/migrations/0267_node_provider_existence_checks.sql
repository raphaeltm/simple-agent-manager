-- Provider-existence reconciliation for running deployment nodes
-- (services/deployment-node-provider-existence.ts; idea 01M81Z9P6QFX4M9Q83K2XKGZVR).
--
-- provider_existence_checked_at  when the reconciliation last probed this node's VM at its
--                                provider. Written only by that sweep: it schedules the next
--                                probe, so no other writer may move it (.claude/rules/53).
-- provider_absence_observed_at   when the provider first answered a definitive "not found" for
--                                provider_absence_instance_id through the node's pinned
--                                placement credential. Cleared when the instance is seen again.
--                                A second "not found" at least the confirmation interval later
--                                releases the node.
-- provider_absence_instance_id   the exact instance that observation was about, so an
--                                observation about an earlier instance can never confirm a
--                                later one.
--
-- Additive and nullable. Existing rows start NULL: never probed, no absence observed, so the
-- first sweep probes them and nothing is released before two observations exist.
ALTER TABLE nodes ADD COLUMN provider_existence_checked_at TEXT;
ALTER TABLE nodes ADD COLUMN provider_absence_observed_at TEXT;
ALTER TABLE nodes ADD COLUMN provider_absence_instance_id TEXT;
