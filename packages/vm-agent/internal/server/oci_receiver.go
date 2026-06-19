package server

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"

	"github.com/workspace/vm-agent/internal/container"
	"github.com/workspace/vm-agent/internal/oci"
	"github.com/workspace/vm-agent/internal/publish"
)

type publishBridgeIPDiscovery interface {
	GetBridgeIP() (string, error)
}

var newPublishBridgeIPDiscovery = func(cfg container.Config) publishBridgeIPDiscovery {
	return container.NewDiscovery(cfg)
}

type publishCallbackCredentials struct {
	ProjectID   string
	WorkspaceID string
	Token       string
}

type publishWorkspaceSnapshot struct {
	ID                  string
	ProjectID           string
	CallbackToken       string
	ContainerLabelValue string
}

// startOCIReceiver brings up the local OCI registry receiver that captures
// `docker compose publish` artifacts from inside the workspace. It is a no-op
// unless the receiver is configured (cert/key + publish host present).
//
// The receiver serves TLS on its own loopback listener (OCIReceiverAddr) so the
// main agent HTTP server keeps owning the agent port. Receiver.Start blocks, so
// it runs in a goroutine; a clean Stop returns http.ErrServerClosed.
func (s *Server) startOCIReceiver() {
	if s == nil || s.config == nil || !s.config.OCIReceiverEnabled {
		return
	}

	log := slog.Default().With("component", "oci-receiver")
	s.ociReceiver = oci.New(oci.Options{
		Logger:    log,
		OnPublish: s.handlePublishCapture,
	})

	addr := s.config.OCIReceiverAddr
	certPath := s.config.OCIReceiverCertPath
	keyPath := s.config.OCIReceiverKeyPath

	// srv.Start() runs before any provision step, so generate the receiver's SAN
	// cert here (idempotent) before serving. Receiver.Start reads the files at
	// serve time, so they must exist first.
	if err := oci.EnsureCert(certPath, keyPath); err != nil {
		log.Error("failed to ensure OCI receiver cert; receiver disabled", "error", err)
		s.ociReceiver = nil
		return
	}

	log.Info("starting OCI receiver",
		"addr", addr,
		"publishHost", s.config.RegistryPublishHost,
		"projectId", s.config.ProjectID)

	go func() {
		if err := s.ociReceiver.Start(addr, certPath, keyPath); err != nil &&
			!errors.Is(err, http.ErrServerClosed) {
			log.Error("OCI receiver stopped with error", "error", err)
		}
	}()
}

// stopOCIReceiver gracefully shuts the receiver down. Safe to call when the
// receiver was never started.
func (s *Server) stopOCIReceiver(ctx context.Context) {
	if s == nil || s.ociReceiver == nil {
		return
	}
	if err := s.ociReceiver.Stop(ctx); err != nil {
		slog.Warn("Failed to stop OCI receiver", "error", err)
	}
}

// handlePublishCapture is the OnPublish callback fired when the receiver finishes
// capturing a `docker compose publish`. It re-pushes the captured built images
// into the project-scoped registry namespace and records a release via the
// control plane, using the callback token for the workspace whose devcontainer
// initiated the terminal compose artifact push.
func (s *Server) handlePublishCapture(ctx context.Context, cp *oci.CapturedPublish) error {
	creds := s.publishCallbackCredentials(cp)
	projectID := creds.ProjectID
	token := creds.Token

	log := slog.Default().With("component", "oci-receiver", "projectId", projectID)
	if creds.WorkspaceID != "" {
		log = log.With("workspaceId", creds.WorkspaceID)
	}
	if cp != nil && cp.SourceIP != "" {
		log = log.With("sourceIP", cp.SourceIP)
	}
	if projectID == "" || token == "" {
		log.Error("cannot process captured publish: missing project context",
			"hasProjectId", projectID != "",
			"hasCallbackToken", token != "")
		return errors.New("oci receiver: missing project context for publish")
	}

	orch := publish.New(publish.Options{
		ControlPlane: publish.NewHTTPControlPlane(publish.HTTPControlPlaneOptions{
			BaseURL: s.config.ControlPlaneURL,
			Token:   token,
			Client:  s.controlPlaneHTTPClient(0),
			Logger:  log,
		}),
		Docker:      publish.NewHostDocker(),
		PublishHost: s.config.RegistryPublishHost,
		Logger:      log,
	})

	result, err := orch.Publish(ctx, projectID, cp)
	if err != nil {
		log.Error("publish failed", "error", err)
		return err
	}
	log.Info("publish complete",
		"releaseId", result.ReleaseID,
		"version", result.Version,
		"status", result.Status)
	return nil
}

func (s *Server) publishCallbackCredentials(cp *oci.CapturedPublish) publishCallbackCredentials {
	if s == nil || s.config == nil {
		return publishCallbackCredentials{}
	}

	if runtime, ok := s.publishWorkspaceForSource(cp); ok {
		return publishCallbackCredentials{
			ProjectID:   firstNonEmpty(runtime.ProjectID, strings.TrimSpace(s.config.ProjectID)),
			WorkspaceID: runtime.ID,
			Token:       runtime.CallbackToken,
		}
	}

	// Compose-publish callbacks are workspace/project-scoped. The node heartbeat
	// loop may refresh s.callbackToken and config.CallbackToken may be node-scoped
	// on node-mode VMs, so only fall back to the boot token when the VM was
	// explicitly configured with a boot workspace.
	if workspaceID := strings.TrimSpace(s.config.WorkspaceID); workspaceID != "" {
		if token := s.workspaceCallbackToken(workspaceID); token != "" {
			return publishCallbackCredentials{
				ProjectID:   s.projectIDForPublishWorkspace(workspaceID),
				WorkspaceID: workspaceID,
				Token:       token,
			}
		}
		return publishCallbackCredentials{
			ProjectID:   s.projectIDForPublishWorkspace(workspaceID),
			WorkspaceID: workspaceID,
			Token:       strings.TrimSpace(s.config.CallbackToken),
		}
	}

	return publishCallbackCredentials{ProjectID: strings.TrimSpace(s.config.ProjectID)}
}

func (s *Server) publishWorkspaceForSource(cp *oci.CapturedPublish) (publishWorkspaceSnapshot, bool) {
	if s == nil || s.config == nil || cp == nil {
		return publishWorkspaceSnapshot{}, false
	}

	sourceIP := normalizePublishIP(firstNonEmpty(cp.SourceIP, cp.SourceRemoteAddr))
	if sourceIP == "" {
		return publishWorkspaceSnapshot{}, false
	}

	runtimes := s.publishWorkspaceSnapshots()
	var matched publishWorkspaceSnapshot
	matches := 0
	for _, runtime := range runtimes {
		if runtime.CallbackToken == "" || runtime.ContainerLabelValue == "" {
			continue
		}
		discovery := newPublishBridgeIPDiscovery(container.Config{
			LabelKey:    s.config.ContainerLabelKey,
			LabelValue:  runtime.ContainerLabelValue,
			CacheTTL:    s.config.ContainerCacheTTL,
			BridgeIPTTL: s.config.PortProxyCacheTTL,
		})
		bridgeIP, err := discovery.GetBridgeIP()
		if err != nil {
			slog.Debug("publish source workspace bridge IP lookup failed",
				"workspaceId", runtime.ID,
				"error", err)
			continue
		}
		if normalizePublishIP(bridgeIP) != sourceIP {
			continue
		}
		matched = runtime
		matches++
	}

	if matches == 1 {
		return matched, true
	}
	if matches > 1 {
		slog.Warn("publish source matched multiple workspace runtimes; refusing callback token",
			"sourceIP", sourceIP,
			"matches", matches)
	}
	return publishWorkspaceSnapshot{}, false
}

func (s *Server) publishWorkspaceSnapshots() []publishWorkspaceSnapshot {
	if s == nil {
		return nil
	}
	s.workspaceMu.RLock()
	defer s.workspaceMu.RUnlock()

	runtimes := make([]publishWorkspaceSnapshot, 0, len(s.workspaces))
	for _, runtime := range s.workspaces {
		if runtime == nil {
			continue
		}
		runtimes = append(runtimes, publishWorkspaceSnapshot{
			ID:                  strings.TrimSpace(runtime.ID),
			ProjectID:           strings.TrimSpace(runtime.ProjectID),
			CallbackToken:       strings.TrimSpace(runtime.CallbackToken),
			ContainerLabelValue: strings.TrimSpace(runtime.ContainerLabelValue),
		})
	}
	return runtimes
}

func (s *Server) projectIDForPublishWorkspace(workspaceID string) string {
	if runtime, ok := s.getWorkspaceRuntime(workspaceID); ok {
		if projectID := strings.TrimSpace(runtime.ProjectID); projectID != "" {
			return projectID
		}
	}
	return strings.TrimSpace(s.config.ProjectID)
}

func normalizePublishIP(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	host, _, err := net.SplitHostPort(trimmed)
	if err == nil {
		trimmed = host
	}
	trimmed = strings.Trim(trimmed, "[]")
	if ip := net.ParseIP(trimmed); ip != nil {
		return ip.String()
	}
	return trimmed
}
