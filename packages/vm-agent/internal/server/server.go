// Package server provides the HTTP server for the VM Agent.
package server

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/container"
	"github.com/workspace/vm-agent/internal/idle"
	"github.com/workspace/vm-agent/internal/persistence"
	"github.com/workspace/vm-agent/internal/pty"
)

//go:embed static/*
var staticFiles embed.FS

// Server is the HTTP server for the VM Agent.
type Server struct {
	config          *config.Config
	httpServer      *http.Server
	jwtValidator    *auth.JWTValidator
	sessionManager  *auth.SessionManager
	ptyManager      *pty.Manager
	idleDetector    *idle.Detector
	workspaceMu     sync.RWMutex
	workspaces      map[string]*WorkspaceRuntime
	eventMu         sync.RWMutex
	nodeEvents      []EventRecord
	workspaceEvents map[string][]EventRecord
	agentSessions   *agentsessions.Manager
	acpConfig       acp.GatewayConfig
	acpMu           sync.Mutex
	acpGateway      *acp.Gateway
	acpGateways     map[string]*acp.Gateway
	store           *persistence.Store
}

type WorkspaceRuntime struct {
	ID                  string
	Repository          string
	Branch              string
	Status              string
	CreatedAt           time.Time
	UpdatedAt           time.Time
	WorkspaceDir        string
	ContainerLabelValue string
	ContainerWorkDir    string
	CallbackToken       string
	PTY                 *pty.Manager
}

type EventRecord struct {
	ID          string                 `json:"id"`
	NodeID      string                 `json:"nodeId,omitempty"`
	WorkspaceID string                 `json:"workspaceId,omitempty"`
	Level       string                 `json:"level"`
	Type        string                 `json:"type"`
	Message     string                 `json:"message"`
	Detail      map[string]interface{} `json:"detail,omitempty"`
	CreatedAt   string                 `json:"createdAt"`
}

func defaultWorkspaceScope(workspaceID, nodeID string) string {
	if workspaceID != "" {
		return workspaceID
	}
	return nodeID
}

// New creates a new server instance.
func New(cfg *config.Config) (*Server, error) {
	// Create JWT validator with configurable issuer and audience
	jwtValidator, err := auth.NewJWTValidator(cfg.JWKSEndpoint, cfg.NodeID, cfg.JWTIssuer, cfg.JWTAudience)
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
	idleDetector := idle.NewDetectorWithConfig(idle.DetectorConfig{
		Timeout:           cfg.IdleTimeout,
		HeartbeatInterval: cfg.HeartbeatInterval,
		IdleCheckInterval: cfg.IdleCheckInterval,
		ControlPlaneURL:   cfg.ControlPlaneURL,
		WorkspaceID:       cfg.WorkspaceID,
		CallbackToken:     cfg.CallbackToken,
	})

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
		ContainerResolver: containerResolver,
		ContainerUser:     containerUser,
		GracePeriod:       cfg.PTYOrphanGracePeriod,
		BufferSize:        cfg.PTYOutputBufferSize,
	})

	// Build ACP gateway configuration
	acpGatewayConfig := acp.GatewayConfig{
		InitTimeoutMs:      cfg.ACPInitTimeoutMs,
		MaxRestartAttempts: cfg.ACPMaxRestartAttempts,
		ControlPlaneURL:    cfg.ControlPlaneURL,
		WorkspaceID:        defaultWorkspaceScope(cfg.WorkspaceID, cfg.NodeID),
		CallbackToken:      cfg.CallbackToken,
		ContainerResolver:  containerResolver,
		ContainerUser:      containerUser,
		ContainerWorkDir:   containerWorkDir,
		OnActivity:         idleDetector.RecordActivity,
	}

	// Open persistence store for cross-device session state.
	// Ensure the parent directory exists.
	if err := os.MkdirAll(filepath.Dir(cfg.PersistenceDBPath), 0o755); err != nil {
		return nil, fmt.Errorf("create persistence directory: %w", err)
	}
	store, err := persistence.Open(cfg.PersistenceDBPath)
	if err != nil {
		return nil, fmt.Errorf("open persistence store: %w", err)
	}

	s := &Server{
		config:          cfg,
		jwtValidator:    jwtValidator,
		sessionManager:  sessionManager,
		ptyManager:      ptyManager,
		idleDetector:    idleDetector,
		workspaces:      make(map[string]*WorkspaceRuntime),
		nodeEvents:      make([]EventRecord, 0, 512),
		workspaceEvents: make(map[string][]EventRecord),
		agentSessions:   agentsessions.NewManager(),
		acpConfig:       acpGatewayConfig,
		acpGateways:     make(map[string]*acp.Gateway),
		store:           store,
	}

	if cfg.WorkspaceID != "" {
		s.workspaces[cfg.WorkspaceID] = &WorkspaceRuntime{
			ID:                  cfg.WorkspaceID,
			Repository:          strings.TrimSpace(cfg.Repository),
			Branch:              strings.TrimSpace(cfg.Branch),
			Status:              "running",
			CreatedAt:           time.Now().UTC(),
			UpdatedAt:           time.Now().UTC(),
			WorkspaceDir:        strings.TrimSpace(cfg.WorkspaceDir),
			ContainerLabelValue: strings.TrimSpace(cfg.ContainerLabelValue),
			ContainerWorkDir:    strings.TrimSpace(cfg.ContainerWorkDir),
			CallbackToken:       strings.TrimSpace(cfg.CallbackToken),
			PTY:                 ptyManager,
		}
	}

	// Setup routes
	mux := http.NewServeMux()
	s.setupRoutes(mux)

	// Create HTTP server with configurable timeouts.
	// WriteTimeout is intentionally set to 0 because WebSocket connections
	// are long-lived. Go's http.Server.WriteTimeout sets a deadline on the
	// underlying net.Conn BEFORE the handler runs, which kills hijacked
	// WebSocket connections after the timeout period.
	s.httpServer = &http.Server{
		Addr:        fmt.Sprintf("%s:%d", cfg.Host, cfg.Port),
		Handler:     corsMiddleware(mux, cfg.AllowedOrigins),
		ReadTimeout: cfg.HTTPReadTimeout,
		IdleTimeout: cfg.HTTPIdleTimeout,
	}

	return s, nil
}

// SetBootLog wires a boot-log reporter into the ACP gateway config so that
// agent errors (crashes, stderr) are reported to the control plane.
func (s *Server) SetBootLog(reporter acp.BootLogReporter) {
	s.acpConfig.BootLog = reporter
}

// Start starts the HTTP server.
func (s *Server) Start() error {
	// Start idle detector
	go s.idleDetector.Start()
	s.startNodeHealthReporter()

	log.Printf("Starting VM Agent on %s", s.httpServer.Addr)
	return s.httpServer.ListenAndServe()
}

// GetIdleShutdownChannel returns the channel that's closed when idle shutdown is requested.
func (s *Server) GetIdleShutdownChannel() <-chan struct{} {
	return s.idleDetector.ShutdownChannel()
}

// StopAllWorkspacesAndSessions transitions all local workloads to stopped state.
// This is invoked during node shutdown to ensure no child workloads are left active.
func (s *Server) StopAllWorkspacesAndSessions() {
	s.workspaceMu.Lock()
	workspaceIDs := make([]string, 0, len(s.workspaces))
	for id, runtime := range s.workspaces {
		runtime.PTY.CloseAllSessions()
		runtime.Status = "stopped"
		runtime.UpdatedAt = nowUTC()
		workspaceIDs = append(workspaceIDs, id)
	}
	s.workspaceMu.Unlock()

	for _, workspaceID := range workspaceIDs {
		if s.agentSessions != nil {
			sessions := s.agentSessions.List(workspaceID)
			for _, session := range sessions {
				_, _ = s.agentSessions.Stop(workspaceID, session.ID)
				s.closeAgentGateway(workspaceID, session.ID)
			}
		}

		s.closeAgentGatewaysForWorkspace(workspaceID)
		s.appendNodeEvent(workspaceID, "info", "workspace.stopped", "Workspace stopped due to node shutdown", map[string]interface{}{
			"reason": "node_shutdown",
		})
	}
}

// Stop gracefully stops the server.
func (s *Server) Stop(ctx context.Context) error {
	// Stop idle detector
	s.idleDetector.Stop()

	// Close JWT validator
	s.jwtValidator.Close()

	s.acpMu.Lock()
	for key, gateway := range s.acpGateways {
		if gateway != nil {
			gateway.Close()
		}
		delete(s.acpGateways, key)
	}
	if s.acpGateway != nil {
		s.acpGateway.Close()
		s.acpGateway = nil
	}
	s.acpMu.Unlock()

	// Close all workspace PTY sessions.
	s.workspaceMu.Lock()
	for _, runtime := range s.workspaces {
		runtime.PTY.CloseAllSessions()
	}
	s.workspaceMu.Unlock()

	// Close persistence store
	if s.store != nil {
		if err := s.store.Close(); err != nil {
			log.Printf("Warning: failed to close persistence store: %v", err)
		}
	}

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

	// Node/workspace management routes (control-plane authenticated).
	mux.HandleFunc("GET /workspaces", s.handleListWorkspaces)
	mux.HandleFunc("POST /workspaces", s.handleCreateWorkspace)
	mux.HandleFunc("GET /workspaces/{workspaceId}/events", s.handleListWorkspaceEvents)
	mux.HandleFunc("POST /workspaces/{workspaceId}/stop", s.handleStopWorkspace)
	mux.HandleFunc("POST /workspaces/{workspaceId}/restart", s.handleRestartWorkspace)
	mux.HandleFunc("DELETE /workspaces/{workspaceId}", s.handleDeleteWorkspace)
	mux.HandleFunc("GET /workspaces/{workspaceId}/agent-sessions", s.handleListAgentSessions)
	mux.HandleFunc("POST /workspaces/{workspaceId}/agent-sessions", s.handleCreateAgentSession)
	mux.HandleFunc("POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/stop", s.handleStopAgentSession)
	mux.HandleFunc("GET /workspaces/{workspaceId}/tabs", s.handleListTabs)
	mux.HandleFunc("GET /events", s.handleListNodeEvents)
	mux.HandleFunc("GET /workspaces/{workspaceId}/ports/{port}", s.handleWorkspacePortProxy)

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
