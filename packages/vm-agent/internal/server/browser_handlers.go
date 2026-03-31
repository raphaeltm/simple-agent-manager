package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"

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
		_ = json.NewDecoder(r.Body).Decode(&req)
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
		writeError(w, http.StatusInternalServerError, state.Error)
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

	ctx, cancel := context.WithTimeout(r.Context(), s.config.NekoBrowserStopTimeout)
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

	return "", nil
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
		resp["nekoPort"] = state.NekoPort
		// Build the proxy URL using SAM's existing port proxy pattern.
		baseDomain := deriveBaseDomainFromURL(controlPlaneURL)
		if baseDomain != "" {
			resp["url"] = "https://ws-" + workspaceID + "--" + itoa(state.NekoPort) + "." + baseDomain
		}
	}
	if len(state.Forwarders) > 0 {
		resp["ports"] = state.Forwarders
	}

	return resp
}

// deriveBaseDomainFromURL extracts the base domain from a control plane URL.
func deriveBaseDomainFromURL(controlPlaneURL string) string {
	return config.DeriveBaseDomain(controlPlaneURL)
}

func itoa(n int) string {
	return strconv.Itoa(n)
}
