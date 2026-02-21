// VM Agent - Terminal server for Simple Agent Manager
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/server"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Println("Starting VM Agent...")

	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load configuration: %v", err)
	}

	reporter := bootlog.New(cfg.ControlPlaneURL, cfg.NodeID)

	log.Printf("Configuration loaded: node=%s, port=%d", cfg.NodeID, cfg.Port)

	// Create server BEFORE bootstrap so that /health and /boot-log/ws are
	// available while the workspace is still being provisioned. The callback
	// token is empty at this point; UpdateAfterBootstrap() sets it later.
	srv, err := server.New(cfg)
	if err != nil {
		log.Fatalf("Failed to create server: %v", err)
	}

	// Wire boot-log reporter into ACP gateway for agent error reporting
	srv.SetBootLog(reporter)

	// Connect the boot-log broadcaster so the reporter pushes log entries to
	// connected WebSocket clients in real time (even before the callback token
	// is available for HTTP relay to the control plane).
	reporter.SetBroadcaster(srv.GetBootLogBroadcaster())

	// Handle shutdown signals
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	// Start server in goroutine — makes /health and /boot-log/ws available
	// immediately so the control plane can detect the agent and the UI can
	// connect for real-time boot log streaming.
	errCh := make(chan error, 1)
	go func() {
		if err := srv.Start(); err != nil {
			errCh <- err
		}
	}()

	// Run bootstrap (blocks until complete). During this time the HTTP server
	// is already listening, so boot log entries are broadcast to any connected
	// WebSocket clients and also relayed to the control plane KV once the
	// callback token is obtained.
	bootstrapCtx, bootstrapCancel := context.WithTimeout(context.Background(), cfg.BootstrapTimeout)
	defer bootstrapCancel()

	if err := bootstrap.Run(bootstrapCtx, cfg, reporter); err != nil {
		log.Fatalf("Bootstrap failed: %v", err)
	}

	// Propagate the callback token (now available) to components that need it
	// and start background services (idle detector, health reporter).
	srv.UpdateAfterBootstrap(cfg)

	// Wait for shutdown signal or fatal server error.
	select {
	case err := <-errCh:
		log.Fatalf("Server error: %v", err)
	case sig := <-sigCh:
		log.Printf("Received signal %v, shutting down...", sig)
		srv.StopAllWorkspacesAndSessions()
	}

	// Graceful shutdown of local server
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := srv.Stop(ctx); err != nil {
		log.Printf("Error during shutdown: %v", err)
	}

	log.Println("VM Agent stopped")
}
