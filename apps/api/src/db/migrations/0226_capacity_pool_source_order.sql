-- Provider order for a compute pool (idea 01M6NXTF2RQ5QXHM7YZ4ZF0XBK).
--
-- A JSON array of capacity source ids, most preferred first. New VMs are planned from the
-- first source in the list before any later one. NULL means "all sources equal", which is
-- exactly the behaviour before this column existed, so no existing pool changes until an
-- admin sets an order. Additive only: capacity_pools is a FK parent and must never be
-- recreated (rule 31).
ALTER TABLE capacity_pools ADD COLUMN source_order_json TEXT DEFAULT NULL
  CHECK (source_order_json IS NULL OR json_valid(source_order_json));
