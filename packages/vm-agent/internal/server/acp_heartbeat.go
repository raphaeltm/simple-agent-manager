package server

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// startAcpHeartbeatReporter starts a background goroutine that sends direct
// ACP session heartbeats to the control plane for each active workspace's project.
//
// This is the primary ACP heartbeat mechanism — a simple 2-hop chain
// (VM agent → ProjectData DO) that replaces the fragile 7-hop piggybacking
// sweep through the node heartbeat handler in nodes.ts.
//
// The goroutine collects unique projectIDs from active workspace runtimes and
// POSTs to the node-level ACP heartbeat endpoint for each project. This updates
// all active ACP sessions on this node within each project.
func (s *Server) startAcpHeartbeatReporter() {
	if s.config.ControlPlaneURL == "" || s.config.NodeID == "" {
		return
	}

	interval := s.config.ACPHeartbeatInterval
	if interval <= 0 {
		interval = 60 * time.Second
	}

	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-s.done:
				return
			case <-ticker.C:
				s.sendAcpHeartbeats()
			}
		}
	}()
}

// sendAcpHeartbeats collects unique (projectID) values from active workspace
// runtimes and sends a node-level ACP heartbeat for each project.
func (s *Server) sendAcpHeartbeats() {
	projectIDs := s.activeProjectIDs()
	if len(projectIDs) == 0 {
		return
	}

	nodeID := s.config.NodeID
	token := s.getCallbackToken()
	if token == "" {
		slog.Warn("acp_heartbeat: skipping — no callback token")
		return
	}

	for _, projectID := range projectIDs {
		s.sendAcpHeartbeatForProject(projectID, nodeID, token)
	}
}

// activeProjectIDs returns deduplicated project IDs from running workspace runtimes.
func (s *Server) activeProjectIDs() []string {
	s.workspaceMu.RLock()
	defer s.workspaceMu.RUnlock()

	seen := make(map[string]struct{})
	var result []string
	for _, ws := range s.workspaces {
		if ws.ProjectID == "" {
			continue
		}
		if ws.Status != "running" && ws.Status != "recovery" {
			continue
		}
		if _, ok := seen[ws.ProjectID]; !ok {
			seen[ws.ProjectID] = struct{}{}
			result = append(result, ws.ProjectID)
		}
	}
	return result
}

// sendAcpHeartbeatForProject POSTs a node-level ACP heartbeat for a single project.
func (s *Server) sendAcpHeartbeatForProject(projectID, nodeID, token string) {
	url := strings.TrimRight(s.config.ControlPlaneURL, "/") +
		"/api/projects/" + projectID + "/node-acp-heartbeat"

	body, err := json.Marshal(map[string]string{"nodeId": nodeID})
	if err != nil {
		slog.Error("acp_heartbeat: marshal failed", "projectId", projectID, "error", err)
		return
	}

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		slog.Error("acp_heartbeat: request create failed", "projectId", projectID, "error", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.controlPlaneHTTPClient(0).Do(req)
	if err != nil {
		slog.Warn("acp_heartbeat: request failed", "projectId", projectID, "error", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		slog.Warn("acp_heartbeat: non-success status",
			"projectId", projectID,
			"nodeId", nodeID,
			"statusCode", resp.StatusCode,
		)
	}
}
