-- Activation is a deployment-owned protocol record, not mutable platform config.
-- The coordinator's atomic publication validates a future window boundary.
CREATE TRIGGER reliability_activation_no_update
BEFORE UPDATE ON platform_settings
WHEN OLD.key = 'reliability.storage.activation.v1' OR NEW.key = 'reliability.storage.activation.v1'
BEGIN SELECT RAISE(ABORT, 'Reliability storage activation is immutable'); END;

CREATE TRIGGER reliability_activation_no_delete
BEFORE DELETE ON platform_settings
WHEN OLD.key = 'reliability.storage.activation.v1'
BEGIN SELECT RAISE(ABORT, 'Reliability storage activation is immutable'); END;

-- INSERT OR REPLACE must not evade UPDATE/DELETE guards.
CREATE TRIGGER reliability_activation_no_replace
BEFORE INSERT ON platform_settings
WHEN NEW.key = 'reliability.storage.activation.v1'
  AND EXISTS (SELECT 1 FROM platform_settings WHERE key = NEW.key)
BEGIN SELECT RAISE(ABORT, 'Reliability storage activation is immutable'); END;
