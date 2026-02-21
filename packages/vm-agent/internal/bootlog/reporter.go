// Package bootlog sends structured boot log entries to the control plane.
// All methods are nil-safe: a nil *Reporter is a no-op.
package bootlog

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

// Broadcaster receives boot log entries for local distribution (e.g., WebSocket clients).
// Unlike the HTTP-based control plane relay, broadcasts happen immediately and do not
// require a callback token. This allows early bootstrap steps to be visible to connected
// clients before the token is available.
type Broadcaster interface {
	Broadcast(step, status, message string, detail ...string)
}

// Reporter sends structured log entries to the control plane boot-log endpoint.
// It is safe to call methods on a nil *Reporter — they simply no-op.
type Reporter struct {
	controlPlaneURL string
	workspaceID     string
	callbackToken   string
	client          *http.Client
	broadcaster     Broadcaster
}

type logEntry struct {
	Step      string `json:"step"`
	Status    string `json:"status"`
	Message   string `json:"message"`
	Detail    string `json:"detail,omitempty"`
	Timestamp string `json:"timestamp"`
}

// New creates a Reporter. The reporter starts without a token and will no-op
// until SetToken is called (typically after bootstrap token redemption).
func New(controlPlaneURL, workspaceID string) *Reporter {
	return &Reporter{
		controlPlaneURL: strings.TrimRight(controlPlaneURL, "/"),
		workspaceID:     workspaceID,
		client:          &http.Client{Timeout: 10 * time.Second},
	}
}

// SetToken enables log sending by providing the callback JWT.
func (r *Reporter) SetToken(token string) {
	if r == nil {
		return
	}
	r.callbackToken = token
}

// SetBroadcaster sets a local broadcaster for real-time log distribution.
// The broadcaster receives log entries immediately, even before the callback
// token is available for HTTP relay to the control plane.
func (r *Reporter) SetBroadcaster(b Broadcaster) {
	if r == nil {
		return
	}
	r.broadcaster = b
}

// Log sends a boot log entry to the control plane. It also broadcasts to any
// local broadcaster (e.g., WebSocket clients) regardless of token availability.
// Failures are logged locally but never block bootstrap.
func (r *Reporter) Log(step, status, message string, detail ...string) {
	if r == nil {
		return
	}

	// Broadcast locally first — this works even before token redemption,
	// so connected WebSocket clients see early bootstrap steps.
	if r.broadcaster != nil {
		r.broadcaster.Broadcast(step, status, message, detail...)
	}

	// HTTP relay to control plane requires a token.
	if r.callbackToken == "" {
		return
	}

	entry := logEntry{
		Step:      step,
		Status:    status,
		Message:   message,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
	if len(detail) > 0 && detail[0] != "" {
		entry.Detail = detail[0]
	}

	body, err := json.Marshal(entry)
	if err != nil {
		log.Printf("bootlog: failed to marshal entry: %v", err)
		return
	}

	url := fmt.Sprintf("%s/api/workspaces/%s/boot-log", r.controlPlaneURL, r.workspaceID)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		log.Printf("bootlog: failed to create request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+r.callbackToken)

	resp, err := r.client.Do(req)
	if err != nil {
		log.Printf("bootlog: failed to send log entry (step=%s): %v", step, err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("bootlog: control plane returned HTTP %d for step=%s", resp.StatusCode, step)
	}
}

// LogBuildOutput sends build output lines as a boot-log entry with step="build_output".
// The lines parameter contains one or more newline-separated output lines from the
// devcontainer build process. This is designed to be called periodically (every few
// seconds) with batched output rather than per-line.
func (r *Reporter) LogBuildOutput(lines string) {
	if r == nil || lines == "" {
		return
	}
	// Always broadcast locally (even without token).
	if r.broadcaster != nil {
		r.broadcaster.Broadcast("build_output", "streaming", lines)
	}
	// HTTP relay requires token.
	if r.callbackToken == "" {
		return
	}
	r.logHTTP("build_output", "streaming", lines)
}

// logHTTP sends a log entry to the control plane via HTTP POST.
// This is the HTTP-only path, used by LogBuildOutput to avoid double-broadcasting.
func (r *Reporter) logHTTP(step, status, message string) {
	entry := logEntry{
		Step:      step,
		Status:    status,
		Message:   message,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}

	body, err := json.Marshal(entry)
	if err != nil {
		log.Printf("bootlog: failed to marshal entry: %v", err)
		return
	}

	url := fmt.Sprintf("%s/api/workspaces/%s/boot-log", r.controlPlaneURL, r.workspaceID)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		log.Printf("bootlog: failed to create request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+r.callbackToken)

	resp, err := r.client.Do(req)
	if err != nil {
		log.Printf("bootlog: failed to send log entry (step=%s): %v", step, err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("bootlog: control plane returned HTTP %d for step=%s", resp.StatusCode, step)
	}
}
