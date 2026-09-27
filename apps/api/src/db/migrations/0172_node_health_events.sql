-- Survives removal of the node row so heartbeat-loss and cleanup decisions remain auditable.
CREATE TABLE node_health_events (
  id TEXT PRIMARY KEY NOT NULL,
  node_id TEXT NOT NULL,
  episode_started_at TEXT NOT NULL,
  event TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_node_health_events_episode_event
  ON node_health_events(node_id, episode_started_at, event, reason);
CREATE INDEX idx_node_health_events_node_created
  ON node_health_events(node_id, created_at);
