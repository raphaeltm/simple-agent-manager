// VM Agent - Terminal server for Simple Agent Manager
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"fmt"

	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/logging"
	"github.com/workspace/vm-agent/internal/provision"
	"github.com/workspace/vm-agent/internal/server"
)

func main() {
	logging.Setup()
	slog.Info("Starting VM Agent...")

	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		slog.Error("Failed to load configuration", "error", err)
		os.Exit(1)
	}
	if err := cfg.Validate(); err != nil {
		slog.Error("Configuration validation failed", "error", err)
		os.Exit(1)
	}

	reporter := bootlog.New(cfg.ControlPlaneURL, cfg.NodeID)

	slog.Info("Configuration loaded", "node", cfg.NodeID, "port", cfg.Port)

	// Create server BEFORE bootstrap so /health and /boot-log/ws are available
	// while the workspace is still being provisioned. This allows the API's
	// waitForNodeAgentReady() to succeed and UI clients to connect for real-time
	// boot log streaming during the "creating" phase.
	srv, err := server.New(cfg)
	if err != nil {
		slog.Error("Failed to create server", "error", err)
		os.Exit(1)
	}

	// Wire boot-log reporter into ACP gateway for agent error reporting
	srv.SetBootLog(reporter)

	// Wire broadcaster for real-time WebSocket delivery of boot logs
	reporter.SetBroadcaster(srv.GetBootLogBroadcaster())

	// Handle shutdown signals
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	// Start server in goroutine — HTTP is available immediately.
	// This means /health responds right away, allowing the control plane
	// to detect the agent within seconds of boot.
	errCh := make(chan error, 1)
	go func() {
		if err := srv.Start(); err != nil {
			errCh <- err
		}
	}()

	// Run system provisioning (firewall, Node.js, devcontainer CLI, etc.)
	// BEFORE workspace bootstrap. This replaces the slow cloud-init runcmd
	// steps — the agent is already running and heartbeating while this happens.
	provisionCtx, provisionCancel := context.WithTimeout(context.Background(), 15*time.Minute)
	provisionStatus, provisionErr := provision.Run(provisionCtx, provision.Config{
		VMAgentPort:      fmt.Sprintf("%d", cfg.Port),
		CFIPFetchTimeout: "10",
	}, srv.GetEventStore())
	provisionCancel()

	if provisionErr != nil {
		slog.Error("System provisioning failed", "error", provisionErr,
			"phase", provisionStatus.Phase,
			"completedSteps", countCompleted(provisionStatus.Steps))
		// Don't exit — the agent should keep running for diagnostics.
		// Bootstrap will likely fail (no devcontainer CLI), but the agent
		// stays up so we can download logs and debug.
	} else {
		slog.Info("System provisioning completed",
			"duration", provisionStatus.CompletedAt.Sub(provisionStatus.StartedAt).Round(time.Millisecond))
	}

	// Send node-ready callback AFTER provisioning. This tells the control plane
	// to start dispatching workspace creation. If we send it earlier (e.g. when
	// the HTTP server starts), the control plane creates workspaces before Docker
	// is installed, causing "docker: executable file not found" failures.
	srv.SendNodeReady()

	// Run bootstrap (blocks until workspace is provisioned).
	// The server is already serving /health and /boot-log/ws during this time.
	bootstrapCtx, bootstrapCancel := context.WithTimeout(context.Background(), cfg.BootstrapTimeout)
	defer bootstrapCancel()

	if err := bootstrap.Run(bootstrapCtx, cfg, reporter); err != nil {
		slog.Error("Bootstrap failed", "error", err)
		os.Exit(1)
	}

	// Propagate callback token (obtained during bootstrap) to all subsystems
	// and notify WebSocket clients that bootstrap is complete.
	srv.UpdateAfterBootstrap(cfg)

	// Wait for shutdown signal or fatal server error.
	select {
	case err := <-errCh:
		slog.Error("Server error", "error", err)
		os.Exit(1)
	case sig := <-sigCh:
		slog.Info("Received signal, shutting down...", "signal", sig)
		srv.StopAllWorkspacesAndSessions()
	}

	// Graceful shutdown of local server
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := srv.Stop(ctx); err != nil {
		slog.Error("Error during shutdown", "error", err)
	}

	slog.Info("VM Agent stopped")
}

func countCompleted(steps []provision.Step) int {
	n := 0
	for _, s := range steps {
		if s.Status == "completed" {
			n++
		}
	}
	return n
}
