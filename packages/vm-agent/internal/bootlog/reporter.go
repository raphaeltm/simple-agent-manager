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

// Broadcaster is an interface for local real-time delivery of boot log entries.
// The server's WebSocket broadcaster implements this to stream logs to connected
// clients without the latency of the HTTP/KV relay path.
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

// SetBroadcaster wires a local broadcaster for real-time WebSocket delivery.
// The broadcaster receives log entries BEFORE the token check, so early bootstrap
// steps (before token redemption) are visible to local WebSocket clients.
func (r *Reporter) SetBroadcaster(b Broadcaster) {
	if r == nil {
		return
	}
	r.broadcaster = b
}

// Log sends a boot log entry to the control plane. It also broadcasts locally
// to any connected WebSocket clients via the broadcaster (if set).
//
// The local broadcast happens BEFORE the token check so that early bootstrap
// steps (before token redemption) are visible to WebSocket clients.
//
// Failures are logged locally but never block bootstrap.
func (r *Reporter) Log(step, status, message string, detail ...string) {
	if r == nil {
		return
	}

	// Broadcast locally first — works even before token redemption.
	if r.broadcaster != nil {
		r.broadcaster.Broadcast(step, status, message, detail...)
	}

	// HTTP relay requires the callback token.
	if r.callbackToken == "" {
		return
	}

	r.logHTTP(step, status, message, detail...)
}

// logHTTP sends a boot log entry to the control plane via HTTP POST.
func (r *Reporter) logHTTP(step, status, message string, detail ...string) {
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
