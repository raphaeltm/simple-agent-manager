// Package messagereport persists ACP chat messages to the control plane
// via a transactional outbox backed by SQLite.
//
// All methods on *Reporter are nil-safe: a nil receiver is a no-op.
// This mirrors the errorreport.Reporter pattern.
package messagereport

import (
	"os"
	"strconv"
	"time"
)

// Config holds tunable parameters for the message reporter.
// All values have sensible defaults; override via MSG_* environment variables.
type Config struct {
	// BatchMaxWait is the maximum time to wait before flushing a partial batch.
	BatchMaxWait time.Duration

	// BatchMaxSize is the maximum number of messages per HTTP POST.
	BatchMaxSize int

	// BatchMaxBytes is the approximate max payload size per batch (bytes).
	// Messages are measured by their JSON-serialized content length.
	BatchMaxBytes int

	// OutboxMaxSize is the maximum number of messages retained in the SQLite
	// outbox. When exceeded, Enqueue returns an error.
	OutboxMaxSize int

	// RetryInitial is the initial backoff delay after a transient HTTP failure.
	RetryInitial time.Duration

	// RetryMax is the maximum backoff delay between retries.
	RetryMax time.Duration

	// RetryMaxElapsed is the total elapsed time before giving up on a batch.
	RetryMaxElapsed time.Duration

	// HTTPTimeout is the per-request timeout for batch POST calls.
	HTTPTimeout time.Duration

	// Endpoint is the control plane URL (without trailing slash).
	// The batch endpoint will be: {Endpoint}/api/workspaces/{workspaceId}/messages
	Endpoint string

	// WorkspaceID is the workspace identifier used in the API path.
	WorkspaceID string

	// ProjectID is the project this workspace belongs to.
	// If empty, the reporter is a no-op (workspace has no project).
	ProjectID string

	// SessionID is the chat session ID for this workspace.
	// If empty, the reporter is a no-op.
	SessionID string
}

// DefaultConfig returns a Config with production defaults.
// Override individual fields or call LoadConfigFromEnv for env-var–based loading.
func DefaultConfig() Config {
	return Config{
		BatchMaxWait:    2 * time.Second,
		BatchMaxSize:    50,
		BatchMaxBytes:   65536, // 64 KB
		OutboxMaxSize:   10000,
		RetryInitial:    1 * time.Second,
		RetryMax:        30 * time.Second,
		RetryMaxElapsed: 5 * time.Minute,
		HTTPTimeout:     10 * time.Second,
	}
}

// LoadConfigFromEnv reads MSG_* environment variables and returns a Config
// with defaults for any unset values.
func LoadConfigFromEnv() Config {
	cfg := DefaultConfig()

	cfg.BatchMaxWait = envDuration("MSG_BATCH_MAX_WAIT", cfg.BatchMaxWait)
	cfg.BatchMaxSize = envInt("MSG_BATCH_MAX_SIZE", cfg.BatchMaxSize)
	cfg.BatchMaxBytes = envInt("MSG_BATCH_MAX_BYTES", cfg.BatchMaxBytes)
	cfg.OutboxMaxSize = envInt("MSG_OUTBOX_MAX_SIZE", cfg.OutboxMaxSize)
	cfg.RetryInitial = envDuration("MSG_RETRY_INITIAL", cfg.RetryInitial)
	cfg.RetryMax = envDuration("MSG_RETRY_MAX", cfg.RetryMax)
	cfg.RetryMaxElapsed = envDuration("MSG_RETRY_MAX_ELAPSED", cfg.RetryMaxElapsed)
	cfg.HTTPTimeout = envDuration("MSG_HTTP_TIMEOUT", cfg.HTTPTimeout)

	cfg.Endpoint = os.Getenv("CONTROL_PLANE_URL")
	cfg.WorkspaceID = os.Getenv("WORKSPACE_ID")
	cfg.ProjectID = os.Getenv("PROJECT_ID")
	cfg.SessionID = os.Getenv("CHAT_SESSION_ID")

	return cfg
}

// envDuration reads a duration string from the environment.
func envDuration(key string, fallback time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return fallback
	}
	return d
}

// envInt reads an integer from the environment.
func envInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}
