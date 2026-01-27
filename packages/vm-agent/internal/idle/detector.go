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
	controlPlaneURL   string
	workspaceID       string
	callbackToken     string

	lastActivity time.Time
	mu           sync.RWMutex
	done         chan struct{}
	shutdownCh   chan struct{}
}

// NewDetector creates a new idle detector.
func NewDetector(timeout, heartbeatInterval time.Duration, controlPlaneURL, workspaceID, callbackToken string) *Detector {
	return &Detector{
		timeout:           timeout,
		heartbeatInterval: heartbeatInterval,
		controlPlaneURL:   controlPlaneURL,
		workspaceID:       workspaceID,
		callbackToken:     callbackToken,
		lastActivity:      time.Now(),
		done:              make(chan struct{}),
		shutdownCh:        make(chan struct{}),
	}
}

// Start begins the idle detection loop.
func (d *Detector) Start() {
	ticker := time.NewTicker(d.heartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-d.done:
			return
		case <-ticker.C:
			d.sendHeartbeat()
		}
	}
}

// Stop stops the idle detector.
func (d *Detector) Stop() {
	close(d.done)
}

// RecordActivity records user activity.
func (d *Detector) RecordActivity() {
	d.mu.Lock()
	d.lastActivity = time.Now()
	d.mu.Unlock()
}

// GetLastActivity returns the last activity time.
func (d *Detector) GetLastActivity() time.Time {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.lastActivity
}

// GetIdleTime returns how long the workspace has been idle.
func (d *Detector) GetIdleTime() time.Duration {
	return time.Since(d.GetLastActivity())
}

// IsIdle returns true if the workspace has been idle longer than the timeout.
func (d *Detector) IsIdle() bool {
	return d.GetIdleTime() > d.timeout
}

// ShutdownChannel returns a channel that's closed when shutdown is requested.
func (d *Detector) ShutdownChannel() <-chan struct{} {
	return d.shutdownCh
}

// sendHeartbeat sends a heartbeat to the control plane.
func (d *Detector) sendHeartbeat() {
	idleTime := d.GetIdleTime()
	isIdle := idleTime > d.timeout

	payload := map[string]interface{}{
		"workspaceId":     d.workspaceID,
		"idleSeconds":     int(idleTime.Seconds()),
		"idle":            isIdle,
		"lastActivityAt":  d.GetLastActivity().Format(time.RFC3339),
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
		log.Printf("Failed to send heartbeat: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("Heartbeat returned status %d", resp.StatusCode)
		return
	}

	// Check for shutdown action in response
	var response struct {
		Action string `json:"action"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&response); err == nil {
		if response.Action == "shutdown" {
			log.Println("Shutdown requested by control plane")
			select {
			case <-d.shutdownCh:
				// Already closed
			default:
				close(d.shutdownCh)
			}
		}
	}
}

// GetWarningTime returns how much warning time is left before shutdown.
// Returns 0 if no warning should be shown.
func (d *Detector) GetWarningTime() time.Duration {
	idleTime := d.GetIdleTime()
	warningThreshold := d.timeout - 5*time.Minute // Warn 5 minutes before

	if idleTime > warningThreshold {
		remaining := d.timeout - idleTime
		if remaining > 0 {
			return remaining
		}
	}
	return 0
}
