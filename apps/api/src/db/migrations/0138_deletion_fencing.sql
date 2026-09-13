-- Strict external-runtime termination proof. A mutable lifecycle status is
-- deliberately not evidence that provider/container deletion succeeded.
ALTER TABLE nodes ADD COLUMN runtime_termination_confirmed_at TEXT;
