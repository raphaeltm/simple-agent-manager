package config

import "time"

const (
	DefaultWorkspaceDeletionTombstoneRetention = 7 * 24 * time.Hour
	DefaultWorkspaceDeletionRetryInterval      = time.Minute
	DefaultWorkspaceDeletionAttemptTimeout     = 30 * time.Second
	DefaultWorkspaceDeletionBatchSize          = 32
)
