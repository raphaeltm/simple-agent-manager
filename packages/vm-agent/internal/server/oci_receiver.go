package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/workspace/vm-agent/internal/oci"
	"github.com/workspace/vm-agent/internal/publish"
)

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
// control plane, using the boot workspace's project + callback token.
func (s *Server) handlePublishCapture(ctx context.Context, cp *oci.CapturedPublish) error {
	projectID := s.config.ProjectID
	token := s.publishCallbackToken()

	log := slog.Default().With("component", "oci-receiver", "projectId", projectID)
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

func (s *Server) publishCallbackToken() string {
	if s == nil || s.config == nil {
		return ""
	}

	// Compose-publish callbacks are workspace/project-scoped. The node heartbeat
	// loop may refresh s.callbackToken to a node-scoped token, so do not use
	// getCallbackToken() here.
	if workspaceID := strings.TrimSpace(s.config.WorkspaceID); workspaceID != "" {
		if token := s.workspaceCallbackToken(workspaceID); token != "" {
			return token
		}
	}
	return strings.TrimSpace(s.config.CallbackToken)
}
