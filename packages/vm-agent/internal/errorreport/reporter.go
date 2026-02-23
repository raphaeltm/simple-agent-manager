// Package errorreport sends structured error entries to the control plane
// for observability via Cloudflare Workers logs.
// All methods are nil-safe: a nil *Reporter is a no-op.
package errorreport

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ErrorEntry represents a single error to report to the control plane.
type ErrorEntry struct {
	Level       string                 `json:"level"`
	Message     string                 `json:"message"`
	Source      string                 `json:"source"`
	Stack       string                 `json:"stack,omitempty"`
	WorkspaceID string                 `json:"workspaceId,omitempty"`
	Timestamp   string                 `json:"timestamp"`
	Context     map[string]interface{} `json:"context,omitempty"`
}

// Config holds configuration for the error reporter.
type Config struct {
	FlushInterval time.Duration // How often to flush queued errors (default: 30s)
	MaxBatchSize  int           // Immediate flush threshold (default: 10)
	MaxQueueSize  int           // Maximum queued entries before dropping (default: 100)
	HTTPTimeout   time.Duration // HTTP POST timeout (default: 10s)
}

// Reporter batches and sends error entries to the control plane.
// It is safe to call methods on a nil *Reporter — they simply no-op.
type Reporter struct {
	apiBaseURL string
	nodeID     string
	authToken  string
	config     Config
	client     *http.Client

	mu    sync.Mutex
	queue []ErrorEntry
	stopC chan struct{}
	doneC chan struct{}
}

// New creates a Reporter with the given configuration.
func New(apiBaseURL, nodeID, authToken string, cfg Config) *Reporter {
	// Apply defaults
	if cfg.FlushInterval <= 0 {
		cfg.FlushInterval = 30 * time.Second
	}
	if cfg.MaxBatchSize <= 0 {
		cfg.MaxBatchSize = 10
	}
	if cfg.MaxQueueSize <= 0 {
		cfg.MaxQueueSize = 100
	}
	if cfg.HTTPTimeout <= 0 {
		cfg.HTTPTimeout = 10 * time.Second
	}

	return &Reporter{
		apiBaseURL: strings.TrimRight(apiBaseURL, "/"),
		nodeID:     nodeID,
		authToken:  authToken,
		config:     cfg,
		client:     &http.Client{Timeout: cfg.HTTPTimeout},
		queue:      make([]ErrorEntry, 0, cfg.MaxBatchSize),
		stopC:      make(chan struct{}),
		doneC:      make(chan struct{}),
	}
}

// SetToken updates the auth token used for error reporting. This allows the
// reporter to be created before the token is available (e.g. before bootstrap)
// and activated later.
func (r *Reporter) SetToken(token string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.authToken = token
}

// Start launches the background flush goroutine.
func (r *Reporter) Start() {
	if r == nil {
		return
	}
	go r.flushLoop()
}

// Shutdown flushes any remaining entries and stops the background goroutine.
func (r *Reporter) Shutdown() {
	if r == nil {
		return
	}
	close(r.stopC)
	<-r.doneC
}

// Report queues an error entry for batched sending.
// If the queue reaches MaxBatchSize, a flush is triggered immediately.
func (r *Reporter) Report(entry ErrorEntry) {
	if r == nil {
		return
	}

	// Auto-enrich timestamp if empty
	if entry.Timestamp == "" {
		entry.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}

	r.mu.Lock()
	if len(r.queue) >= r.config.MaxQueueSize {
		r.mu.Unlock()
		slog.Warn("errorreport: queue full, dropping error", "maxQueueSize", r.config.MaxQueueSize, "message", entry.Message)
		return
	}
	r.queue = append(r.queue, entry)
	shouldFlush := len(r.queue) >= r.config.MaxBatchSize
	r.mu.Unlock()

	if shouldFlush {
		go r.flush()
	}
}

// ReportError is a convenience method that creates an ErrorEntry from an error.
func (r *Reporter) ReportError(err error, source, workspaceID string, ctx map[string]interface{}) {
	if r == nil {
		return
	}

	msg := "unknown error"
	stack := ""
	if err != nil {
		msg = err.Error()
		stack = msg // Use error message as stack for Go errors
	}

	r.Report(ErrorEntry{
		Level:       "error",
		Message:     msg,
		Source:      source,
		Stack:       stack,
		WorkspaceID: workspaceID,
		Context:     ctx,
	})
}

// ReportInfo is a convenience method for info-level lifecycle events.
func (r *Reporter) ReportInfo(message, source, workspaceID string, ctx map[string]interface{}) {
	if r == nil {
		return
	}
	r.Report(ErrorEntry{
		Level:       "info",
		Message:     message,
		Source:      source,
		WorkspaceID: workspaceID,
		Context:     ctx,
	})
}

// ReportWarn is a convenience method for warn-level lifecycle events.
func (r *Reporter) ReportWarn(message, source, workspaceID string, ctx map[string]interface{}) {
	if r == nil {
		return
	}
	r.Report(ErrorEntry{
		Level:       "warn",
		Message:     message,
		Source:      source,
		WorkspaceID: workspaceID,
		Context:     ctx,
	})
}

// flushLoop runs the periodic flush in the background.
func (r *Reporter) flushLoop() {
	defer close(r.doneC)

	ticker := time.NewTicker(r.config.FlushInterval)
	defer ticker.Stop()

	for {
		select {
		case <-r.stopC:
			// Final flush before stopping
			r.flush()
			return
		case <-ticker.C:
			r.flush()
		}
	}
}

// flush sends all queued entries to the control plane.
func (r *Reporter) flush() {
	r.mu.Lock()
	if len(r.queue) == 0 {
		r.mu.Unlock()
		return
	}
	// Swap out the queue
	batch := r.queue
	r.queue = make([]ErrorEntry, 0, r.config.MaxBatchSize)
	r.mu.Unlock()

	r.send(batch)
}

// send POSTs a batch of error entries to the control plane.
func (r *Reporter) send(entries []ErrorEntry) {
	payload := map[string]interface{}{
		"errors": entries,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		slog.Error("errorreport: failed to marshal entries", "error", err)
		return
	}

	url := r.apiBaseURL + "/api/nodes/" + r.nodeID + "/errors"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		slog.Error("errorreport: failed to create request", "error", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+r.authToken)

	resp, err := r.client.Do(req)
	if err != nil {
		slog.Error("errorreport: failed to send entries", "count", len(entries), "error", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		slog.Warn("errorreport: control plane returned non-OK status", "statusCode", resp.StatusCode, "count", len(entries))
	}
}
