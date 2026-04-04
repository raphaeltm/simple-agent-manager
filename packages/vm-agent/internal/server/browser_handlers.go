package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
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
		ViewportWidth    int   `json:"viewportWidth"`
		ViewportHeight   int   `json:"viewportHeight"`
		DevicePixelRatio int   `json:"devicePixelRatio"`
		IsTouchDevice    bool  `json:"isTouchDevice"`
		EnableAudio      *bool `json:"enableAudio"`
	}
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
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

	opts := browser.StartOptions{
		ViewportWidth:    req.ViewportWidth,
		ViewportHeight:   req.ViewportHeight,
		DevicePixelRatio: req.DevicePixelRatio,
		IsTouchDevice:    req.IsTouchDevice,
		EnableAudio:      req.EnableAudio,
	}

	state, err := s.browserManager.Start(ctx, workspaceID, netInfo.NetworkName, netInfo.ContainerName, opts)
	if err != nil {
		errMsg := "failed to start browser sidecar"
		if state != nil && state.Error != "" {
			errMsg = state.Error
		}
		writeError(w, http.StatusInternalServerError, errMsg)
		return
	}

	writeJSON(w, http.StatusOK, browserStateToResponse(state, workspaceID, s.config.ControlPlaneURL, s.config.NekoPassword))
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
	writeJSON(w, http.StatusOK, browserStateToResponse(state, workspaceID, s.config.ControlPlaneURL, s.config.NekoPassword))
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
func browserStateToResponse(state *browser.SidecarState, workspaceID, controlPlaneURL, nekoPassword string) map[string]interface{} {
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
		// Do NOT expose nekoPort in the response — it leaks internal container topology
		// and enables direct container bypass. The proxy URL is sufficient for the UI.
		baseDomain := deriveBaseDomainFromURL(controlPlaneURL)
		if baseDomain != "" {
			// Append auto-login query params so the user connects without manual credentials.
		// Neko supports ?usr= and ?pwd= for prefilling the login form.
		resp["url"] = "https://ws-" + workspaceID + "--" + itoa(state.NekoPort) + "." + baseDomain + "?usr=user&pwd=" + nekoPassword
		}
	}
	if len(state.Forwarders) > 0 {
		resp["ports"] = state.Forwarders
	}

	return resp
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

func itoa(n int) string {
	return strconv.Itoa(n)
}
