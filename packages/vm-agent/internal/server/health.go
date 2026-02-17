package server

import (
	"bytes"
	"encoding/json"
	"log"
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
		log.Printf("Node ready callback request create failed: %v", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+s.config.CallbackToken)

	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		log.Printf("Node ready callback failed: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		log.Printf("Node ready callback returned status %d", resp.StatusCode)
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
			log.Printf("Heartbeat metrics collection failed: %v", err)
		}
	}

	body, _ := json.Marshal(payload)

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		log.Printf("Node heartbeat request create failed: %v", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+s.config.CallbackToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		log.Printf("Node heartbeat failed: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		log.Printf("Node heartbeat returned status %d", resp.StatusCode)
	}
}

func (s *Server) activeWorkspaceCount() int {
	s.workspaceMu.RLock()
	defer s.workspaceMu.RUnlock()
	count := 0
	for _, runtime := range s.workspaces {
		if runtime.Status == "running" {
			count++
		}
	}
	return count
}
