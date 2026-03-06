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

	// Propagate to message reporter (nil-safe).
	if s.messageReporter != nil {
		s.messageReporter.SetToken(token)
	}

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

	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
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

	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
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
