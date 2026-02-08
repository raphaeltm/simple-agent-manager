// Package server provides the HTTP server for the VM Agent.
package server

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"sync"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/container"
	"github.com/workspace/vm-agent/internal/idle"
	"github.com/workspace/vm-agent/internal/pty"
)

//go:embed static/*
var staticFiles embed.FS

// Server is the HTTP server for the VM Agent.
type Server struct {
	config         *config.Config
	httpServer     *http.Server
	jwtValidator   *auth.JWTValidator
	sessionManager *auth.SessionManager
	ptyManager     *pty.Manager
	idleDetector   *idle.Detector
	acpConfig      acp.GatewayConfig
	acpMu          sync.Mutex
	acpActive      bool
}

// New creates a new server instance.
func New(cfg *config.Config) (*Server, error) {
	// Create JWT validator with configurable issuer and audience
	jwtValidator, err := auth.NewJWTValidator(cfg.JWKSEndpoint, cfg.WorkspaceID, cfg.JWTIssuer, cfg.JWTAudience)
	if err != nil {
		return nil, fmt.Errorf("failed to create JWT validator: %w", err)
	}

	// Create session manager with full configuration
	sessionManager := auth.NewSessionManagerWithConfig(auth.SessionManagerConfig{
		CookieName:      cfg.CookieName,
		Secure:          cfg.CookieSecure,
		TTL:             cfg.SessionTTL,
		CleanupInterval: cfg.SessionCleanupInterval,
		MaxSessions:     cfg.SessionMaxCount,
	})

	// Create idle detector
	idleDetector := idle.NewDetector(cfg.IdleTimeout, cfg.HeartbeatInterval, cfg.ControlPlaneURL, cfg.WorkspaceID, cfg.CallbackToken)

	// Setup container discovery for devcontainer exec
	var containerResolver pty.ContainerResolver
	containerWorkDir := "/workspace" // host fallback
	containerUser := ""

	if cfg.ContainerMode {
		discovery := container.NewDiscovery(container.Config{
			LabelKey:   cfg.ContainerLabelKey,
			LabelValue: cfg.ContainerLabelValue,
			CacheTTL:   cfg.ContainerCacheTTL,
		})
		containerResolver = discovery.GetContainerID
		containerWorkDir = cfg.ContainerWorkDir
		containerUser = cfg.ContainerUser
		log.Printf("Container mode enabled: user=%s, workDir=%s", containerUser, containerWorkDir)
	} else {
		log.Printf("Container mode disabled: PTY sessions will run on host")
	}

	// Create PTY manager
	ptyManager := pty.NewManager(pty.ManagerConfig{
		DefaultShell:      cfg.DefaultShell,
		DefaultRows:       cfg.DefaultRows,
		DefaultCols:       cfg.DefaultCols,
		WorkDir:           containerWorkDir,
		OnActivity:        idleDetector.RecordActivity,
		ContainerResolver: containerResolver,
		ContainerUser:     containerUser,
	})

	// Build ACP gateway configuration
	acpGatewayConfig := acp.GatewayConfig{
		InitTimeoutMs:      cfg.ACPInitTimeoutMs,
		MaxRestartAttempts: cfg.ACPMaxRestartAttempts,
		ControlPlaneURL:    cfg.ControlPlaneURL,
		WorkspaceID:        cfg.WorkspaceID,
		CallbackToken:      cfg.CallbackToken,
		ContainerResolver:  containerResolver,
		ContainerUser:      containerUser,
		ContainerWorkDir:   containerWorkDir,
		OnActivity:         idleDetector.RecordActivity,
	}

	s := &Server{
		config:         cfg,
		jwtValidator:   jwtValidator,
		sessionManager: sessionManager,
		ptyManager:     ptyManager,
		idleDetector:   idleDetector,
		acpConfig:      acpGatewayConfig,
	}

	// Setup routes
	mux := http.NewServeMux()
	s.setupRoutes(mux)

	// Create HTTP server with configurable timeouts
	s.httpServer = &http.Server{
		Addr:         fmt.Sprintf("%s:%d", cfg.Host, cfg.Port),
		Handler:      corsMiddleware(mux, cfg.AllowedOrigins),
		ReadTimeout:  cfg.HTTPReadTimeout,
		WriteTimeout: cfg.HTTPWriteTimeout,
		IdleTimeout:  cfg.HTTPIdleTimeout,
	}

	return s, nil
}

// Start starts the HTTP server.
func (s *Server) Start() error {
	// Start idle detector
	go s.idleDetector.Start()

	log.Printf("Starting VM Agent on %s", s.httpServer.Addr)
	return s.httpServer.ListenAndServe()
}

// Stop gracefully stops the server.
func (s *Server) Stop(ctx context.Context) error {
	// Stop idle detector
	s.idleDetector.Stop()

	// Close JWT validator
	s.jwtValidator.Close()

	// Close all PTY sessions
	s.ptyManager.CloseAllSessions()

	// Shutdown HTTP server
	return s.httpServer.Shutdown(ctx)
}

// setupRoutes configures the HTTP routes.
func (s *Server) setupRoutes(mux *http.ServeMux) {
	// Health check
	mux.HandleFunc("GET /health", s.handleHealth)

	// Authentication
	mux.HandleFunc("POST /auth/token", s.handleTokenAuth)
	mux.HandleFunc("GET /auth/session", s.handleSessionCheck)
	mux.HandleFunc("POST /auth/logout", s.handleLogout)

	// Terminal WebSocket (single-session and multi-session)
	mux.HandleFunc("GET /terminal/ws", s.handleTerminalWS)
	mux.HandleFunc("GET /terminal/ws/multi", s.handleMultiTerminalWS)
	mux.HandleFunc("POST /terminal/resize", s.handleTerminalResize)

	// ACP Agent WebSocket
	mux.HandleFunc("GET /agent/ws", s.handleAgentWS)
	mux.HandleFunc("GET /git-credential", s.handleGitCredential)

	// Static files (embedded UI)
	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		log.Printf("Warning: Could not load embedded static files: %v", err)
		// Fallback to serving from disk
		mux.Handle("/", http.FileServer(http.Dir("./ui/dist")))
	} else {
		mux.Handle("/", http.FileServer(http.FS(staticFS)))
	}
}

// corsMiddleware adds CORS headers to responses.
func corsMiddleware(next http.Handler, allowedOrigins []string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		allowed := false

		for _, o := range allowedOrigins {
			if o == "*" || o == origin {
				allowed = true
				break
			}
		}

		if allowed {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
		}

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}
