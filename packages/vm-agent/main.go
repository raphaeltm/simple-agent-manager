// VM Agent - Terminal server for Simple Agent Manager
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/server"
)

// requestShutdown calls the control plane's /request-shutdown endpoint with retries.
// Returns nil on success (2xx response), or the last error after all retries fail.
func requestShutdown(cfg *config.Config) error {
	const maxAttempts = 3
	const retryDelay = 5 * time.Second

	payload, err := json.Marshal(map[string]string{"reason": "idle_timeout"})
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	url := cfg.ControlPlaneURL + "/api/workspaces/" + cfg.WorkspaceID + "/request-shutdown"
	client := &http.Client{Timeout: 15 * time.Second}

	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if attempt > 1 {
			log.Printf("Retry %d/%d after %v...", attempt, maxAttempts, retryDelay)
			time.Sleep(retryDelay)
		}

		req, err := http.NewRequest("POST", url, bytes.NewBuffer(payload))
		if err != nil {
			lastErr = fmt.Errorf("create request: %w", err)
			log.Printf("Attempt %d: %v", attempt, lastErr)
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+cfg.CallbackToken)

		resp, err := client.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("send request: %w", err)
			log.Printf("Attempt %d: %v", attempt, lastErr)
			continue
		}

		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusAccepted {
			log.Printf("Successfully requested VM deletion (status %d, body: %s)", resp.StatusCode, string(body))
			return nil
		}

		lastErr = fmt.Errorf("status %d, body: %s", resp.StatusCode, string(body))
		log.Printf("Attempt %d: shutdown request failed: %v", attempt, lastErr)
	}

	return fmt.Errorf("all %d attempts failed, last error: %w", maxAttempts, lastErr)
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Println("Starting VM Agent...")

	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load configuration: %v", err)
	}

	bootstrapCtx, bootstrapCancel := context.WithTimeout(context.Background(), cfg.BootstrapMaxWait+30*time.Second)
	defer bootstrapCancel()

	if err := bootstrap.Run(bootstrapCtx, cfg); err != nil {
		log.Fatalf("Bootstrap failed: %v", err)
	}

	log.Printf("Configuration loaded: workspace=%s, port=%d", cfg.WorkspaceID, cfg.Port)

	// Create server
	srv, err := server.New(cfg)
	if err != nil {
		log.Fatalf("Failed to create server: %v", err)
	}

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
		if err := requestShutdown(cfg); err != nil {
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
