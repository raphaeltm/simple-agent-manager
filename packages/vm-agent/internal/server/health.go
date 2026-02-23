package server

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

func nowUTC() time.Time {
	return time.Now().UTC()
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
			case <-s.idleDetector.Done():
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
	req.Header.Set("Authorization", "Bearer "+s.config.CallbackToken)

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

	body, _ := json.Marshal(payload)

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		slog.Error("Node heartbeat request create failed", "error", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+s.config.CallbackToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		slog.Error("Node heartbeat failed", "error", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		slog.Warn("Node heartbeat returned non-success status", "statusCode", resp.StatusCode)
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
