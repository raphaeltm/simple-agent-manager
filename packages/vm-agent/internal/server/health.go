package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/deploy"
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

// setCallbackToken updates the callback token and propagates it to subsystems
// that can safely use a node-level token. Message reporters keep workspace
// tokens because they call workspace-scoped endpoints.
func (s *Server) setCallbackToken(token string) {
	s.callbackTokenMu.Lock()
	s.callbackToken = token
	s.callbackTokenMu.Unlock()

	// Propagate to error reporter.
	s.errorReporter.SetToken(token)

	// Propagate to all per-workspace message reporters.
	s.setTokenAllReporters()

	// Update ACP gateway config.
	s.acpConfig.CallbackToken = token

	for _, engine := range s.deploymentEnginesSnapshot() {
		engine.SetCallbackToken(token)
	}
}

func (s *Server) startNodeHealthReporter() {
	if s.config.ControlPlaneURL == "" || s.config.NodeID == "" || s.config.CallbackToken == "" {
		return
	}

	// Only start heartbeats here — NOT the ready callback.
	// The ready callback must be sent AFTER provisioning completes
	// (called explicitly from main.go via SendNodeReady).
	// Otherwise the control plane dispatches workspace creation
	// before Docker/Node.js are installed.
	go func() {
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

// SendNodeReady sends the one-time node-ready callback to the control plane.
// Call this AFTER system provisioning completes — not during server start.
func (s *Server) SendNodeReady() {
	s.sendNodeReady()
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
	Status          string `json:"status"`
	LastHeartbeatAt string `json:"lastHeartbeatAt"`
	HealthStatus    string `json:"healthStatus"`
	RefreshedToken  string `json:"refreshedToken,omitempty"`

	// Deployment mode fields
	PendingReleaseSeq int64  `json:"pendingReleaseSeq,omitempty"`
	DeployPubKey      string `json:"deployPubKey,omitempty"` // Refreshed signing public key (base64)
	Deployment        struct {
		Environments []struct {
			EnvironmentID string `json:"environmentId"`
		} `json:"environments,omitempty"`
		PendingReleases []struct {
			EnvironmentID string `json:"environmentId"`
			Seq           int64  `json:"seq"`
		} `json:"pendingReleases,omitempty"`
		DeployPubKey string `json:"deployPubKey,omitempty"`
	} `json:"deployment,omitempty"`
}

func (s *Server) sendNodeHeartbeat() {
	url := strings.TrimRight(s.config.ControlPlaneURL, "/") + "/api/nodes/" + s.config.NodeID + "/heartbeat"

	payload := map[string]interface{}{
		"activeWorkspaces": s.activeWorkspaceCount(),
		"nodeId":           s.config.NodeID,
	}

	// In deployment mode, include observed deployment state + disk telemetry per environment.
	if s.config.Role == config.RoleDeployment {
		engines := s.deploymentEnginesSnapshot()
		environments := make([]map[string]interface{}, 0, len(engines))
		for environmentID, engine := range engines {
			observed := engine.GetObserved()
			deployPayload := map[string]interface{}{
				"environmentId": environmentID,
				"appliedSeq":    observed.AppliedSeq,
				"status":        string(observed.Status),
				"errorMessage":  observed.ErrorMessage,
				"services":      observed.Services,
			}
			if observed.DeployStatus != nil {
				deployPayload["deployStatus"] = observed.DeployStatus
			}
			if observed.DiskTelemetry != nil {
				deployPayload["diskTelemetry"] = observed.DiskTelemetry
			}
			environments = append(environments, deployPayload)
		}
		payload["deployment"] = map[string]interface{}{"environments": environments}
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
	if err := json.Unmarshal(respBody, &hbResp); err != nil {
		slog.Warn("Failed to parse heartbeat response", "error", err)
		return
	}

	if hbResp.RefreshedToken != "" {
		s.setCallbackToken(hbResp.RefreshedToken)
		slog.Info("Callback token refreshed via heartbeat response")
	}

	// Deployment mode: handle pending release signal and key refresh
	if s.config.Role == config.RoleDeployment {
		deployPubKey := hbResp.DeployPubKey
		if hbResp.Deployment.DeployPubKey != "" {
			deployPubKey = hbResp.Deployment.DeployPubKey
		}
		for _, env := range hbResp.Deployment.Environments {
			s.ensureDeployEngine(env.EnvironmentID)
		}

		// Refresh signing public key if provided
		if deployPubKey != "" {
			for environmentID, engine := range s.deploymentEnginesSnapshot() {
				if err := engine.SetVerifierKey(deployPubKey); err != nil {
					slog.Error("deploy: failed to refresh signing public key", "environmentId", environmentID, "error", err)
				} else {
					slog.Info("deploy: signing public key refreshed from heartbeat", "environmentId", environmentID)
				}
			}
		}

		pendingReleases := hbResp.Deployment.PendingReleases
		if hbResp.PendingReleaseSeq > 0 {
			if s.config.EnvironmentID != "" {
				pendingReleases = append(pendingReleases, struct {
					EnvironmentID string `json:"environmentId"`
					Seq           int64  `json:"seq"`
				}{EnvironmentID: s.config.EnvironmentID, Seq: hbResp.PendingReleaseSeq})
			}
		}

		for _, pending := range pendingReleases {
			engine := s.ensureDeployEngine(pending.EnvironmentID)
			if engine == nil {
				continue
			}
			observed := engine.GetObserved()
			if pending.Seq <= observed.AppliedSeq {
				continue
			}
			slog.Info("deploy: pending release detected",
				"environmentId", pending.EnvironmentID,
				"pendingSeq", pending.Seq,
				"appliedSeq", observed.AppliedSeq)
			go func(environmentID string, seq int64, engine *deploy.Engine) {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
				defer cancel()
				if err := engine.FetchAndApply(ctx, seq); err != nil {
					slog.Error("deploy: fetch and apply failed",
						"environmentId", environmentID, "seq", seq, "error", err)
				}
			}(pending.EnvironmentID, pending.Seq, engine)
		}
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
