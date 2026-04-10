package server

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

func nowUTC() time.Time {
	return time.Now().UTC()
}

// getCallbackToken returns the current callback token (thread-safe).
func (s *Server) getCallbackToken() string {
	s.callbackTokenMu.RLock()
	defer s.callbackTokenMu.RUnlock()
	return s.callbackToken
}

// setCallbackToken updates the callback token and propagates it to all
// subsystems that use it (error reporter, message reporter, ACP config,
// workspace runtimes). This mirrors UpdateAfterBootstrap's propagation.
func (s *Server) setCallbackToken(token string) {
	s.callbackTokenMu.Lock()
	s.callbackToken = token
	s.callbackTokenMu.Unlock()

	// Propagate to error reporter.
	s.errorReporter.SetToken(token)

	// Propagate to all per-workspace message reporters.
	s.setTokenAllReporters(token)

	// Update ACP gateway config.
	s.acpConfig.CallbackToken = token

	// Update all workspace runtimes.
	s.workspaceMu.Lock()
	for _, ws := range s.workspaces {
		ws.CallbackToken = token
	}
	s.workspaceMu.Unlock()
}

func (s *Server) startNodeHealthReporter() {
	if s.config.ControlPlaneURL == "" || s.config.NodeID == "" || s.config.CallbackToken == "" {
		return
	}

	go func() {
		s.sendNodeReady()
		ticker := time.NewTicker(s.config.HeartbeatInterval)
		defer ticker.Stop()

		for {
			select {
			case <-s.done:
				return
			case <-ticker.C:
				s.sendNodeHeartbeat()
			}
		}
	}()
}

func (s *Server) sendNodeReady() {
	url := strings.TrimRight(s.config.ControlPlaneURL, "/") + "/api/nodes/" + s.config.NodeID + "/ready"
	req, err := http.NewRequest(http.MethodPost, url, nil)
	if err != nil {
		slog.Error("Node ready callback request create failed", "error", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+s.getCallbackToken())

	resp, err := s.controlPlaneHTTPClient(0).Do(req)
	if err != nil {
		slog.Error("Node ready callback failed", "error", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		slog.Warn("Node ready callback returned non-success status", "statusCode", resp.StatusCode)
	}
}

// heartbeatResponse is the expected JSON response from the heartbeat endpoint.
type heartbeatResponse struct {
	Status         string `json:"status"`
	LastHeartbeatAt string `json:"lastHeartbeatAt"`
	HealthStatus   string `json:"healthStatus"`
	RefreshedToken string `json:"refreshedToken,omitempty"`
}

func (s *Server) sendNodeHeartbeat() {
	url := strings.TrimRight(s.config.ControlPlaneURL, "/") + "/api/nodes/" + s.config.NodeID + "/heartbeat"

	payload := map[string]interface{}{
		"activeWorkspaces": s.activeWorkspaceCount(),
		"nodeId":           s.config.NodeID,
	}

	// Enrich heartbeat with lightweight system metrics (procfs only, no exec calls).
	if s.sysInfoCollector != nil {
		if quick, err := s.sysInfoCollector.CollectQuick(); err == nil {
			payload["metrics"] = map[string]interface{}{
				"cpuLoadAvg1":   quick.CPULoadAvg1,
				"memoryPercent": quick.MemoryPercent,
				"diskPercent":   quick.DiskPercent,
			}
		} else {
			slog.Warn("Heartbeat metrics collection failed", "error", err)
		}
	}

	body, err := json.Marshal(payload)
	if err != nil {
		slog.Error("Node heartbeat payload marshal failed", "error", err)
		return
	}

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		slog.Error("Node heartbeat request create failed", "error", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+s.getCallbackToken())
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.controlPlaneHTTPClient(0).Do(req)
	if err != nil {
		slog.Error("Node heartbeat failed", "error", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		slog.Warn("Node heartbeat returned non-success status", "statusCode", resp.StatusCode)
		return
	}

	// Parse response to check for a refreshed callback token.
	respBody, readErr := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if readErr != nil {
		slog.Warn("Failed to read heartbeat response body", "error", readErr)
		return
	}

	var hbResp heartbeatResponse
	if json.Unmarshal(respBody, &hbResp) == nil && hbResp.RefreshedToken != "" {
		s.setCallbackToken(hbResp.RefreshedToken)
		slog.Info("Callback token refreshed via heartbeat response")
	}

	// Heartbeat succeeded — connectivity to the control plane is confirmed.
	// Retry any pending workspace-ready callbacks in a background goroutine
	// so the heartbeat ticker is not blocked by potentially slow HTTP calls.
	go func() {
		if !s.readyRetryMu.TryLock() {
			return // previous retry run still in flight — skip this cycle
		}
		defer s.readyRetryMu.Unlock()
		s.retryPendingReadyCallbacks()
	}()
}

// retryPendingReadyCallbacks checks for workspaces whose ready callback was not
// delivered and retries them. Called after a successful heartbeat proves that
// outbound connectivity to the control plane has been restored.
func (s *Server) retryPendingReadyCallbacks() {
	pending := s.pendingReadyCallbacks()
	if len(pending) == 0 {
		return
	}

	for _, p := range pending {
		status := p.Status
		if status == "" {
			status = "running"
		}

		body, err := json.Marshal(map[string]string{"status": status})
		if err != nil {
			slog.Error("Failed to marshal workspace-ready retry payload",
				"workspace", p.WorkspaceID, "error", err)
			continue
		}

		endpoint := strings.TrimRight(s.config.ControlPlaneURL, "/") +
			"/api/workspaces/" + p.WorkspaceID + "/ready"

		req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			slog.Error("Failed to create workspace-ready retry request",
				"workspace", p.WorkspaceID, "error", err)
			continue
		}
		req.Header.Set("Authorization", "Bearer "+p.CallbackToken)
		req.Header.Set("Content-Type", "application/json")

		resp, err := s.controlPlaneHTTPClient(s.config.WorkspaceReadyCallbackTimeout).Do(req)
		if err != nil {
			slog.Warn("Workspace-ready retry failed (will try again on next heartbeat)",
				"workspace", p.WorkspaceID, "error", err)
			continue
		}
		resp.Body.Close()

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			s.clearReadyCallbackPending(p.WorkspaceID)
			slog.Info("Workspace-ready callback delivered on heartbeat retry",
				"workspace", p.WorkspaceID, "status", status)
		} else if resp.StatusCode >= 400 && resp.StatusCode < 500 {
			// Permanent failure (e.g., workspace was already stopped/deleted)
			// — stop retrying.
			s.clearReadyCallbackPending(p.WorkspaceID)
			slog.Warn("Workspace-ready retry got permanent error, giving up",
				"workspace", p.WorkspaceID, "statusCode", resp.StatusCode)
		} else {
			slog.Warn("Workspace-ready retry got transient error (will try again)",
				"workspace", p.WorkspaceID, "statusCode", resp.StatusCode)
		}
	}
}

func (s *Server) activeWorkspaceCount() int {
	s.workspaceMu.RLock()
	defer s.workspaceMu.RUnlock()
	count := 0
	for _, runtime := range s.workspaces {
		if runtime.Status == "running" || runtime.Status == "recovery" {
			count++
		}
	}
	return count
}
