-- Internal collection probes never represent user-visible publish/build work.
ALTER TABLE deployment_publish_jobs ADD COLUMN context_shadow INTEGER NOT NULL DEFAULT 0 CHECK (context_shadow IN (0, 1));
