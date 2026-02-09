// VM Agent - Terminal server for Simple Agent Manager
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

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

	// Graceful shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := srv.Stop(ctx); err != nil {
		log.Printf("Error during shutdown: %v", err)
	}

	// If this was an idle shutdown, request deletion from control plane
	// This ensures proper cleanup of Hetzner resources and DNS records
	if idleShutdown && cfg.ControlPlaneURL != "" && cfg.WorkspaceID != "" && cfg.CallbackToken != "" {
		// Mask the systemd service to prevent ALL restarts (including Restart=always).
		// "systemctl disable" only prevents boot-time auto-start but does NOT
		// prevent runtime restarts from Restart=always. "systemctl mask" creates
		// a symlink to /dev/null that blocks the service from starting by any
		// mechanism. Unlike "disable --now", mask does not send SIGTERM to the
		// running process, so we can finish our cleanup below.
		if out, err := exec.Command("systemctl", "mask", "vm-agent").CombinedOutput(); err != nil {
			log.Printf("Warning: failed to mask vm-agent service: %v: %s", err, string(out))
		} else {
			log.Println("Masked vm-agent systemd service to prevent restart after idle shutdown")
		}

		log.Println("Requesting VM deletion from control plane due to idle timeout...")

		payload := map[string]interface{}{
			"reason": "idle_timeout",
		}

		jsonData, err := json.Marshal(payload)
		if err != nil {
			log.Printf("Failed to marshal shutdown request: %v", err)
		} else {
			url := cfg.ControlPlaneURL + "/api/workspaces/" + cfg.WorkspaceID + "/request-shutdown"
			req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
			if err != nil {
				log.Printf("Failed to create shutdown request: %v", err)
			} else {
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Authorization", "Bearer "+cfg.CallbackToken)

				client := &http.Client{Timeout: 10 * time.Second}
				resp, err := client.Do(req)
				if err != nil {
					log.Printf("Failed to send shutdown request: %v", err)
				} else {
					defer resp.Body.Close()
					if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusAccepted {
						log.Println("Successfully requested VM deletion from control plane")
					} else {
						log.Printf("Shutdown request returned status %d", resp.StatusCode)
					}
				}
			}
		}

		// Give the control plane time to process the deletion request
		// This helps ensure logs are captured before the VM is deleted
		time.Sleep(5 * time.Second)
	}

	log.Println("VM Agent stopped")
}
