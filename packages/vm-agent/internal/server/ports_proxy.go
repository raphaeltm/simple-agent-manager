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

	slog.Info("Port proxy request received",
		"workspaceId", workspaceID,
		"port", r.PathValue("port"),
		"method", r.Method,
		"path", r.URL.Path,
		"remoteAddr", r.RemoteAddr)

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
	targetHost := "127.0.0.1"
	if s.containerDiscovery != nil {
		bridgeIP, bridgeErr := s.containerDiscovery.GetBridgeIP()
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

	slog.Info("Port proxy forwarding",
		"workspaceId", workspaceID,
		"port", port,
		"target", targetURL.String())

	proxy := httputil.NewSingleHostReverseProxy(targetURL)
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
