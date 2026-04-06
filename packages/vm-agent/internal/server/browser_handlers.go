package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/browser"
	"github.com/workspace/vm-agent/internal/config"
)

// handleStartBrowser starts a Neko browser sidecar for a workspace.
// POST /workspaces/{workspaceId}/browser
func (s *Server) handleStartBrowser(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	if s.browserManager == nil {
		writeError(w, http.StatusServiceUnavailable, "browser sidecar not available")
		return
	}

	// Parse request body for viewport options
	var req struct {
		ViewportWidth    int    `json:"viewportWidth"`
		ViewportHeight   int    `json:"viewportHeight"`
		DevicePixelRatio int    `json:"devicePixelRatio"`
		IsTouchDevice    bool   `json:"isTouchDevice"`
		EnableAudio      *bool  `json:"enableAudio"`
		UserAgent        string `json:"userAgent"`
		StartURL         string `json:"startURL"`
	}
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			writeError(w, http.StatusBadRequest, "invalid JSON request body")
			return
		}
	}

	// Viewport bounds validation (configurable via NEKO_VIEWPORT_* env vars)
	if req.ViewportWidth != 0 && (req.ViewportWidth < s.config.NekoViewportMinWidth || req.ViewportWidth > s.config.NekoViewportMaxWidth) {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("viewportWidth must be between %d and %d", s.config.NekoViewportMinWidth, s.config.NekoViewportMaxWidth))
		return
	}
	if req.ViewportHeight != 0 && (req.ViewportHeight < s.config.NekoViewportMinHeight || req.ViewportHeight > s.config.NekoViewportMaxHeight) {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("viewportHeight must be between %d and %d", s.config.NekoViewportMinHeight, s.config.NekoViewportMaxHeight))
		return
	}
	if req.DevicePixelRatio != 0 && (req.DevicePixelRatio < 1 || req.DevicePixelRatio > s.config.NekoViewportMaxDPR) {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("devicePixelRatio must be between 1 and %d", s.config.NekoViewportMaxDPR))
		return
	}

	// Discover the DevContainer's network and name
	containerID, err := s.resolveContainerID(workspaceID)
	if err != nil {
		slog.Error("Failed to resolve DevContainer for browser sidecar",
			"workspace", workspaceID,
			"error", err,
		)
		writeError(w, http.StatusBadRequest, "workspace container not found — is the workspace running?")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.config.NekoBrowserStartTimeout)
	defer cancel()

	netInfo, err := browser.DiscoverContainerNetwork(ctx, s.browserManager.DockerExec(), containerID)
	if err != nil {
		slog.Error("Failed to discover container network",
			"workspace", workspaceID,
			"containerID", containerID,
			"error", err,
		)
		writeError(w, http.StatusInternalServerError, "failed to discover workspace network")
		return
	}

	// Auto-detect startURL from DevContainer ports when the client doesn't provide one.
	// This avoids frontend timing issues where detected ports haven't been polled yet
	// at the time the user clicks the Browser button.
	startURL := req.StartURL
	if startURL == "" {
		if ports, detectErr := s.browserManager.DetectDevContainerPorts(ctx, netInfo.ContainerName); detectErr == nil && len(ports) > 0 {
			sort.Ints(ports)
			startURL = fmt.Sprintf("http://localhost:%d", ports[0])
			slog.Info("Auto-detected startURL from DevContainer ports",
				"workspace", workspaceID, "port", ports[0], "totalPorts", len(ports))
		}
	}

	opts := browser.StartOptions{
		ViewportWidth:    req.ViewportWidth,
		ViewportHeight:   req.ViewportHeight,
		DevicePixelRatio: req.DevicePixelRatio,
		IsTouchDevice:    req.IsTouchDevice,
		EnableAudio:      req.EnableAudio,
		UserAgent:        req.UserAgent,
		StartURL:         startURL,
	}

	state, err := s.browserManager.Start(ctx, workspaceID, netInfo.NetworkName, netInfo.ContainerName, netInfo.IPAddress, opts)
	if err != nil {
		errMsg := "failed to start browser sidecar"
		if state != nil && state.Error != "" {
			errMsg = state.Error
		}
		writeError(w, http.StatusInternalServerError, errMsg)
		return
	}

	writeJSON(w, http.StatusOK, browserStateToResponse(state, workspaceID, s.config.ControlPlaneURL))
}

// handleGetBrowserStatus returns the status of a workspace's browser sidecar.
// GET /workspaces/{workspaceId}/browser
func (s *Server) handleGetBrowserStatus(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	if s.browserManager == nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{"status": "off"})
		return
	}

	state := s.browserManager.GetStatus(workspaceID)
	writeJSON(w, http.StatusOK, browserStateToResponse(state, workspaceID, s.config.ControlPlaneURL))
}

// handleStopBrowser stops and removes a workspace's browser sidecar.
// DELETE /workspaces/{workspaceId}/browser
func (s *Server) handleStopBrowser(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	if s.browserManager == nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{"status": "off"})
		return
	}

	// Use a detached context with timeout so stop isn't cancelled by the client disconnecting
	ctx, cancel := context.WithTimeout(context.Background(), s.config.NekoBrowserStopTimeout)
	defer cancel()

	if err := s.browserManager.Stop(ctx, workspaceID); err != nil {
		slog.Error("Failed to stop browser sidecar",
			"workspace", workspaceID,
			"error", err,
		)
		writeError(w, http.StatusInternalServerError, "failed to stop browser sidecar")
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"status": "off"})
}

// handleGetBrowserPorts returns the active socat forwarders for a workspace's sidecar.
// GET /workspaces/{workspaceId}/browser/ports
func (s *Server) handleGetBrowserPorts(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	if s.browserManager == nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{"ports": []interface{}{}})
		return
	}

	ports := s.browserManager.GetPorts(workspaceID)
	if ports == nil {
		ports = []browser.PortForwarder{}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"ports": ports})
}

// resolveContainerID finds the DevContainer ID for a workspace.
func (s *Server) resolveContainerID(workspaceID string) (string, error) {
	// Try per-workspace discovery first (used by port proxy)
	s.portScannerMu.RLock()
	disc, ok := s.portDiscoveries[workspaceID]
	s.portScannerMu.RUnlock()
	if ok {
		return disc.GetContainerID()
	}

	// Fall back to main discovery
	if s.containerDiscovery != nil {
		return s.containerDiscovery.GetContainerID()
	}

	return "", fmt.Errorf("no container discovery available for workspace %s", workspaceID)
}

// browserStateToResponse converts internal state to the API response shape.
func browserStateToResponse(state *browser.SidecarState, workspaceID, controlPlaneURL string) map[string]interface{} {
	resp := map[string]interface{}{
		"status": string(state.Status),
	}

	if state.ContainerName != "" {
		resp["containerName"] = state.ContainerName
	}
	if state.Error != "" {
		// Sanitize — do not leak Docker internals to the client
		resp["error"] = "browser sidecar failed to start"
		slog.Debug("Browser sidecar error detail", "workspace", workspaceID, "error", state.Error)
	}
	if state.NekoPort > 0 && state.Status == browser.StatusRunning {
		// Use named sidecar alias instead of numeric port to avoid collision with
		// DevContainer ports. ws-{id}--browser routes to the Neko container exclusively.
		baseDomain := deriveBaseDomainFromURL(controlPlaneURL)
		if baseDomain != "" {
			baseURL := "https://ws-" + workspaceID + "--browser." + baseDomain
			resp["url"] = baseURL
			// Include auto-login URL with Neko credentials so the user doesn't
			// have to enter a password. Neko's connect.vue auto-connects when
			// both ?usr= and ?pwd= query params are present.
			if state.Password != "" {
				resp["autoLoginUrl"] = baseURL + "?usr=user&pwd=" + state.Password
			}
		}
	}
	if len(state.Forwarders) > 0 {
		resp["ports"] = state.Forwarders
	}

	return resp
}

// handleBrowserProxy proxies HTTP/WebSocket requests to the Neko browser sidecar.
// This is the endpoint for ws-{id}--browser.{domain} subdomain routing.
// GET/POST/etc. /workspaces/{workspaceId}/browser/proxy/{path...}
func (s *Server) handleBrowserProxy(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	if s.browserManager == nil {
		writeError(w, http.StatusServiceUnavailable, "browser sidecar not available")
		return
	}

	nekoIP, nekoPort, err := s.browserManager.GetNekoBridgeIP(r.Context(), workspaceID)
	if err != nil {
		slog.Error("Failed to resolve Neko container bridge IP",
			"workspace", workspaceID,
			"error", err,
		)
		writeError(w, http.StatusServiceUnavailable, "browser sidecar not running or not ready")
		return
	}

	targetURLStr := fmt.Sprintf("http://%s:%d", nekoIP, nekoPort)

	forwardPath := r.PathValue("path")
	if forwardPath == "" {
		forwardPath = "/"
	} else if forwardPath[0] != '/' {
		forwardPath = "/" + forwardPath
	}

	slog.Info("Browser proxy forwarding",
		"workspaceId", workspaceID,
		"target", targetURLStr,
		"forwardPath", forwardPath)

	s.serveBrowserProxy(w, r, workspaceID, targetURLStr, forwardPath)
}

// serveBrowserProxy builds a reverse proxy for the Neko sidecar and serves the request.
// Similar to servePortProxy but uses the sidecar alias hostname for Host header validation.
func (s *Server) serveBrowserProxy(w http.ResponseWriter, r *http.Request, workspaceID string, targetURLStr string, forwardPath string) {
	targetURL, err := url.Parse(targetURLStr)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to build proxy target")
		return
	}

	proxy := httputil.NewSingleHostReverseProxy(targetURL)
	baseDomain := config.DeriveBaseDomain(s.config.ControlPlaneURL)
	expectedHost := fmt.Sprintf("ws-%s--browser.%s", strings.ToLower(workspaceID), baseDomain)
	publicHost := expectedHost
	if fwdHost := r.Header.Get("X-Forwarded-Host"); fwdHost != "" {
		if fwdHost == expectedHost {
			publicHost = fwdHost
		} else {
			slog.Debug("Browser proxy: X-Forwarded-Host mismatch, using derived host",
				"workspaceId", workspaceID,
				"got", fwdHost,
				"expected", expectedHost)
		}
	}
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Path = forwardPath
		req.URL.RawPath = ""
		req.Host = publicHost
		q := req.URL.Query()
		q.Del("token")
		req.URL.RawQuery = q.Encode()
	}
	proxy.ErrorHandler = func(rw http.ResponseWriter, req *http.Request, proxyErr error) {
		slog.Error("Browser proxy upstream error",
			"workspaceId", workspaceID,
			"target", targetURLStr,
			"error", proxyErr)
		writeError(rw, http.StatusBadGateway, "browser sidecar unavailable")
	}
	proxy.ServeHTTP(w, r)
}

// stopBrowserSidecarWithTimeout stops the browser sidecar using a background context
// with a timeout. Use this in workspace lifecycle handlers where the request context
// may be cancelled before the stop completes.
func (s *Server) stopBrowserSidecarWithTimeout(workspaceID string, timeout time.Duration) {
	if s.browserManager == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := s.browserManager.Stop(ctx, workspaceID); err != nil {
		slog.Warn("Failed to stop browser sidecar during workspace cleanup",
			"workspace", workspaceID,
			"error", err,
		)
	}
}

// deriveBaseDomainFromURL extracts the base domain from a control plane URL.
func deriveBaseDomainFromURL(controlPlaneURL string) string {
	return config.DeriveBaseDomain(controlPlaneURL)
}
