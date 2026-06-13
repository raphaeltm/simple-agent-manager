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
	"github.com/workspace/vm-agent/internal/deploy"
	"github.com/workspace/vm-agent/internal/errorreport"
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

	slog.Info("Configuration loaded", "node", cfg.NodeID, "port", cfg.Port, "role", cfg.Role)

	// Branch on node role
	if cfg.IsDeploymentMode() {
		runDeploymentMode(cfg)
	} else {
		runWorkspaceMode(cfg)
	}
}

// runDeploymentMode starts the agent in deployment mode.
// It skips provision/bootstrap and runs the deploy reconcile loop instead.
func runDeploymentMode(cfg *config.Config) {
	slog.Info("Starting in deployment mode",
		"environmentId", cfg.EnvironmentID,
		"baseDir", cfg.DeployBaseDir)

	// EnsureRuntime runs BEFORE the HTTP server and heartbeat loop start, so the
	// only telemetry channel during host-dependency install is this reporter,
	// which POSTs to the control plane's node-error endpoint. Without it, an
	// install failure (or a crash loop on os.Exit) is completely invisible: no
	// heartbeat, no boot log, agent unreachable on its serving port. The reporter
	// is nil-safe and started here so progress and any terminal failure are
	// flushed to the control plane before this function can exit.
	bootReporter := errorreport.New(cfg.ControlPlaneURL, cfg.NodeID, cfg.CallbackToken, errorreport.Config{
		FlushInterval: cfg.ErrorReportFlushInterval,
		MaxBatchSize:  cfg.ErrorReportMaxBatchSize,
		MaxQueueSize:  cfg.ErrorReportMaxQueueSize,
		HTTPTimeout:   cfg.ErrorReportHTTPTimeout,
	})
	bootReporter.Start()
	bootReporter.ReportInfo("deploy: agent started in deployment mode; ensuring host runtime", "deploy.bootstrap", "", map[string]interface{}{
		"environmentId": cfg.EnvironmentID,
	})

	runtimeCtx, runtimeCancel := context.WithTimeout(context.Background(), 15*time.Minute)
	if err := deploy.EnsureRuntime(runtimeCtx, bootReporter); err != nil {
		runtimeCancel()
		// Report and flush synchronously before exiting so the failure is visible
		// in control-plane observability — systemd will restart us into a silent
		// crash loop otherwise.
		bootReporter.ReportError(err, "deploy.bootstrap", "", map[string]interface{}{"phase": "ensure_runtime"})
		bootReporter.Shutdown()
		slog.Error("Deployment runtime provisioning failed", "error", err)
		os.Exit(1)
	}
	runtimeCancel()

	// Host runtime is ready. Flush the bootstrap reporter's progress entries; the
	// server constructs and starts its own error reporter for steady-state use.
	bootReporter.ReportInfo("deploy: host runtime ready; starting agent server", "deploy.bootstrap", "", nil)
	bootReporter.Shutdown()

	// Create server with deployment-mode routes only
	srv, err := server.New(cfg)
	if err != nil {
		slog.Error("Failed to create server", "error", err)
		os.Exit(1)
	}

	// Initialize disk state
	disk, err := deploy.NewDiskState(cfg.DeployBaseDir)
	if err != nil {
		slog.Error("Failed to initialize deployment disk state", "error", err)
		os.Exit(1)
	}

	// Initialize signature verifier when a boot-time key is available.
	// If not, heartbeat can refresh the key before the first release is applied.
	var verifier *deploy.Verifier
	if cfg.DeploySigningPubKey != "" {
		verifier, err = deploy.NewVerifier(cfg.DeploySigningPubKey)
		if err != nil {
			slog.Error("Failed to initialize deploy signature verifier", "error", err)
			os.Exit(1)
		}
	} else {
		slog.Warn("deploy: DEPLOY_SIGNING_PUB_KEY is not set; waiting for heartbeat key refresh")
	}

	// Create deploy engine
	engine := deploy.NewEngine(disk, verifier, deploy.EngineConfig{
		EnvironmentID:   cfg.EnvironmentID,
		NodeID:          cfg.NodeID,
		ControlPlaneURL: cfg.ControlPlaneURL,
		CallbackToken:   cfg.CallbackToken,
		ComposeCmd:      cfg.DeployComposeCmd,
		HealthTimeout:   cfg.DeployHealthTimeout,
		ACMEEmail:       cfg.DeployACMEEmail,
		ACMECA:          cfg.DeployACMECA,
	})

	// Non-fatal startup preflight: log the availability of docker, compose, the
	// caddy binary, and a running caddy admin API so a failed first deploy can be
	// diagnosed from journalctl alone (the apply path's own failures are otherwise
	// only surfaced at apply time).
	preflightCtx, preflightCancel := context.WithTimeout(context.Background(), 30*time.Second)
	engine.LogPreflight(preflightCtx)
	preflightCancel()

	// Reconcile from disk state (idempotent, never recreates healthy containers)
	reconcileCtx, reconcileCancel := context.WithTimeout(context.Background(), 2*time.Minute)
	if err := engine.ReconcileOnStart(reconcileCtx); err != nil {
		slog.Error("Deploy reconcile on start failed", "error", err)
	}
	reconcileCancel()

	// Wire deploy engine into server for heartbeat reporting
	srv.SetDeployEngine(engine)

	// Handle shutdown signals
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	// Start HTTP server after the deployment engine is attached so the first
	// heartbeat can refresh signing keys and observe pending releases.
	errCh := make(chan error, 1)
	go func() {
		if err := srv.Start(); err != nil {
			errCh <- err
		}
	}()

	// Send node-ready callback
	srv.SendNodeReady()

	// Wait for shutdown signal or fatal server error.
	// The heartbeat loop (started by the server) checks for pendingReleaseSeq
	// and triggers FetchAndApply via the deploy engine.
	select {
	case err := <-errCh:
		slog.Error("Server error", "error", err)
		os.Exit(1)
	case sig := <-sigCh:
		slog.Info("Received signal, shutting down...", "signal", sig)
		// In deployment mode, we do NOT stop containers — they must survive agent restart.
		// Containers use restart: unless-stopped and are independent of agent lifecycle.
	}

	// Graceful shutdown of HTTP server only
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Stop(ctx); err != nil {
		slog.Error("Error during shutdown", "error", err)
	}
	slog.Info("VM Agent (deployment mode) stopped")
}

// runWorkspaceMode starts the agent in the traditional workspace mode.
func runWorkspaceMode(cfg *config.Config) {
	reporter := bootlog.New(cfg.ControlPlaneURL, cfg.NodeID)

	// Create server BEFORE bootstrap so /health and /boot-log/ws are available
	// while the workspace is still being provisioned.
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
	errCh := make(chan error, 1)
	go func() {
		if err := srv.Start(); err != nil {
			errCh <- err
		}
	}()

	// Run system provisioning (firewall, Node.js, devcontainer CLI, etc.)
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
	} else {
		slog.Info("System provisioning completed",
			"duration", provisionStatus.CompletedAt.Sub(provisionStatus.StartedAt).Round(time.Millisecond))
	}

	// Send node-ready callback AFTER provisioning.
	srv.SendNodeReady()

	// Run bootstrap (blocks until workspace is provisioned).
	bootstrapCtx, bootstrapCancel := context.WithTimeout(context.Background(), cfg.BootstrapTimeout)
	defer bootstrapCancel()

	if err := bootstrap.Run(bootstrapCtx, cfg, reporter); err != nil {
		slog.Error("Bootstrap failed", "error", err)
		os.Exit(1)
	}

	// Propagate callback token (obtained during bootstrap) to all subsystems
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
