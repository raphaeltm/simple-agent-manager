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

	bootstrapCtx, bootstrapCancel := context.WithTimeout(context.Background(), cfg.BootstrapTimeout)
	defer bootstrapCancel()

	if err := bootstrap.Run(bootstrapCtx, cfg, reporter); err != nil {
		log.Fatalf("Bootstrap failed: %v", err)
	}

	log.Printf("Configuration loaded: node=%s, port=%d", cfg.NodeID, cfg.Port)

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
