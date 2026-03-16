package server

import (
	"encoding/json"
	"fmt"
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

	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	portValue := r.PathValue("port")
	port, err := strconv.Atoi(portValue)
	if err != nil || port <= 0 || port > 65535 {
		writeError(w, http.StatusBadRequest, "invalid port")
		return
	}

	// Resolve the container bridge IP for workspace isolation.
	// Falls back to 127.0.0.1 if bridge IP resolution fails (e.g., non-container mode).
	targetHost := "127.0.0.1"
	if s.containerDiscovery != nil {
		if bridgeIP, err := s.containerDiscovery.GetBridgeIP(); err == nil {
			targetHost = bridgeIP
		}
	}

	targetURL, err := url.Parse(fmt.Sprintf("http://%s:%d", targetHost, port))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to build proxy target")
		return
	}

	proxy := httputil.NewSingleHostReverseProxy(targetURL)
	proxy.ErrorHandler = func(rw http.ResponseWriter, req *http.Request, proxyErr error) {
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
	s.portScannerMu.RUnlock()

	var ports interface{}
	if scanner != nil {
		ports = scanner.Ports()
	} else {
		ports = []interface{}{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ports": ports,
	})
}
