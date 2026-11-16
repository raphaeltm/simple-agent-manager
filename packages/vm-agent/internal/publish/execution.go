package publish

import (
	"crypto/rand"
	"sync/atomic"
)

var (
	processIncarnation   = rand.Text()
	composeBuildAttempts atomic.Uint64
	dockerSaveAttempts   atomic.Uint64
)

// ExecutionSnapshot counts attempted publish-path host commands, including
// failed executions. It does not describe unrelated processes on the node.
type ExecutionSnapshot struct {
	ProcessIncarnation   string `json:"processIncarnation"`
	ComposeBuildAttempts uint64 `json:"composeBuildAttempts"`
	DockerSaveAttempts   uint64 `json:"dockerSaveAttempts"`
}

// ExecutionCounters is uncached and safe to call concurrently with publishing.
// Consumers must compare process incarnations before interpreting count deltas.
func ExecutionCounters() ExecutionSnapshot {
	return ExecutionSnapshot{
		ProcessIncarnation:   processIncarnation,
		ComposeBuildAttempts: composeBuildAttempts.Load(),
		DockerSaveAttempts:   dockerSaveAttempts.Load(),
	}
}
