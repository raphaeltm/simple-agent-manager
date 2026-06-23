-- Discriminator for how a deployment release was produced.
-- Additive migration only: deployment_releases is never dropped or recreated.
--
-- NULL / 'build-on-node' = the existing build-on-node deploy path (manifest is a
--   DeploymentManifest). 'compose-publish' = a release captured from a native
--   `docker compose publish` artifact (manifest holds the captured submission:
--   compose YAML, image-digests YAML, and per-service pushed image refs).
ALTER TABLE deployment_releases ADD COLUMN source TEXT;

CREATE INDEX IF NOT EXISTS idx_deployment_releases_source
  ON deployment_releases(source);
