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
	"github.com/workspace/vm-agent/internal/idle"
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

	reporter := bootlog.New(cfg.ControlPlaneURL, cfg.WorkspaceID)

	bootstrapCtx, bootstrapCancel := context.WithTimeout(context.Background(), cfg.BootstrapTimeout)
	defer bootstrapCancel()

	if err := bootstrap.Run(bootstrapCtx, cfg, reporter); err != nil {
		log.Fatalf("Bootstrap failed: %v", err)
	}

	log.Printf("Configuration loaded: workspace=%s, port=%d", cfg.WorkspaceID, cfg.Port)

	// Create server
	srv, err := server.New(cfg)
	if err != nil {
		log.Fatalf("Failed to create server: %v", err)
	}

	// Wire boot-log reporter into ACP gateway for agent error reporting
	srv.SetBootLog(reporter)

	// Handle shutdown signals
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	// Start server in goroutine
	errCh := make(chan error, 1)
	go func() {
		if err := srv.Start(); err != nil {
			errCh <- err
		}
	}()

	// Wait for shutdown signal, idle timeout, or error
	var idleShutdown bool
	select {
	case err := <-errCh:
		log.Fatalf("Server error: %v", err)
	case sig := <-sigCh:
		log.Printf("Received signal %v, shutting down...", sig)
	case <-srv.GetIdleShutdownChannel():
		log.Println("Idle timeout reached, requesting VM deletion...")
		idleShutdown = true
	}

	// If this was an idle shutdown, request deletion from control plane BEFORE
	// stopping the local server. The HTTP call needs networking to be functional,
	// and srv.Stop() may close connections or time out.
	if idleShutdown && cfg.ControlPlaneURL != "" && cfg.WorkspaceID != "" && cfg.CallbackToken != "" {
		log.Println("Requesting VM deletion from control plane due to idle timeout...")
		if err := idle.RequestShutdown(idle.ShutdownConfig{
			ControlPlaneURL: cfg.ControlPlaneURL,
			WorkspaceID:     cfg.WorkspaceID,
			CallbackToken:   cfg.CallbackToken,
		}); err != nil {
			log.Printf("WARNING: Failed to request shutdown: %v (control plane heartbeat fallback will clean up)", err)
		}
	}

	// Graceful shutdown of local server
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := srv.Stop(ctx); err != nil {
		log.Printf("Error during shutdown: %v", err)
	}

	if idleShutdown {
		// Block forever after requesting shutdown. If we exit, systemd's
		// Restart=always will restart the agent, which calls /ready and
		// resets lastActivityAt — creating an infinite shutdown loop.
		// The VM will be deleted by the control plane.
		log.Println("Shutdown requested — blocking until VM is deleted")
		select {}
	}

	log.Println("VM Agent stopped")
}
