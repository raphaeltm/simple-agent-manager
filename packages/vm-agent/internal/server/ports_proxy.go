package server

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
)

// handleWorkspacePortProxy proxies workspace port traffic through the node agent.
// Each workspace has an isolated route path, avoiding host-port publication conflicts.
// Proxies to the container's bridge IP (not 127.0.0.1) so each workspace is isolated.
func (s *Server) handleWorkspacePortProxy(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	slog.Info("Port proxy request received (v2-pathrw)",
		"workspaceId", workspaceID,
		"port", r.PathValue("port"),
		"method", r.Method,
		"path", r.URL.Path,
		"remoteAddr", r.RemoteAddr)
	// Debug header to verify which binary version is running.
	w.Header().Set("X-SAM-Port-Proxy", "v2-pathrw")

	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		slog.Warn("Port proxy auth failed",
			"workspaceId", workspaceID,
			"port", r.PathValue("port"))
		return
	}

	portValue := r.PathValue("port")
	port, err := strconv.Atoi(portValue)
	if err != nil || port <= 0 || port > 65535 {
		writeError(w, http.StatusBadRequest, "invalid port")
		return
	}

	// Resolve the container bridge IP for workspace isolation.
	// In container mode, the bridge IP is required — we cannot fall back to 127.0.0.1
	// because the service runs inside the container, not on the host.
	//
	// Use per-workspace discovery (portDiscoveries) when available, because the
	// server-level containerDiscovery may have a stale label value (e.g., "/workspace"
	// when REPOSITORY was empty at startup). Per-workspace discoveries are created
	// in StartPortScanner with the correct label for the workspace's repository.
	targetHost := "127.0.0.1"
	discovery := s.containerDiscovery // fallback
	s.portScannerMu.RLock()
	if wsDisc, ok := s.portDiscoveries[workspaceID]; ok {
		discovery = wsDisc
	}
	s.portScannerMu.RUnlock()

	if discovery != nil {
		bridgeIP, bridgeErr := discovery.GetBridgeIP()
		if bridgeErr == nil {
			targetHost = bridgeIP
			slog.Debug("Port proxy resolved bridge IP",
				"workspaceId", workspaceID,
				"port", port,
				"bridgeIP", bridgeIP)
		} else {
			slog.Error("Port proxy: failed to resolve container bridge IP",
				"workspaceId", workspaceID,
				"port", port,
				"error", bridgeErr)
			// In container mode, falling back to 127.0.0.1 is wrong — the service
			// runs inside the container at the bridge IP, not on the host.
			// Return 503 so the client can retry after the container is ready.
			writeError(w, http.StatusServiceUnavailable,
				fmt.Sprintf("Container bridge IP not available yet (try again in a few seconds): %v", bridgeErr))
			return
		}
	}

	targetURL, err := url.Parse(fmt.Sprintf("http://%s:%d", targetHost, port))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to build proxy target")
		return
	}

	// Extract the remainder path after /workspaces/{id}/ports/{port}.
	// The {path...} wildcard captures everything after the port segment.
	// If there's no remainder (route matched without {path...}), default to "/".
	forwardPath := r.PathValue("path")
	if forwardPath == "" {
		forwardPath = "/"
	} else if forwardPath[0] != '/' {
		forwardPath = "/" + forwardPath
	}

	slog.Info("Port proxy forwarding",
		"workspaceId", workspaceID,
		"port", port,
		"target", targetURL.String(),
		"forwardPath", forwardPath)

	proxy := httputil.NewSingleHostReverseProxy(targetURL)
	// Rewrite the request path to strip the /workspaces/{id}/ports/{port} prefix.
	// Without this, the container receives the full VM agent path instead of just
	// the intended path (e.g., "/" or "/api/data").
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Path = forwardPath
		req.URL.RawPath = ""
	}
	proxy.ErrorHandler = func(rw http.ResponseWriter, req *http.Request, proxyErr error) {
		slog.Error("Port proxy upstream error",
			"workspaceId", workspaceID,
			"port", port,
			"target", targetURL.String(),
			"error", proxyErr)
		writeError(rw, http.StatusBadGateway, fmt.Sprintf("port proxy error: %v", proxyErr))
	}
	proxy.ServeHTTP(w, r)
}

// handleListWorkspacePorts returns the list of detected ports for a workspace.
func (s *Server) handleListWorkspacePorts(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	s.portScannerMu.RLock()
	scanner := s.portScanners[workspaceID]
	wsDiscovery := s.portDiscoveries[workspaceID]
	s.portScannerMu.RUnlock()

	var detectedPorts interface{}
	if scanner != nil {
		detectedPorts = scanner.Ports()
	} else {
		detectedPorts = []interface{}{}
	}

	// Build diagnostic info to help debug port scanning issues.
	diag := map[string]interface{}{
		"scannerActive":    scanner != nil,
		"discoveryActive":  wsDiscovery != nil,
		"portScanEnabled":  s.config.PortScanEnabled,
		"containerMode":    s.config.ContainerMode,
		"version":          "v2-pathrw",
	}
	if wsDiscovery != nil {
		if containerID, err := wsDiscovery.GetContainerID(); err == nil {
			diag["containerID"] = containerID
		} else {
			diag["containerIDError"] = err.Error()
		}
		if bridgeIP, err := wsDiscovery.GetBridgeIP(); err == nil {
			diag["bridgeIP"] = bridgeIP
		} else {
			diag["bridgeIPError"] = err.Error()
		}
	} else if s.containerDiscovery != nil {
		diag["fallbackDiscovery"] = true
		if containerID, err := s.containerDiscovery.GetContainerID(); err == nil {
			diag["containerID"] = containerID
		} else {
			diag["containerIDError"] = err.Error()
		}
	}
	// Include workspace runtime info
	s.workspaceMu.RLock()
	if runtime, ok := s.workspaces[workspaceID]; ok {
		diag["containerLabelValue"] = runtime.ContainerLabelValue
		diag["workspaceDir"] = runtime.WorkspaceDir
	}
	s.workspaceMu.RUnlock()

	if scanner != nil {
		diag["consecutiveFailures"] = scanner.ConsecutiveFailures()
		diag["containerResolved"] = scanner.ContainerResolved()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ports":       detectedPorts,
		"diagnostics": diag,
	})
}
