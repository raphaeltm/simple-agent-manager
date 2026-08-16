-- Persist in-flight direct-upload authorization so snapshot completion remains
-- compatible with old vm-agent binaries whose direct R2 PUTs do not cause R2 to
-- store a checksum visible from HEAD.
ALTER TABLE session_snapshots ADD COLUMN authorized_home_bytes INTEGER;
ALTER TABLE session_snapshots ADD COLUMN authorized_home_sha256 TEXT;
ALTER TABLE session_snapshots ADD COLUMN authorized_wip_bytes INTEGER;
ALTER TABLE session_snapshots ADD COLUMN authorized_wip_sha256 TEXT;
