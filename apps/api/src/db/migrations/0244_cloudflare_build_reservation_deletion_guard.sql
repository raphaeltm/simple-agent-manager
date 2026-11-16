-- D1 is the capacity ledger. Keep even terminal jobs until the microVM stop
-- has been confirmed and its reservation released. Also fences FK cascades.
CREATE TRIGGER cloudflare_build_reservation_no_delete
BEFORE DELETE ON deployment_publish_jobs
WHEN OLD.executor = 'cloudflare' AND OLD.context_shadow = 0
  AND OLD.executor_instance_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'cloudflare_build_reservation_held'); END;
