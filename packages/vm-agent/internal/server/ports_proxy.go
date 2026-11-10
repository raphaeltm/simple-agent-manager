package server

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"

	"github.com/workspace/vm-agent/internal/config"
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

	// Preview requests carry the Worker's SAM credential in the query while
	// Authorization belongs to the application. Authenticate a separate copy so
	// application Bearer auth cannot shadow the SAM token or be consumed by it.
	authRequest := r
	if strings.TrimSpace(r.URL.Query().Get("token")) != "" {
		authRequest = r.Clone(r.Context())
		authRequest.Header.Del("Authorization")
	}
	if !s.requireWorkspaceRequestAuth(w, authRequest, workspaceID) {
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

	// Share workspace-scoped lazy discovery with CLI forwarding. The discovery
	// cache is empty after reboot and port scanning may be disabled entirely.
	targetHost, err := s.resolveWorkspaceBridgeIP(workspaceID)
	if err != nil {
		slog.Error("Port proxy: failed to resolve container bridge IP", "workspaceId", workspaceID, "port", port, "error", err)
		writeError(w, http.StatusServiceUnavailable, fmt.Sprintf("Container bridge IP not available yet (try again in a few seconds): %v", err))
		return
	}

	if s.isOwnListenerTarget(targetHost, port) {
		slog.Warn("Port proxy refused: target is the vm-agent's own listener",
			"workspaceId", workspaceID,
			"port", port,
			"targetHost", targetHost,
			"action", "rejected")
		writeError(w, http.StatusForbidden, reservedAgentPortMessage(port))
		return
	}

	targetURLStr := fmt.Sprintf("http://%s:%d", targetHost, port)

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
		"target", targetURLStr,
		"forwardPath", forwardPath)

	s.servePortProxy(w, r, workspaceID, port, targetURLStr, forwardPath)
}

// servePortProxy builds a reverse proxy for a workspace port and serves the request.
// It sets the Host header to the original client-facing hostname (from X-Forwarded-Host)
// so that dev servers (Vite, Next.js, etc.) see the correct origin. Falls back to a
// hostname derived from ControlPlaneURL config if X-Forwarded-Host is absent.
func (s *Server) servePortProxy(w http.ResponseWriter, r *http.Request, workspaceID string, port int, targetURLStr string, forwardPath string) {
	targetURL, err := url.Parse(targetURLStr)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to build proxy target")
		return
	}

	proxy := httputil.NewSingleHostReverseProxy(targetURL)
	// Derive the expected public-facing hostname from config as the trusted value.
	// If X-Forwarded-Host from the API Worker matches this expected value, use it
	// (preserving the exact original hostname). Otherwise fall back to the derived
	// value. This validation prevents Host header injection if the VM agent is
	// accessed directly (bypassing the API Worker).
	baseDomain := config.DeriveBaseDomain(s.config.ControlPlaneURL)
	expectedHost := fmt.Sprintf("ws-%s--%d.%s", strings.ToLower(workspaceID), port, baseDomain)
	publicHost := expectedHost
	if fwdHost := r.Header.Get("X-Forwarded-Host"); fwdHost != "" && fwdHost == expectedHost {
		publicHost = fwdHost
	}
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Path = forwardPath
		req.URL.RawPath = ""
		req.Host = publicHost
		markProxiedRequest(req.Header)
		s.stripPortProxyCredentials(req)
		// Strip the auth token — it is consumed by the VM agent for authentication
		// and must not leak to the container app running on the forwarded port.
		q := req.URL.Query()
		q.Del("token")
		req.URL.RawQuery = q.Encode()
	}
	proxy.ErrorHandler = func(rw http.ResponseWriter, req *http.Request, proxyErr error) {
		slog.Error("Port proxy upstream error",
			"workspaceId", workspaceID,
			"port", port,
			"target", targetURLStr,
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
	var discoveryErr error
	if s.config.ContainerMode {
		wsDiscovery, discoveryErr = s.workspacePortDiscovery(workspaceID)
	}

	var detectedPorts interface{}
	if scanner != nil {
		detectedPorts = scanner.Ports()
	} else {
		detectedPorts = []interface{}{}
	}

	// Build diagnostic info to help debug port scanning issues.
	diag := map[string]interface{}{
		"scannerActive":   scanner != nil,
		"discoveryActive": wsDiscovery != nil,
		"portScanEnabled": s.config.PortScanEnabled,
		"containerMode":   s.config.ContainerMode,
		"version":         "v2-pathrw",
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
	} else if discoveryErr != nil {
		diag["containerIDError"] = discoveryErr.Error()
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
