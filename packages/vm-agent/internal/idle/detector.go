// Package idle provides idle detection for automatic workspace shutdown.
package idle

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"
)

// Detector tracks user activity and reports idle status.
type Detector struct {
	timeout           time.Duration
	heartbeatInterval time.Duration
	idleCheckInterval time.Duration // Deprecated: no automatic shutdown
	controlPlaneURL   string
	workspaceID       string
	callbackToken     string

	lastActivity     time.Time
	shutdownDeadline time.Time
	mu               sync.RWMutex
	done             chan struct{}
	shutdownCh       chan struct{}
}

// DetectorConfig holds configuration for the idle detector.
type DetectorConfig struct {
	Timeout           time.Duration
	HeartbeatInterval time.Duration
	IdleCheckInterval time.Duration
	ControlPlaneURL   string
	WorkspaceID       string
	CallbackToken     string
}

// NewDetectorWithConfig creates a new idle detector with full configuration.
func NewDetectorWithConfig(cfg DetectorConfig) *Detector {
	now := time.Now()

	// Default idle check interval if not specified
	if cfg.IdleCheckInterval == 0 {
		cfg.IdleCheckInterval = 10 * time.Second
	}

	return &Detector{
		timeout:           cfg.Timeout,
		heartbeatInterval: cfg.HeartbeatInterval,
		idleCheckInterval: cfg.IdleCheckInterval,
		controlPlaneURL:   cfg.ControlPlaneURL,
		workspaceID:       cfg.WorkspaceID,
		callbackToken:     cfg.CallbackToken,
		lastActivity:      now,
		shutdownDeadline:  now.Add(cfg.Timeout),
		done:              make(chan struct{}),
		shutdownCh:        make(chan struct{}),
	}
}

// NewDetector creates a new idle detector (backwards compatibility).
func NewDetector(timeout, heartbeatInterval time.Duration, controlPlaneURL, workspaceID, callbackToken string) *Detector {
	return NewDetectorWithConfig(DetectorConfig{
		Timeout:           timeout,
		HeartbeatInterval: heartbeatInterval,
		IdleCheckInterval: 10 * time.Second,
		ControlPlaneURL:   controlPlaneURL,
		WorkspaceID:       workspaceID,
		CallbackToken:     callbackToken,
	})
}

// Start begins the idle detection loop.
func (d *Detector) Start() {
	heartbeatTicker := time.NewTicker(d.heartbeatInterval)
	defer heartbeatTicker.Stop()

	for {
		select {
		case <-d.done:
			return
		case <-heartbeatTicker.C:
			// Send heartbeat to control plane (informational only)
			d.SendHeartbeat()
		}
	}
}

// Stop stops the idle detector.
func (d *Detector) Stop() {
	select {
	case <-d.done:
		// Already stopped.
	default:
		close(d.done)
	}
}

// RecordActivity records user activity and extends the shutdown deadline.
func (d *Detector) RecordActivity() {
	now := time.Now()
	d.mu.Lock()
	d.lastActivity = now
	d.shutdownDeadline = now.Add(d.timeout)
	d.mu.Unlock()
}

// GetLastActivity returns the last activity time.
func (d *Detector) GetLastActivity() time.Time {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.lastActivity
}

// GetDeadline returns the shutdown deadline.
func (d *Detector) GetDeadline() time.Time {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.shutdownDeadline
}

// GetIdleTime returns how long the workspace has been idle.
func (d *Detector) GetIdleTime() time.Duration {
	return time.Since(d.GetLastActivity())
}

// IsIdle returns true if the current time has passed the shutdown deadline.
func (d *Detector) IsIdle() bool {
	return time.Now().After(d.GetDeadline())
}

// ShutdownChannel returns a channel that's closed when shutdown is requested.
func (d *Detector) ShutdownChannel() <-chan struct{} {
	return d.shutdownCh
}

// SendHeartbeat sends a heartbeat to the control plane.
// This is purely informational - the VM makes its own shutdown decisions.
func (d *Detector) SendHeartbeat() {
	if d.controlPlaneURL == "" || d.workspaceID == "" {
		return
	}

	idleTime := d.GetIdleTime()
	deadline := d.GetDeadline()
	isIdle := time.Now().After(deadline)

	payload := map[string]interface{}{
		"workspaceId":      d.workspaceID,
		"idleSeconds":      int(idleTime.Seconds()),
		"idle":             isIdle,
		"lastActivityAt":   d.GetLastActivity().Format(time.RFC3339),
		"shutdownDeadline": deadline.Format(time.RFC3339),
	}

	jsonData, err := json.Marshal(payload)
	if err != nil {
		log.Printf("Failed to marshal heartbeat: %v", err)
		return
	}

	url := d.controlPlaneURL + "/api/workspaces/" + d.workspaceID + "/heartbeat"
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		log.Printf("Failed to create heartbeat request: %v", err)
		return
	}

	req.Header.Set("Content-Type", "application/json")
	if d.callbackToken != "" {
		req.Header.Set("Authorization", "Bearer "+d.callbackToken)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		// Don't fail on heartbeat errors - VM manages its own lifecycle
		log.Printf("Failed to send heartbeat (non-critical): %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("Heartbeat returned status %d (non-critical)", resp.StatusCode)
		return
	}

	// Read and discard heartbeat response body for connection reuse.
	_ = json.NewDecoder(resp.Body).Decode(&struct{}{})
}

// GetWarningTime returns how much warning time is left before shutdown.
// Returns 0 if no warning should be shown.
func (d *Detector) GetWarningTime() time.Duration {
	deadline := d.GetDeadline()
	warningThreshold := 5 * time.Minute

	timeUntilShutdown := time.Until(deadline)

	if timeUntilShutdown > 0 && timeUntilShutdown <= warningThreshold {
		return timeUntilShutdown
	}

	return 0
}

// Done returns a channel that's closed when the detector is stopped.
func (d *Detector) Done() <-chan struct{} {
	return d.done
}
