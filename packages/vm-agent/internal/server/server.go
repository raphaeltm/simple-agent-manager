// Package server provides the HTTP server for the VM Agent.
package server

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"log/slog"
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
	"github.com/workspace/vm-agent/internal/errorreport"
	"github.com/workspace/vm-agent/internal/logreader"
	"github.com/workspace/vm-agent/internal/messagereport"
	"github.com/workspace/vm-agent/internal/persistence"
	"github.com/workspace/vm-agent/internal/pty"
	"github.com/workspace/vm-agent/internal/sysinfo"
)

//go:embed static/*
var staticFiles embed.FS

// Server is the HTTP server for the VM Agent.
type Server struct {
	config              *config.Config
	httpServer          *http.Server
	jwtValidator        *auth.JWTValidator
	sessionManager      *auth.SessionManager
	ptyManager          *pty.Manager
	sysInfoCollector    *sysinfo.Collector
	workspaceMu         sync.RWMutex
	workspaces          map[string]*WorkspaceRuntime
	eventMu             sync.RWMutex
	nodeEvents          []EventRecord
	workspaceEvents     map[string][]EventRecord
	agentSessions       *agentsessions.Manager
	acpConfig           acp.GatewayConfig
	sessionHostMu       sync.Mutex
	sessionHosts        map[string]*acp.SessionHost
	store               *persistence.Store
	errorReporter       *errorreport.Reporter
	messageReporter     *messagereport.Reporter
	worktreeCacheMu     sync.RWMutex
	worktreeCache       map[string]cachedWorktreeList
	logReader           *logreader.Reader
	bootLogBroadcasters *BootLogBroadcasterManager
	bootstrapComplete   bool
	done                chan struct{}
}

type cachedWorktreeList struct {
	worktrees []WorktreeInfo
	expiresAt time.Time
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
	ContainerUser       string
	CallbackToken       string
	GitUserName         string
	GitUserEmail        string
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
		slog.Info("Container mode enabled", "user", containerUser, "workDir", containerWorkDir)
	} else {
		slog.Info("Container mode disabled: PTY sessions will run on host")
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

	// Create error reporter for sending VM agent errors to CF observability.
	errorReporter := errorreport.New(cfg.ControlPlaneURL, cfg.NodeID, cfg.CallbackToken, errorreport.Config{
		FlushInterval: cfg.ErrorReportFlushInterval,
		MaxBatchSize:  cfg.ErrorReportMaxBatchSize,
		MaxQueueSize:  cfg.ErrorReportMaxQueueSize,
		HTTPTimeout:   cfg.ErrorReportHTTPTimeout,
	})

	// Build ACP gateway configuration
	acpGatewayConfig := acp.GatewayConfig{
		InitTimeoutMs:           cfg.ACPInitTimeoutMs,
		MaxRestartAttempts:      cfg.ACPMaxRestartAttempts,
		ControlPlaneURL:         cfg.ControlPlaneURL,
		WorkspaceID:             defaultWorkspaceScope(cfg.WorkspaceID, cfg.NodeID),
		CallbackToken:           cfg.CallbackToken,
		ContainerResolver:       containerResolver,
		ContainerUser:           containerUser,
		ContainerWorkDir:        containerWorkDir,
		GitTokenFetcher:         nil, // set below after server construction
		FileExecTimeout:         cfg.GitExecTimeout,
		FileMaxSize:             cfg.GitFileMaxSize,
		ErrorReporter:           errorReporter,
		PingInterval:            cfg.ACPPingInterval,
		PongTimeout:             cfg.ACPPongTimeout,
		PromptTimeout:           cfg.ACPPromptTimeout,
		PromptCancelGracePeriod: cfg.ACPPromptCancelGrace,
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

	// Create message reporter for chat message persistence (project-linked workspaces only).
	// Opens a separate SQLite connection to the same DB file used by the persistence store.
	// Returns nil if ProjectID or ChatSessionID is empty (intentional no-op).
	msgReporterCfg := messagereport.LoadConfigFromEnv()
	msgReporterCfg.ProjectID = cfg.ProjectID
	msgReporterCfg.SessionID = cfg.ChatSessionID
	msgReporterCfg.WorkspaceID = defaultWorkspaceScope(cfg.WorkspaceID, cfg.NodeID)
	msgReporterCfg.Endpoint = cfg.ControlPlaneURL

	var msgReporter *messagereport.Reporter
	if cfg.ProjectID != "" && cfg.ChatSessionID != "" {
		msgDB, dbErr := openSQLiteDB(cfg.PersistenceDBPath)
		if dbErr != nil {
			slog.Warn("Failed to open message reporter DB; chat persistence disabled", "error", dbErr)
		} else {
			r, rErr := messagereport.New(msgDB, msgReporterCfg)
			if rErr != nil {
				slog.Warn("Failed to create message reporter; chat persistence disabled", "error", rErr)
				msgDB.Close()
			} else {
				msgReporter = r
				slog.Info("Message reporter enabled", "projectId", cfg.ProjectID, "sessionId", cfg.ChatSessionID)
			}
		}
	}

	// Set message reporter on ACP gateway config so all SessionHosts inherit it.
	// Wrap in an adapter since the acp package uses MessageReportEntry (to avoid
	// circular imports) while messagereport uses its own Message type.
	if msgReporter != nil {
		acpGatewayConfig.MessageReporter = &messageReporterAdapter{r: msgReporter}
	}

	// Create system info collector for metrics and version reporting.
	sysInfoCollector := sysinfo.NewCollector(sysinfo.CollectorConfig{
		DockerTimeout:  cfg.SysInfoDockerTimeout,
		VersionTimeout: cfg.SysInfoVersionTimeout,
		CacheTTL:       cfg.SysInfoCacheTTL,
	})

	s := &Server{
		config:             cfg,
		jwtValidator:       jwtValidator,
		sessionManager:     sessionManager,
		ptyManager:         ptyManager,
		sysInfoCollector:   sysInfoCollector,
		workspaces:         make(map[string]*WorkspaceRuntime),
		nodeEvents:         make([]EventRecord, 0, 512),
		workspaceEvents:    make(map[string][]EventRecord),
		agentSessions:      agentsessions.NewManager(),
		acpConfig:          acpGatewayConfig,
		sessionHosts:       make(map[string]*acp.SessionHost),
		store:              store,
		errorReporter:      errorReporter,
		messageReporter:    msgReporter,
		worktreeCache:      make(map[string]cachedWorktreeList),
		logReader:           logreader.NewReaderWithTimeout(cfg.LogReaderTimeout),
		bootLogBroadcasters: NewBootLogBroadcasterManager(),
		done:                make(chan struct{}),
	}

	// Wire the git token fetcher now that the server exists.
	s.acpConfig.GitTokenFetcher = s.fetchGitToken

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
			ContainerUser:       strings.TrimSpace(cfg.ContainerUser),
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

// GetBootLogBroadcaster returns the broadcaster for a specific workspace.
// For the boot-time bootstrap path, use the server's configured WorkspaceID.
// Wire this into the bootlog.Reporter via SetBroadcaster() to enable real-time
// log delivery during bootstrap/provisioning.
func (s *Server) GetBootLogBroadcaster() *BootLogBroadcaster {
	if s.config.WorkspaceID == "" || s.bootLogBroadcasters == nil {
		return nil
	}
	return s.bootLogBroadcasters.GetOrCreate(s.config.WorkspaceID)
}

// GetBootLogBroadcasterForWorkspace returns the broadcaster for a specific workspace ID.
// Used by on-demand workspace provisioning to get a workspace-specific broadcaster.
func (s *Server) GetBootLogBroadcasterForWorkspace(workspaceID string) *BootLogBroadcaster {
	if workspaceID == "" || s.bootLogBroadcasters == nil {
		return nil
	}
	return s.bootLogBroadcasters.GetOrCreate(workspaceID)
}

// UpdateAfterBootstrap propagates the callback token (obtained during bootstrap)
// to subsystems that were created before the token was available, and signals
// that bootstrap is complete.
func (s *Server) UpdateAfterBootstrap(cfg *config.Config) {
	// Propagate callback token to error reporter.
	s.errorReporter.SetToken(cfg.CallbackToken)

	// Propagate callback token to message reporter (nil-safe).
	if s.messageReporter != nil {
		s.messageReporter.SetToken(cfg.CallbackToken)
	}

	// Update ACP gateway config with the callback token.
	s.acpConfig.CallbackToken = cfg.CallbackToken

	// Update workspace runtime with the callback token.
	s.workspaceMu.Lock()
	if ws, ok := s.workspaces[cfg.WorkspaceID]; ok {
		ws.CallbackToken = cfg.CallbackToken
	}
	s.workspaceMu.Unlock()

	s.bootstrapComplete = true

	// Notify WebSocket clients that bootstrap is complete.
	if s.config.WorkspaceID != "" {
		if broadcaster := s.bootLogBroadcasters.Get(s.config.WorkspaceID); broadcaster != nil {
			broadcaster.MarkComplete()
		}
	}
}

// Start starts the HTTP server.
func (s *Server) Start() error {
	s.startNodeHealthReporter()

	// Start error reporter background flush
	s.errorReporter.Start()

	slog.Info("Starting VM Agent", "addr", s.httpServer.Addr)
	return s.httpServer.ListenAndServe()
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
				s.stopSessionHost(workspaceID, session.ID)
			}
		}

		s.stopSessionHostsForWorkspace(workspaceID)
		s.appendNodeEvent(workspaceID, "info", "workspace.stopped", "Workspace stopped due to node shutdown", map[string]interface{}{
			"reason": "node_shutdown",
		})
	}
}

// Stop gracefully stops the server.
func (s *Server) Stop(ctx context.Context) error {
	// Signal background goroutines to stop.
	close(s.done)

	// Close JWT validator
	s.jwtValidator.Close()

	s.sessionHostMu.Lock()
	for key, host := range s.sessionHosts {
		if host != nil {
			host.Stop()
		}
		delete(s.sessionHosts, key)
	}
	s.sessionHostMu.Unlock()

	// Close all workspace PTY sessions.
	s.workspaceMu.Lock()
	for _, runtime := range s.workspaces {
		runtime.PTY.CloseAllSessions()
	}
	s.workspaceMu.Unlock()

	// Flush and stop error reporter
	s.errorReporter.Shutdown()

	// Flush and stop message reporter (nil-safe)
	if s.messageReporter != nil {
		s.messageReporter.Shutdown()
	}

	// Close persistence store
	if s.store != nil {
		if err := s.store.Close(); err != nil {
			slog.Warn("Failed to close persistence store", "error", err)
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
	mux.HandleFunc("POST /workspaces/{workspaceId}/rebuild", s.handleRebuildWorkspace)
	mux.HandleFunc("DELETE /workspaces/{workspaceId}", s.handleDeleteWorkspace)
	mux.HandleFunc("GET /workspaces/{workspaceId}/agent-sessions", s.handleListAgentSessions)
	mux.HandleFunc("POST /workspaces/{workspaceId}/agent-sessions", s.handleCreateAgentSession)
	mux.HandleFunc("POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/stop", s.handleStopAgentSession)
	mux.HandleFunc("POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/suspend", s.handleSuspendAgentSession)
	mux.HandleFunc("POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/resume", s.handleResumeAgentSession)
	mux.HandleFunc("GET /workspaces/{workspaceId}/tabs", s.handleListTabs)

	// Git integration (browser-authenticated via workspace session/token)
	mux.HandleFunc("GET /workspaces/{workspaceId}/git/status", s.handleGitStatus)
	mux.HandleFunc("GET /workspaces/{workspaceId}/git/diff", s.handleGitDiff)
	mux.HandleFunc("GET /workspaces/{workspaceId}/git/file", s.handleGitFile)

	// File browser (browser-authenticated via workspace session/token)
	mux.HandleFunc("GET /workspaces/{workspaceId}/files/list", s.handleFileList)
	mux.HandleFunc("GET /workspaces/{workspaceId}/files/find", s.handleFileFind)
	mux.HandleFunc("GET /workspaces/{workspaceId}/worktrees", s.handleListWorktrees)
	mux.HandleFunc("POST /workspaces/{workspaceId}/worktrees", s.handleCreateWorktree)
	mux.HandleFunc("DELETE /workspaces/{workspaceId}/worktrees", s.handleRemoveWorktree)

	mux.HandleFunc("GET /events", s.handleListNodeEvents)
	mux.HandleFunc("GET /system-info", s.handleSystemInfo)
	mux.HandleFunc("GET /logs", s.handleLogs)
	mux.HandleFunc("GET /logs/stream", s.handleLogStream)
	mux.HandleFunc("GET /workspaces/{workspaceId}/ports/{port}", s.handleWorkspacePortProxy)

	// Boot log WebSocket (available during bootstrap for real-time streaming)
	mux.HandleFunc("GET /boot-log/ws", s.handleBootLogWS)

	// ACP Agent WebSocket
	mux.HandleFunc("GET /agent/ws", s.handleAgentWS)
	mux.HandleFunc("GET /git-credential", s.handleGitCredential)

	// Static files (embedded UI)
	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		slog.Warn("Could not load embedded static files", "error", err)
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
			// Support wildcard subdomain patterns like "https://*.example.com"
			if strings.Contains(o, "*.") {
				// Split pattern into scheme + wildcard domain
				// e.g. "https://*.example.com" → prefix="https://", suffix=".example.com"
				wildcardIdx := strings.Index(o, "*.")
				prefix := o[:wildcardIdx]
				suffix := o[wildcardIdx+1:] // includes the dot
				if strings.HasPrefix(origin, prefix) && strings.HasSuffix(origin, suffix) {
					allowed = true
					break
				}
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

// messageReporterAdapter bridges acp.MessageReporter (which uses
// acp.MessageReportEntry) to messagereport.Reporter (which uses
// messagereport.Message). This adapter exists to avoid circular imports
// between the acp and messagereport packages.
type messageReporterAdapter struct {
	r *messagereport.Reporter
}

func (a *messageReporterAdapter) Enqueue(entry acp.MessageReportEntry) error {
	return a.r.Enqueue(messagereport.Message{
		MessageID:    entry.MessageID,
		SessionID:    entry.SessionID,
		Role:         entry.Role,
		Content:      entry.Content,
		ToolMetadata: entry.ToolMetadata,
		Timestamp:    entry.Timestamp,
	})
}

// openSQLiteDB opens a SQLite database connection with WAL mode and
// appropriate tuning for concurrent access. Used by subsystems that
// need an independent connection to the shared persistence file.
func openSQLiteDB(dbPath string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?cache=shared&mode=rwc&_journal_mode=WAL", dbPath))
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		db.Close()
		return nil, fmt.Errorf("set WAL mode: %w", err)
	}
	if _, err := db.Exec("PRAGMA busy_timeout=5000"); err != nil {
		db.Close()
		return nil, fmt.Errorf("set busy timeout: %w", err)
	}
	return db, nil
}
