package config

import "time"

const (
	DefaultWorkspaceDeletionTombstoneRetention = 7 * 24 * time.Hour
	DefaultWorkspaceDeletionMaxEntries         = 512
	DefaultWorkspaceDeletionRetryInterval      = time.Minute
	DefaultWorkspaceDeletionAttemptTimeout     = 30 * time.Second
	DefaultWorkspaceDeletionBatchSize          = 32
)
