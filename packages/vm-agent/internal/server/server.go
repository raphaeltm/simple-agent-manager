// Package server provides the HTTP server for the VM Agent.
package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/container"
	"github.com/workspace/vm-agent/internal/deploy"
	"github.com/workspace/vm-agent/internal/errorreport"
	"github.com/workspace/vm-agent/internal/eventstore"
	"github.com/workspace/vm-agent/internal/logreader"
	"github.com/workspace/vm-agent/internal/messagereport"
	"github.com/workspace/vm-agent/internal/persistence"
	"github.com/workspace/vm-agent/internal/ports"
	"github.com/workspace/vm-agent/internal/pty"
	"github.com/workspace/vm-agent/internal/publish"
	"github.com/workspace/vm-agent/internal/resourcemon"
	"github.com/workspace/vm-agent/internal/sysinfo"
)

// profileOverrides holds model/permissionMode/effort/opencode provider overrides from agent profiles.
// Passed from the control plane in the start-agent-session request.
type profileOverrides struct {
	Model            string
	PermissionMode   string
	Effort           string
	OpencodeProvider string
	OpencodeBaseURL  string
}

// taskCallbackContext binds a prompt-completion callback to the task/workspace
// that owns a specific agent session. It must be session-scoped: nodes can host
// multiple workspaces over their lifetime.
type taskCallbackContext struct {
	ProjectID   string
	TaskID      string
	WorkspaceID string
	TaskMode    string
}

const fatalErrorStopReason = "fatal_error"

var taskCallbackDiagnosticRedactionPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{16,}`),
	regexp.MustCompile(`(?i)((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,;]+)`),
	regexp.MustCompile(`\b(sk-[A-Za-z0-9_-]{12,})\b`),
	regexp.MustCompile(`\b(gh[pousr]_[A-Za-z0-9_]{12,})\b`),
	regexp.MustCompile(`\b(github_pat_[A-Za-z0-9_]{12,})\b`),
	regexp.MustCompile(`\b(sam_test_[A-Za-z0-9_-]{12,})\b`),
}

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
	readyRetryMu        sync.Mutex // guards retryPendingReadyCallbacks — only one run at a time
	eventMu             sync.RWMutex
	nodeEvents          []EventRecord
	workspaceEvents     map[string][]EventRecord
	eventStore          *eventstore.Store
	resourceMonitor     *resourcemon.Monitor
	agentSessions       *agentsessions.Manager
	acpConfig           acp.GatewayConfig
	sessionHostMu       sync.Mutex
	sessionHosts        map[string]*acp.SessionHost
	sessionMcpServers   map[string][]acp.McpServerEntry // hostKey → MCP servers for ACP injection
	sessionProfileOvr   map[string]profileOverrides     // hostKey → model/permissionMode/effort overrides from agent profiles
	sessionTaskCtx      map[string]taskCallbackContext  // hostKey → task callback ownership context
	store               *persistence.Store
	errorReporter       *errorreport.Reporter
	messageReportersMu  sync.RWMutex
	messageReporters    map[string]*messagereport.Reporter // keyed by workspaceID
	worktreeCacheMu     sync.RWMutex
	worktreeCache       map[string]cachedWorktreeList
	logReader           *logreader.Reader
	bootLogBroadcasters *BootLogBroadcasterManager
	containerDiscovery  *container.Discovery
	portScannerMu       sync.RWMutex
	portScanners        map[string]*ports.Scanner
	portDiscoveries     map[string]*container.Discovery // per-workspace container discovery
	bootstrapComplete   atomic.Bool
	callbackTokenMu     sync.RWMutex
	callbackToken       string
	httpClient          *http.Client // shared HTTP client with timeout for control-plane callbacks
	done                chan struct{}
	publishJobsMu       sync.Mutex
	publishJobs         map[string]publishJobState
	buildPublishRunner  func(context.Context, *preparedBuildPublish, publish.EventSink) (*publish.ReleaseResult, error)
	applyWatchdogMu     sync.Mutex
	applyWatchdogs      map[string]chan struct{}

	// Deployment mode — one Engine per placed deployment environment.
	deployMu       sync.Mutex
	deployEngines  map[string]*deploy.Engine
	deployRetiring map[string]bool
	deployVerifier *deploy.Verifier
}

type cachedWorktreeList struct {
	worktrees []WorktreeInfo
	expiresAt time.Time
}

func (s *Server) controlPlaneHTTPClient(timeout time.Duration) *http.Client {
	if timeout <= 0 && s.config != nil {
		timeout = s.config.HTTPCallbackTimeout
	}

	if s.httpClient != nil {
		if timeout <= 0 || s.httpClient.Timeout == timeout {
			return s.httpClient
		}
	}

	return config.NewControlPlaneClient(timeout)
}

type WorkspaceRuntime struct {
	ID                     string
	Repository             string
	Branch                 string
	RepoProvider           string
	CloneURL               string
	RepositoryHost         string
	RepositoryPath         string
	Status                 string
	CreatedAt              time.Time
	UpdatedAt              time.Time
	WorkspaceDir           string
	ContainerLabelValue    string
	ContainerWorkDir       string
	ContainerUser          string
	CallbackToken          string
	ProjectID              string
	GitUserName            string
	GitUserEmail           string
	GitHubID               string
	Lightweight            bool   // Skip devcontainer build, use fallback image for faster startup
	DevcontainerConfigName string // Named devcontainer config (subdirectory under .devcontainer/)
	DevcontainerCache      DevcontainerCacheCredentials
	ProvisioningActive     bool
	PTY                    *pty.Manager

	// ReadyCallbackPending is true when the workspace provisioned successfully but
	// the workspace-ready callback to the control plane failed (e.g., transient
	// network issue). The heartbeat loop retries the callback when connectivity
	// is restored.
	ReadyCallbackPending bool
	// ReadyCallbackStatus is the status to report when retrying the callback
	// ("running" or "recovery").
	ReadyCallbackStatus string
}

type DevcontainerCacheCredentials struct {
	Registry string
	Username string
	Password string
	Ref      string
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

func bootMessageReporterWorkspaceID(cfg *config.Config) (string, bool) {
	if cfg == nil || cfg.ProjectID == "" || cfg.ChatSessionID == "" || cfg.WorkspaceID == "" {
		return "", false
	}
	return cfg.WorkspaceID, true
}

// markReadyCallbackPending flags a workspace's ready callback as undelivered so
// the heartbeat loop can retry it when connectivity is restored.
func (s *Server) markReadyCallbackPending(workspaceID, readyStatus string) {
	s.workspaceMu.Lock()
	defer s.workspaceMu.Unlock()
	if runtime, ok := s.workspaces[workspaceID]; ok {
		runtime.ReadyCallbackPending = true
		runtime.ReadyCallbackStatus = readyStatus
	}
}

// pendingCallbackEntry holds the data needed to retry a single workspace-ready callback.
type pendingCallbackEntry struct {
	WorkspaceID   string
	CallbackToken string
	Status        string
}

// pendingReadyCallbacks returns workspace IDs and their ready statuses for all
// workspaces whose ready callback has not been delivered.
func (s *Server) pendingReadyCallbacks() []pendingCallbackEntry {
	// Read the node-level fallback token before entering workspaceMu
	// to avoid a data race: callbackToken is protected by callbackTokenMu,
	// not by workspaceMu.
	nodeLevelToken := s.getCallbackToken()

	s.workspaceMu.RLock()
	defer s.workspaceMu.RUnlock()
	var pending []pendingCallbackEntry
	for _, runtime := range s.workspaces {
		if runtime.ReadyCallbackPending {
			token := runtime.CallbackToken
			if token == "" {
				token = nodeLevelToken
			}
			pending = append(pending, pendingCallbackEntry{
				WorkspaceID:   runtime.ID,
				CallbackToken: token,
				Status:        runtime.ReadyCallbackStatus,
			})
		}
	}
	return pending
}

// clearReadyCallbackPending clears the pending callback flag for a workspace.
func (s *Server) clearReadyCallbackPending(workspaceID string) {
	s.workspaceMu.Lock()
	defer s.workspaceMu.Unlock()
	if runtime, ok := s.workspaces[workspaceID]; ok {
		runtime.ReadyCallbackPending = false
		runtime.ReadyCallbackStatus = ""
	}
}

// effectivePromptTimeout returns the prompt timeout based on session type.
// Task-driven workspaces (TaskID set) use ACPTaskPromptTimeout (default 6h).
// Direct workspace sessions use ACPPromptTimeout (default 0 = no timeout).
//
// Evaluated once at server startup. The result is baked into acpConfig.PromptTimeout
// and shared by all SessionHosts on this server instance.
func effectivePromptTimeout(cfg *config.Config) time.Duration {
	if cfg.TaskID != "" {
		return cfg.ACPTaskPromptTimeout
	}
	return cfg.ACPPromptTimeout
}

// New creates a new server instance.
func New(cfg *config.Config) (*Server, error) {
	// Create JWT validator with configurable issuer and audience
	jwtValidator, err := auth.NewJWTValidator(cfg.JWKSEndpoint, cfg.NodeID, cfg.JWTIssuer, cfg.JWTAudience)
	if err != nil {
		return nil, fmt.Errorf("failed to create JWT validator: %w", err)
	}

	// Derive cookie domain from control plane URL for cross-subdomain sharing.
	// This allows session cookies set on ws-ABC123.example.com to also be sent
	// to ws-ABC123--3000.example.com (port proxy subdomains).
	baseDomain := config.DeriveBaseDomain(cfg.ControlPlaneURL)
	cookieDomain := ""
	if baseDomain != "" {
		cookieDomain = "." + baseDomain
	}

	// Create session manager with full configuration
	sessionManager := auth.NewSessionManagerWithConfig(auth.SessionManagerConfig{
		CookieName:      cfg.CookieName,
		Secure:          cfg.CookieSecure,
		TTL:             cfg.SessionTTL,
		CleanupInterval: cfg.SessionCleanupInterval,
		MaxSessions:     cfg.SessionMaxCount,
		CookieDomain:    cookieDomain,
	})

	// Setup container discovery for devcontainer exec
	var containerResolver pty.ContainerResolver
	var containerDiscoveryInstance *container.Discovery
	containerWorkDir := "/workspace" // host fallback
	containerUser := ""

	if cfg.IsStandaloneMode() {
		containerWorkDir = cfg.WorkspaceDir
		if containerWorkDir == "" {
			containerWorkDir = "/workspace"
		}
		slog.Info("Standalone mode enabled: PTY and ACP sessions will run locally", "workDir", containerWorkDir)
	} else if cfg.ContainerMode {
		discovery := container.NewDiscovery(container.Config{
			LabelKey:    cfg.ContainerLabelKey,
			LabelValue:  cfg.ContainerLabelValue,
			CacheTTL:    cfg.ContainerCacheTTL,
			BridgeIPTTL: cfg.PortProxyCacheTTL,
		})
		containerResolver = discovery.GetContainerID
		containerDiscoveryInstance = discovery
		containerWorkDir = cfg.ContainerWorkDir
		containerUser = cfg.ContainerUser
		slog.Info("Container mode enabled", "user", containerUser, "workDir", containerWorkDir)
	} else {
		slog.Info("Container mode disabled: PTY sessions will run on host")
	}

	// Create PTY manager
	ptyManager := pty.NewManager(pty.ManagerConfig{
		DefaultShell:       cfg.DefaultShell,
		DefaultRows:        cfg.DefaultRows,
		DefaultCols:        cfg.DefaultCols,
		WorkDir:            containerWorkDir,
		ContainerResolver:  containerResolver,
		ContainerUser:      containerUser,
		ProcessGroup:       cfg.IsStandaloneMode(),
		GracePeriod:        cfg.PTYOrphanGracePeriod,
		BufferSize:         cfg.PTYOutputBufferSize,
		SessionIDMaxLength: cfg.TerminalSessionIDMaxLength,
		CloseGrace:         cfg.PTYCloseGracePeriod,
	})

	// Create error reporter for sending VM agent errors to CF observability.
	errorReporter := errorreport.New(cfg.ControlPlaneURL, cfg.NodeID, cfg.CallbackToken, errorreport.Config{
		FlushInterval: cfg.ErrorReportFlushInterval,
		MaxBatchSize:  cfg.ErrorReportMaxBatchSize,
		MaxQueueSize:  cfg.ErrorReportMaxQueueSize,
		HTTPTimeout:   cfg.ErrorReportHTTPTimeout,
	})

	var processLauncher acp.ProcessLauncher
	if cfg.IsStandaloneMode() {
		processLauncher = acp.LocalLauncher{}
	}

	// Build ACP gateway configuration
	acpGatewayConfig := acp.GatewayConfig{
		InitTimeoutMs:                  cfg.ACPInitTimeoutMs,
		InitializeTimeoutMs:            cfg.ACPInitializeTimeoutMs,
		NewSessionTimeoutMs:            cfg.ACPNewSessionTimeoutMs,
		LoadSessionTimeoutMs:           cfg.ACPLoadSessionTimeoutMs,
		MaxRestartAttempts:             cfg.ACPMaxRestartAttempts,
		ControlPlaneURL:                cfg.ControlPlaneURL,
		ProjectID:                      cfg.ProjectID,
		NodeID:                         cfg.NodeID,
		WorkspaceID:                    defaultWorkspaceScope(cfg.WorkspaceID, cfg.NodeID),
		CallbackToken:                  cfg.CallbackToken,
		ContainerResolver:              containerResolver,
		ContainerUser:                  containerUser,
		ContainerWorkDir:               containerWorkDir,
		ProcessLauncher:                processLauncher,
		GitTokenFetcher:                nil, // set below after server construction
		FileExecTimeout:                cfg.GitExecTimeout,
		FileMaxSize:                    cfg.GitFileMaxSize,
		ErrorReporter:                  errorReporter,
		PingInterval:                   cfg.ACPPingInterval,
		PongTimeout:                    cfg.ACPPongTimeout,
		PromptTimeout:                  effectivePromptTimeout(cfg),
		PromptCancelGracePeriod:        cfg.ACPPromptCancelGrace,
		PromptRetryMaxRetries:          cfg.ACPPromptRetryMaxRetries,
		PromptRetryInitialDelay:        cfg.ACPPromptRetryInitial,
		PromptRetryMaxDelay:            cfg.ACPPromptRetryMax,
		ActivityRereportInterval:       cfg.ACPActivityRereportInterval,
		TerminalActivityReportAttempts: cfg.ACPTerminalActivityReportAttempts,
		TerminalActivityReportBackoff:  cfg.ACPTerminalActivityReportBackoff,
		RecoveryWatchdogTimeout:        cfg.ACPRecoveryWatchdog,
		RestartDecayWindow:             cfg.ACPRestartDecayWindow,
		SAMEnvFallback:                 cfg.BuildSAMEnvFallback(),
		HTTPClient:                     config.NewControlPlaneClient(cfg.HTTPCallbackTimeout),
	}

	// Open persistence store for cross-device session state.
	// Ensure the parent directory exists.
	if err := os.MkdirAll(filepath.Dir(cfg.PersistenceDBPath), 0o700); err != nil {
		return nil, fmt.Errorf("create persistence directory: %w", err)
	}
	store, err := persistence.Open(cfg.PersistenceDBPath)
	if err != nil {
		return nil, fmt.Errorf("open persistence store: %w", err)
	}
	if err := os.Chmod(cfg.PersistenceDBPath, 0o600); err != nil {
		return nil, fmt.Errorf("restrict persistence store permissions: %w", err)
	}
	if cfg.CallbackToken != "" {
		if err := store.SetCallbackTokenEncryptionSecret(cfg.CallbackToken); err != nil {
			return nil, fmt.Errorf("configure persistence token encryption: %w", err)
		}
	}
	if err := store.MarkActiveJobsInterrupted(); err != nil {
		return nil, fmt.Errorf("mark interrupted vm jobs: %w", err)
	}

	// Per-workspace message reporters for chat message persistence.
	// Each workspace gets its own reporter instance with isolated outbox DB,
	// preventing cross-workspace message contamination on multi-workspace nodes.
	messageReporters := make(map[string]*messagereport.Reporter)
	if wsID, ok := bootMessageReporterWorkspaceID(cfg); ok {
		dbPath := messageReporterDBPath(cfg.PersistenceDBPath, wsID)
		msgDB, dbErr := openSQLiteDB(dbPath)
		if dbErr != nil {
			slog.Warn("Failed to open message reporter DB; chat persistence disabled", "error", dbErr)
		} else {
			msgReporterCfg := messagereport.LoadConfigFromEnv()
			msgReporterCfg.ProjectID = cfg.ProjectID
			msgReporterCfg.SessionID = cfg.ChatSessionID
			msgReporterCfg.WorkspaceID = wsID
			msgReporterCfg.Endpoint = cfg.ControlPlaneURL
			r, rErr := messagereport.New(msgDB, msgReporterCfg)
			if rErr != nil {
				slog.Warn("Failed to create message reporter; chat persistence disabled", "error", rErr)
				msgDB.Close()
			} else {
				messageReporters[wsID] = r
				// Set on acpConfig for the boot-time workspace (single-workspace path).
				acpGatewayConfig.MessageReporter = &messageReporterAdapter{r: r}
				slog.Info("Message reporter enabled", "workspaceId", wsID, "projectId", cfg.ProjectID, "sessionId", cfg.ChatSessionID)
			}
		}
	} else if cfg.ProjectID != "" && cfg.ChatSessionID != "" {
		slog.Warn("Message reporter disabled until workspace context is available",
			"projectId", cfg.ProjectID,
			"sessionId", cfg.ChatSessionID,
			"nodeId", cfg.NodeID,
			"reason", "missing_workspace_id",
		)
	}

	// Wire task completion callback for task-driven workspaces.
	// When TaskID is set, the VM agent pushes uncommitted changes and POSTs
	// to the task status callback endpoint after the ACP prompt completes.
	// The callback is wired after server construction so it has access to the
	// server's workspace runtime for git operations.
	deferredTaskCallback := cfg.TaskID != "" && cfg.ProjectID != ""
	_ = deferredTaskCallback // used below after server creation

	// Create system info collector for metrics and version reporting.
	sysInfoCollector := sysinfo.NewCollector(sysinfo.CollectorConfig{
		DockerTimeout:  cfg.SysInfoDockerTimeout,
		VersionTimeout: cfg.SysInfoVersionTimeout,
		CacheTTL:       cfg.SysInfoCacheTTL,
	})

	// Open persistent event store (SQLite-backed, survives restarts).
	evStore, err := eventstore.New(cfg.EventStoreDBPath)
	if err != nil {
		slog.Error("Failed to open event store; falling back to in-memory only", "error", err)
	}

	// Start resource monitor (1-minute snapshots of CPU/memory/disk).
	resMon, err := resourcemon.New(cfg.MetricsDBPath, cfg.MetricsInterval)
	if err != nil {
		slog.Error("Failed to start resource monitor", "error", err)
	}

	s := &Server{
		config:              cfg,
		jwtValidator:        jwtValidator,
		sessionManager:      sessionManager,
		ptyManager:          ptyManager,
		sysInfoCollector:    sysInfoCollector,
		workspaces:          make(map[string]*WorkspaceRuntime),
		nodeEvents:          make([]EventRecord, 0, 512),
		workspaceEvents:     make(map[string][]EventRecord),
		eventStore:          evStore,
		resourceMonitor:     resMon,
		agentSessions:       agentsessions.NewManager(),
		acpConfig:           acpGatewayConfig,
		sessionHosts:        make(map[string]*acp.SessionHost),
		sessionMcpServers:   make(map[string][]acp.McpServerEntry),
		sessionProfileOvr:   make(map[string]profileOverrides),
		sessionTaskCtx:      make(map[string]taskCallbackContext),
		store:               store,
		errorReporter:       errorReporter,
		messageReporters:    messageReporters,
		worktreeCache:       make(map[string]cachedWorktreeList),
		logReader:           logreader.NewReaderWithTimeout(cfg.LogReaderTimeout),
		bootLogBroadcasters: NewBootLogBroadcasterManager(),
		containerDiscovery:  containerDiscoveryInstance,
		portScanners:        make(map[string]*ports.Scanner),
		portDiscoveries:     make(map[string]*container.Discovery),
		callbackToken:       cfg.CallbackToken,
		httpClient:          config.NewControlPlaneClient(cfg.HTTPCallbackTimeout),
		done:                make(chan struct{}),
		publishJobs:         make(map[string]publishJobState),
		applyWatchdogs:      make(map[string]chan struct{}),
		deployEngines:       make(map[string]*deploy.Engine),
		deployRetiring:      make(map[string]bool),
	}

	// GitTokenFetcher is intentionally left nil at the server level.
	// Each SessionHost receives a per-session closure in getOrCreateSessionHost()
	// that captures the correct workspace ID. A nil fetcher is safe: session_host.go
	// guards with `if h.config.GitTokenFetcher != nil`. Setting s.fetchGitToken
	// here would silently use the node-level workspace ID if the per-session
	// override were ever missed — nil fails visibly instead.
	// s.acpConfig.GitTokenFetcher = nil  (already the zero value)

	// Task completion callbacks are bound per SessionHost in
	// getOrCreateSessionHost(). A server-level callback would reuse boot-time
	// task/workspace IDs for later workspaces on a warm multi-workspace node.
	if deferredTaskCallback {
		slog.Info("Task completion callback context available at boot",
			"taskId", cfg.TaskID,
			"projectId", cfg.ProjectID,
			"workspaceId", cfg.WorkspaceID,
			"binding", "per_session",
		)
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
			ContainerUser:       strings.TrimSpace(cfg.ContainerUser),
			CallbackToken:       strings.TrimSpace(cfg.CallbackToken),
			ProjectID:           strings.TrimSpace(cfg.ProjectID),
			Lightweight:         cfg.IsStandaloneMode(),
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

// SetDeployEngine wires the deployment engine into the server for heartbeat reporting
// and pull-based release channel. Only used in deployment mode.
func (s *Server) SetDeployEngine(engine *deploy.Engine) {
	if engine == nil {
		return
	}
	s.deployMu.Lock()
	defer s.deployMu.Unlock()
	s.deployEngines[engine.EnvironmentID()] = engine
}

// SetDeployVerifier configures the signing verifier used by deployment engines
// discovered after startup from heartbeat placement responses.
func (s *Server) SetDeployVerifier(verifier *deploy.Verifier) {
	s.deployMu.Lock()
	defer s.deployMu.Unlock()
	s.deployVerifier = verifier
}

func (s *Server) deploymentEnginesSnapshot() map[string]*deploy.Engine {
	s.deployMu.Lock()
	defer s.deployMu.Unlock()
	snapshot := make(map[string]*deploy.Engine, len(s.deployEngines))
	for envID, engine := range s.deployEngines {
		snapshot[envID] = engine
	}
	return snapshot
}

func (s *Server) ensureDeployEngine(environmentID string) *deploy.Engine {
	environmentID = strings.TrimSpace(environmentID)
	if environmentID == "" {
		return nil
	}

	s.deployMu.Lock()
	if engine := s.deployEngines[environmentID]; engine != nil {
		s.deployMu.Unlock()
		return engine
	}
	verifier := s.deployVerifier
	s.deployMu.Unlock()

	disk, err := deploy.NewDiskState(filepath.Join(s.config.DeployBaseDir, deploy.SafeEnvironmentFilePart(environmentID)))
	if err != nil {
		slog.Error("deploy: failed to initialize environment disk state", "environmentId", environmentID, "error", err)
		return nil
	}

	engine := deploy.NewEngine(disk, verifier, deploy.EngineConfig{
		EnvironmentID:      environmentID,
		NodeID:             s.config.NodeID,
		ControlPlaneURL:    s.config.ControlPlaneURL,
		CallbackToken:      s.getCallbackToken(),
		ComposeCmd:         s.config.DeployComposeCmd,
		ComposeProjectName: "sam-env-" + deploy.SafeEnvironmentFilePart(environmentID),
		HealthTimeout:      s.config.DeployHealthTimeout,
		HTTPClient: deploy.NewArtifactHTTPClient(deploy.ArtifactHTTPClientConfig{
			DialTimeout:           s.config.DeployArtifactDialTimeout,
			TLSHandshakeTimeout:   s.config.DeployArtifactTLSHandshakeTimeout,
			ResponseHeaderTimeout: s.config.DeployArtifactResponseHeaderTimeout,
		}),
		ArtifactIdleTimeout: s.config.DeployArtifactIdleTimeout,
		ApplyProgress:       s.persistApplyProgress,
		ACMEEmail:           s.config.DeployACMEEmail,
		ACMECA:              s.config.DeployACMECA,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	if err := engine.ReconcileOnStart(ctx); err != nil {
		slog.Error("deploy: reconcile environment on discovery failed", "environmentId", environmentID, "error", err)
	}
	cancel()

	s.deployMu.Lock()
	defer s.deployMu.Unlock()
	if existing := s.deployEngines[environmentID]; existing != nil {
		return existing
	}
	s.deployEngines[environmentID] = engine
	return engine
}

func (s *Server) retireDeployEngines(retireEnvironmentIDs map[string]bool) {
	if len(retireEnvironmentIDs) == 0 {
		return
	}

	s.deployMu.Lock()
	if s.deployRetiring == nil {
		s.deployRetiring = make(map[string]bool)
	}
	var retired []struct {
		environmentID string
		engine        *deploy.Engine
	}
	for environmentID, engine := range s.deployEngines {
		if !retireEnvironmentIDs[environmentID] || s.deployRetiring[environmentID] {
			continue
		}
		s.deployRetiring[environmentID] = true
		retired = append(retired, struct {
			environmentID string
			engine        *deploy.Engine
		}{environmentID: environmentID, engine: engine})
	}
	s.deployMu.Unlock()

	for _, item := range retired {
		go func(environmentID string, engine *deploy.Engine) {
			ctx, cancel := context.WithTimeout(context.Background(), s.deployTeardownTimeout())
			defer cancel()
			if err := engine.Teardown(ctx); err != nil {
				s.deployMu.Lock()
				delete(s.deployRetiring, environmentID)
				s.deployMu.Unlock()
				slog.Error("deploy: retired environment teardown failed", "environmentId", environmentID, "error", err)
				return
			}
			s.deployMu.Lock()
			if s.deployRetiring[environmentID] && s.deployEngines[environmentID] == engine {
				delete(s.deployEngines, environmentID)
			}
			delete(s.deployRetiring, environmentID)
			s.deployMu.Unlock()
			slog.Info("deploy: retired environment teardown complete", "environmentId", environmentID)
		}(item.environmentID, item.engine)
	}
}

// GetBootLogBroadcaster returns the broadcaster for a specific workspace.
// For the boot-time bootstrap path, use the server's configured WorkspaceID.
// Wire this into the bootlog.Reporter via SetBroadcaster() to enable real-time
// log delivery during bootstrap/provisioning.
// GetEventStore returns the event store for external use (e.g., provisioning logging).
func (s *Server) GetEventStore() *eventstore.Store {
	return s.eventStore
}

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

// UpdateAfterBootstrap propagates bootstrap-discovered state (callback token,
// container user, etc.) to subsystems that were created before bootstrap ran,
// and signals that bootstrap is complete.
//
// The server is created before bootstrap so that /health and /boot-log/ws are
// available during provisioning. This means the PTY manager and ACP gateway
// config are initially constructed with empty values for fields that bootstrap
// populates (e.g. ContainerUser, CallbackToken). This method back-fills them.
func (s *Server) UpdateAfterBootstrap(cfg *config.Config) {
	// Propagate callback token to error reporter.
	s.errorReporter.SetToken(cfg.CallbackToken)

	// Refresh per-workspace message reporter tokens from workspace runtime
	// state. Do not propagate node-level fallback tokens to reporters.
	s.setTokenAllReporters()

	// Update ACP gateway config with the callback token.
	s.acpConfig.CallbackToken = cfg.CallbackToken

	// Propagate the detected devcontainer user to the PTY manager and ACP
	// gateway config. Bootstrap detects the container user (e.g. "node") via
	// devcontainer read-configuration / metadata / docker exec fallback, but
	// this happens after server.New() has already captured an empty value.
	if detectedUser := strings.TrimSpace(cfg.ContainerUser); detectedUser != "" {
		if strings.TrimSpace(s.config.ContainerUser) == "" {
			s.config.ContainerUser = detectedUser
		}
		if s.acpConfig.ContainerUser == "" {
			s.acpConfig.ContainerUser = detectedUser
		}
		if s.ptyManager != nil {
			s.ptyManager.SetContainerUser(detectedUser)
		}
		slog.Info("Propagated bootstrap container user", "user", detectedUser)
	}

	// Update workspace runtime with the callback token.
	s.workspaceMu.Lock()
	if ws, ok := s.workspaces[cfg.WorkspaceID]; ok {
		ws.CallbackToken = cfg.CallbackToken
	}
	s.workspaceMu.Unlock()

	s.bootstrapComplete.Store(true)

	// Start port scanner for the boot-time workspace now that the container is available.
	if cfg.WorkspaceID != "" {
		s.StartPortScanner(cfg.WorkspaceID)
	}

	// Notify WebSocket clients that bootstrap is complete.
	if s.config.WorkspaceID != "" {
		if broadcaster := s.bootLogBroadcasters.Get(s.config.WorkspaceID); broadcaster != nil {
			broadcaster.MarkComplete()
		}
	}
}

// StartPortScanner starts port scanning for a workspace if enabled.
// Called after bootstrap completes and the container is available.
func (s *Server) StartPortScanner(workspaceID string) {
	if !s.config.PortScanEnabled || !s.config.ContainerMode || s.config.IsStandaloneMode() {
		return
	}

	// Create a per-workspace container discovery using the workspace's actual
	// ContainerLabelValue. The server-level s.containerDiscovery may have a stale
	// label value (e.g., "/workspace" when REPOSITORY was empty at startup), while
	// the workspace runtime has the correct value (e.g., "/workspace/repo-name")
	// derived from the repository passed during workspace creation.
	var wsDiscovery *container.Discovery
	s.workspaceMu.RLock()
	if runtime, ok := s.workspaces[workspaceID]; ok && runtime.ContainerLabelValue != "" {
		wsDiscovery = container.NewDiscovery(container.Config{
			LabelKey:    s.config.ContainerLabelKey,
			LabelValue:  runtime.ContainerLabelValue,
			CacheTTL:    s.config.ContainerCacheTTL,
			BridgeIPTTL: s.config.PortProxyCacheTTL,
		})
		slog.Info("Port scanner: using workspace-specific container label",
			"workspaceId", workspaceID,
			"labelValue", runtime.ContainerLabelValue)
	}
	s.workspaceMu.RUnlock()

	// Fall back to server-level discovery if no workspace-specific one is available.
	if wsDiscovery == nil {
		wsDiscovery = s.containerDiscovery
	}

	// Resolve container ID for scanning — if not available yet, the scanner
	// will lazily resolve it on each tick via the ContainerResolver callback.
	var containerID string
	if wsDiscovery != nil {
		if id, err := wsDiscovery.GetContainerID(); err == nil {
			containerID = id
		} else {
			slog.Info("Port scanner: container not yet available, will resolve lazily", "workspaceId", workspaceID, "error", err)
		}
	}

	baseDomain := config.DeriveBaseDomain(s.config.ControlPlaneURL)
	excludePorts := ports.ParseExcludePorts(s.config.PortScanExclude)
	// Merge with defaults
	for port := range ports.DefaultExcludePorts() {
		excludePorts[port] = true
	}

	// Build a container resolver for lazy resolution when container isn't ready yet.
	var containerResolver ports.ContainerResolver
	if wsDiscovery != nil {
		containerResolver = func() (string, error) {
			return wsDiscovery.GetContainerID()
		}
	}

	scanner := ports.NewScanner(ports.ScannerConfig{
		Enabled:           true,
		Interval:          s.config.PortScanInterval,
		ExcludePorts:      excludePorts,
		EphemeralMin:      s.config.PortScanEphemeralMin,
		BaseDomain:        baseDomain,
		WorkspaceID:       workspaceID,
		ContainerID:       containerID,
		ContainerResolver: containerResolver,
		EventEmitter: func(eventType, message string, detail map[string]interface{}) {
			s.appendNodeEvent(workspaceID, "info", eventType, message, detail)
		},
	})

	s.portScannerMu.Lock()
	// Stop existing scanner if any
	if existing, ok := s.portScanners[workspaceID]; ok {
		existing.Stop()
	}
	if s.portScanners == nil {
		s.portScanners = make(map[string]*ports.Scanner)
	}
	s.portScanners[workspaceID] = scanner
	// Store per-workspace discovery so port proxy can resolve the correct bridge IP.
	if wsDiscovery != nil {
		if s.portDiscoveries == nil {
			s.portDiscoveries = make(map[string]*container.Discovery)
		}
		s.portDiscoveries[workspaceID] = wsDiscovery
	}
	s.portScannerMu.Unlock()

	scanner.Start()
	slog.Info("Port scanner started", "workspaceId", workspaceID, "interval", s.config.PortScanInterval)
}

// stopPortScanner stops the port scanner for a workspace.
func (s *Server) stopPortScanner(workspaceID string) {
	s.portScannerMu.Lock()
	scanner, ok := s.portScanners[workspaceID]
	if ok {
		delete(s.portScanners, workspaceID)
	}
	delete(s.portDiscoveries, workspaceID)
	s.portScannerMu.Unlock()

	if scanner != nil {
		scanner.Stop()
		slog.Info("Port scanner stopped", "workspaceId", workspaceID)
	}
}

// stopAllPortScanners stops all active port scanners.
func (s *Server) stopAllPortScanners() {
	s.portScannerMu.Lock()
	scanners := make(map[string]*ports.Scanner, len(s.portScanners))
	for k, v := range s.portScanners {
		scanners[k] = v
	}
	s.portScanners = make(map[string]*ports.Scanner)
	s.portDiscoveries = make(map[string]*container.Discovery)
	s.portScannerMu.Unlock()

	for wsID, scanner := range scanners {
		scanner.Stop()
		slog.Info("Port scanner stopped", "workspaceId", wsID)
	}
}

// Start starts the HTTP server (plain HTTP or TLS based on config).
func (s *Server) Start() error {
	s.startNodeHealthReporter()
	s.startAcpHeartbeatReporter()

	// Start error reporter background flush
	s.errorReporter.Start()

	if s.config.TLSEnabled {
		slog.Info("Starting VM Agent with TLS", "addr", s.httpServer.Addr, "cert", s.config.TLSCertPath, "key", s.config.TLSKeyPath)
		return s.httpServer.ListenAndServeTLS(s.config.TLSCertPath, s.config.TLSKeyPath)
	}

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

	// Stop all port scanners
	s.stopAllPortScanners()

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

	// Flush and stop all per-workspace message reporters
	s.shutdownAllReporters()

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

	// Terminal WebSocket (single-session and multi-session)
	mux.HandleFunc("GET /terminal/ws", s.handleTerminalWS)
	mux.HandleFunc("GET /terminal/ws/multi", s.handleMultiTerminalWS)
	mux.HandleFunc("POST /terminal/resize", s.handleTerminalResize)

	// Node/workspace management routes (control-plane authenticated).
	mux.HandleFunc("GET /workspaces", s.handleListWorkspaces)
	mux.HandleFunc("POST /workspaces", s.handleCreateWorkspace)
	mux.HandleFunc("POST /deployment/environments/{environmentId}/teardown", s.handleTeardownDeploymentEnvironment)
	mux.HandleFunc("GET /workspaces/{workspaceId}/events", s.handleListWorkspaceEvents)
	mux.HandleFunc("POST /workspaces/{workspaceId}/stop", s.handleStopWorkspace)
	mux.HandleFunc("POST /workspaces/{workspaceId}/restart", s.handleRestartWorkspace)
	mux.HandleFunc("POST /workspaces/{workspaceId}/rebuild", s.handleRebuildWorkspace)
	mux.HandleFunc("DELETE /workspaces/{workspaceId}", s.handleDeleteWorkspace)
	mux.HandleFunc("GET /workspaces/{workspaceId}/agent-sessions", s.handleListAgentSessions)
	mux.HandleFunc("POST /workspaces/{workspaceId}/agent-sessions", s.handleCreateAgentSession)
	mux.HandleFunc("POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/start", s.handleStartAgentSession)
	mux.HandleFunc("POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/cancel", s.handleCancelAgentSession)
	mux.HandleFunc("POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/stop", s.handleStopAgentSession)
	mux.HandleFunc("POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/suspend", s.handleSuspendAgentSession)
	mux.HandleFunc("POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/resume", s.handleResumeAgentSession)
	mux.HandleFunc("POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/prompt", s.handleSendPrompt)
	mux.HandleFunc("POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/hibernate", s.handleHibernateAgentSession)
	mux.HandleFunc("POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/restore", s.handleRestoreAgentSession)
	mux.HandleFunc("GET /workspaces/{workspaceId}/tabs", s.handleListTabs)

	// Git integration (browser-authenticated via workspace session/token)
	mux.HandleFunc("GET /workspaces/{workspaceId}/git/status", s.handleGitStatus)
	mux.HandleFunc("GET /workspaces/{workspaceId}/git/diff", s.handleGitDiff)
	mux.HandleFunc("GET /workspaces/{workspaceId}/git/file", s.handleGitFile)
	mux.HandleFunc("GET /workspaces/{workspaceId}/git/branches", s.handleGitBranches)

	// File browser (browser-authenticated via workspace session/token)
	mux.HandleFunc("GET /workspaces/{workspaceId}/files/list", s.handleFileList)
	mux.HandleFunc("GET /workspaces/{workspaceId}/files/find", s.handleFileFind)
	mux.HandleFunc("GET /workspaces/{workspaceId}/files/raw", s.handleFileRaw)
	mux.HandleFunc("POST /workspaces/{workspaceId}/files/upload", s.handleFileUpload)
	mux.HandleFunc("GET /workspaces/{workspaceId}/files/download", s.handleFileDownload)
	mux.HandleFunc("GET /workspaces/{workspaceId}/worktrees", s.handleListWorktrees)
	mux.HandleFunc("POST /workspaces/{workspaceId}/worktrees", s.handleCreateWorktree)
	mux.HandleFunc("DELETE /workspaces/{workspaceId}/worktrees", s.handleRemoveWorktree)

	mux.HandleFunc("GET /debug-package", s.handleDebugPackage)
	mux.HandleFunc("GET /events", s.handleListNodeEvents)
	mux.HandleFunc("GET /events/export", s.handleExportEvents)
	mux.HandleFunc("GET /metrics/export", s.handleExportMetrics)
	mux.HandleFunc("GET /system-info", s.handleSystemInfo)
	mux.HandleFunc("GET /logs", s.handleLogs)
	mux.HandleFunc("GET /logs/stream", s.handleLogStream)
	mux.HandleFunc("GET /containers", s.handleContainers)
	mux.HandleFunc("GET /workspaces/{workspaceId}/ports", s.handleListWorkspacePorts)
	mux.HandleFunc("/workspaces/{workspaceId}/local-forward/{port}/{path...}", s.handleWorkspaceLocalForward)
	mux.HandleFunc("/workspaces/{workspaceId}/local-forward/{port}", s.handleWorkspaceLocalForward)
	mux.HandleFunc("/workspaces/{workspaceId}/ports/{port}/{path...}", s.handleWorkspacePortProxy)
	mux.HandleFunc("/workspaces/{workspaceId}/ports/{port}", s.handleWorkspacePortProxy)

	// MCP workspace tools (proxied from sam-mcp via API Worker)
	mux.HandleFunc("GET /workspaces/{workspaceId}/mcp/workspace-info", s.handleMcpWorkspaceInfo)
	mux.HandleFunc("GET /workspaces/{workspaceId}/mcp/credential-status", s.handleMcpCredentialStatus)
	mux.HandleFunc("GET /workspaces/{workspaceId}/mcp/network-info", s.handleMcpNetworkInfo)
	mux.HandleFunc("POST /workspaces/{workspaceId}/mcp/expose-port", s.handleMcpExposePort)
	mux.HandleFunc("GET /workspaces/{workspaceId}/mcp/diff-summary", s.handleMcpDiffSummary)
	mux.HandleFunc("POST /workspaces/{workspaceId}/mcp/build-and-publish", s.handleMcpBuildAndPublish)
	mux.HandleFunc("POST /workspaces/{workspaceId}/mcp/build-and-publish-jobs/{jobId}/start", s.handleMcpBuildAndPublishJobStart)

	// Boot log WebSocket (available during bootstrap for real-time streaming)
	mux.HandleFunc("GET /boot-log/ws", s.handleBootLogWS)

	// ACP Agent WebSocket
	mux.HandleFunc("GET /agent/ws", s.handleAgentWS)
	mux.HandleFunc("GET /git-credential", s.handleGitCredential)
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

// getOrCreateReporter returns the per-workspace message reporter, creating one
// if it doesn't exist yet. This handles both auto-provisioned nodes (reporter
// created at boot) and manually provisioned nodes (late-initialized here).
// Returns nil if creation fails (errors are logged, not propagated).
//
// Uses double-checked locking to avoid holding messageReportersMu during
// disk I/O (SQLite open + migration).
func (s *Server) getOrCreateReporter(workspaceID, projectID, chatSessionID string) *messagereport.Reporter {
	// Fast path: reporter already exists (read-only check).
	s.messageReportersMu.RLock()
	if r, ok := s.messageReporters[workspaceID]; ok {
		s.messageReportersMu.RUnlock()
		// The boot-time reporter is created before the workspace callback token
		// is available, and standalone mode never runs bootstrap's
		// setTokenAllReporters. Refresh the token from the workspace runtime on
		// access so the reporter can authenticate its message POSTs (otherwise
		// it fails with "no auth token" and chat messages never persist).
		if token := s.workspaceCallbackToken(workspaceID); token != "" {
			r.SetToken(token)
		}
		return r
	}
	s.messageReportersMu.RUnlock()

	// Message persistence uses workspace-scoped endpoints. A node-scoped
	// fallback token is intentionally not accepted here because the API rejects
	// it and permanent 403s would discard chat messages.
	token := s.workspaceCallbackToken(workspaceID)

	// Slow path: create reporter outside the lock (disk I/O).
	cfg := messagereport.LoadConfigFromEnv()
	cfg.ProjectID = projectID
	cfg.SessionID = chatSessionID
	cfg.WorkspaceID = workspaceID
	cfg.Endpoint = s.config.ControlPlaneURL

	dbPath := messageReporterDBPath(s.config.PersistenceDBPath, workspaceID)
	msgDB, err := openSQLiteDB(dbPath)
	if err != nil {
		slog.Error("Failed to open message reporter DB", "workspaceId", workspaceID, "error", err)
		return nil
	}

	reporter, err := messagereport.New(msgDB, cfg)
	if err != nil {
		slog.Error("Failed to create message reporter", "workspaceId", workspaceID, "error", err)
		msgDB.Close()
		return nil
	}
	if reporter == nil {
		// No project/session context — intentional no-op path.
		msgDB.Close()
		return nil
	}

	if token != "" {
		reporter.SetToken(token)
	}

	// Re-acquire lock and check again — a concurrent call may have won the race.
	s.messageReportersMu.Lock()
	defer s.messageReportersMu.Unlock()

	if existing, ok := s.messageReporters[workspaceID]; ok {
		// Concurrent creation won — discard our duplicate.
		reporter.Shutdown()
		return existing
	}

	s.messageReporters[workspaceID] = reporter
	slog.Info("Message reporter created for workspace",
		"workspaceId", workspaceID,
		"projectId", projectID,
		"chatSessionId", chatSessionID,
	)
	return reporter
}

// shutdownReporter shuts down the message reporter for a workspace (if any),
// performing a final flush before cleanup.
func (s *Server) shutdownReporter(workspaceID string) {
	s.messageReportersMu.Lock()
	r, ok := s.messageReporters[workspaceID]
	if ok {
		delete(s.messageReporters, workspaceID)
	}
	s.messageReportersMu.Unlock()

	if r != nil {
		r.Shutdown()
		slog.Info("Message reporter shut down", "workspaceId", workspaceID)
	}
}

// shutdownAllReporters shuts down all per-workspace reporters.
func (s *Server) shutdownAllReporters() {
	s.messageReportersMu.Lock()
	reporters := make(map[string]*messagereport.Reporter, len(s.messageReporters))
	for k, v := range s.messageReporters {
		reporters[k] = v
	}
	s.messageReporters = make(map[string]*messagereport.Reporter)
	s.messageReportersMu.Unlock()

	for wsID, r := range reporters {
		r.Shutdown()
		slog.Info("Message reporter shut down", "workspaceId", wsID)
	}
}

// setTokenAllReporters refreshes each active reporter with its workspace token.
func (s *Server) setTokenAllReporters() {
	s.messageReportersMu.RLock()
	snapshot := make(map[string]*messagereport.Reporter, len(s.messageReporters))
	for workspaceID, r := range s.messageReporters {
		snapshot[workspaceID] = r
	}
	s.messageReportersMu.RUnlock()

	for workspaceID, r := range snapshot {
		if workspaceToken := s.workspaceCallbackToken(workspaceID); workspaceToken != "" {
			r.SetToken(workspaceToken)
		}
	}
}

// messageReporterDBPath returns the SQLite DB path for a workspace's message
// reporter. Each workspace gets an isolated DB to prevent cross-workspace
// contamination in the outbox. Workspace IDs are sanitized to prevent path
// traversal.
func messageReporterDBPath(basePath, workspaceID string) string {
	// Sanitize: replace path-unsafe characters to prevent directory traversal.
	safe := strings.NewReplacer("/", "_", "..", "_", "\x00", "_").Replace(workspaceID)
	dir := filepath.Dir(basePath)
	return filepath.Join(dir, "messages-"+safe+".db")
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
		Origin:       entry.Origin,
	})
}

// makeTaskCompletionCallback returns an OnPromptComplete callback that:
//  1. On success: runs git add/commit/push inside the workspace container,
//     optionally creates a PR via gh, then POSTs executionStep=awaiting_followup
//     with the gitPushResult to the control plane (leaving the task running for
//     follow-up messages).
//  2. On failure: POSTs toStatus=failed to the control plane.
//
// The callback reads the current server callback token when it fires so it can
// use refreshed credentials, while task/workspace ownership stays fixed in the
// closure.
func (s *Server) makeTaskCompletionCallback(
	controlPlaneURL, projectID, taskID, workspaceID, taskMode string,
) func(stopReason string, promptErr error) {
	callbackURL := fmt.Sprintf("%s/api/projects/%s/tasks/%s/status/callback",
		strings.TrimRight(controlPlaneURL, "/"), projectID, taskID)

	return func(stopReason string, promptErr error) {
		if isPromptCancellation(stopReason, promptErr) {
			s.postTaskCallback(
				callbackURL,
				taskID,
				s.callbackTokenForWorkspace(workspaceID),
				awaitingFollowupCallbackBody(gitPushResult{}),
			)
			return
		}

		if stopReason == "recovered" {
			s.postTaskCallback(
				callbackURL,
				taskID,
				s.callbackTokenForWorkspace(workspaceID),
				awaitingFollowupCallbackBody(gitPushResult{}),
			)
			return
		}

		if stopReason == fatalErrorStopReason {
			reason := "Agent prompt failed"
			errorMessage := taskCallbackErrorMessage(promptErr)
			s.postTaskCallback(callbackURL, taskID, s.callbackTokenForWorkspace(workspaceID), map[string]interface{}{
				"toStatus":     "failed",
				"reason":       reason,
				"errorMessage": errorMessage,
			})
			return
		}

		if promptErr != nil || stopReason == "error" {
			if taskMode == config.TaskModeConversation {
				body := awaitingFollowupCallbackBody(gitPushResult{})
				body["errorMessage"] = taskCallbackErrorMessage(promptErr)
				s.postTaskCallback(callbackURL, taskID, s.callbackTokenForWorkspace(workspaceID), body)
				return
			}

			reason := "Agent prompt failed"
			errorMessage := taskCallbackErrorMessage(promptErr)
			s.postTaskCallback(callbackURL, taskID, s.callbackTokenForWorkspace(workspaceID), map[string]interface{}{
				"toStatus":     "failed",
				"reason":       reason,
				"errorMessage": errorMessage,
			})
			return
		}

		// On success, push changes and report awaiting_followup.
		// Conversation mode does not have a task-owned git lifecycle. Skip all
		// git work so old boot-level conversation tasks cannot push against an
		// empty or stale workspace ID.
		skipGit := taskMode == config.TaskModeConversation || workspaceID == ""
		pushResult := gitPushResult{}
		if !skipGit {
			pushResult = s.gitPushWorkspaceChanges(workspaceID, false)
		}

		slog.Info("Agent completion git push result",
			"taskId", taskID,
			"workspaceId", workspaceID,
			"taskMode", taskMode,
			"skipped", skipGit,
			"pushed", pushResult.Pushed,
			"commitSha", pushResult.CommitSha,
			"prUrl", pushResult.PrURL,
			"error", pushResult.Error,
		)

		// Send executionStep=awaiting_followup with git push results.
		// The task stays in running status, waiting for user follow-up.
		// The idle timer (Phase 6) will eventually clean up if no follow-up.
		s.postTaskCallback(
			callbackURL,
			taskID,
			s.callbackTokenForWorkspace(workspaceID),
			awaitingFollowupCallbackBody(pushResult),
		)
	}
}

func isPromptCancellation(stopReason string, promptErr error) bool {
	return stopReason == "cancelled" || stopReason == "canceled"
}

func taskCallbackErrorMessage(promptErr error) string {
	if promptErr == nil {
		return ""
	}
	return redactTaskCallbackDiagnosticText(promptErr.Error())
}

func redactTaskCallbackDiagnosticText(text string) string {
	redacted := text
	for _, pattern := range taskCallbackDiagnosticRedactionPatterns {
		redacted = pattern.ReplaceAllStringFunc(redacted, func(match string) string {
			submatches := pattern.FindStringSubmatch(match)
			if len(submatches) >= 3 {
				return submatches[1] + "[REDACTED]"
			}
			if len(submatches) >= 2 && strings.HasSuffix(strings.ToLower(submatches[1]), " ") {
				return submatches[1] + "[REDACTED]"
			}
			return "[REDACTED]"
		})
	}
	return redacted
}

func awaitingFollowupCallbackBody(pushResult gitPushResult) map[string]interface{} {
	return map[string]interface{}{
		"executionStep": "awaiting_followup",
		"gitPushResult": map[string]interface{}{
			"pushed":                pushResult.Pushed,
			"commitSha":             pushResult.CommitSha,
			"branchName":            pushResult.BranchName,
			"prUrl":                 pushResult.PrURL,
			"prNumber":              pushResult.PrNumber,
			"hasUncommittedChanges": pushResult.HasUncommittedChanges,
			"error":                 pushResult.Error,
		},
	}
}

// postTaskCallback sends a JSON payload to the task status callback endpoint.
func (s *Server) postTaskCallback(callbackURL, taskID, token string, body map[string]interface{}) {
	payload, err := json.Marshal(body)
	if err != nil {
		slog.Error("Task callback: marshal error", "error", err)
		return
	}

	if token == "" {
		slog.Warn("Task callback: no callback token available, skipping")
		return
	}

	req, err := http.NewRequest("POST", callbackURL, bytes.NewReader(payload))
	if err != nil {
		slog.Error("Task callback: request creation error", "error", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := s.controlPlaneHTTPClient(0).Do(req)
	if err != nil {
		slog.Error("Task callback: request failed", "error", err, "url", callbackURL, "taskId", taskID)
		return
	}
	defer resp.Body.Close()
	responseBody := readBoundedResponseBody(resp.Body)

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		slog.Info("Task callback sent", "taskId", taskID, "body", string(payload))
	} else {
		slog.Error("Task callback: unexpected status",
			"statusCode", resp.StatusCode,
			"taskId", taskID,
			"callbackURL", callbackURL,
			"responseBody", responseBody,
		)
	}
}

const maxLoggedResponseBodyBytes int64 = 2048

func readBoundedResponseBody(body io.Reader) string {
	if body == nil {
		return ""
	}
	data, err := io.ReadAll(io.LimitReader(body, maxLoggedResponseBodyBytes))
	if err != nil {
		return fmt.Sprintf("<read error: %v>", err)
	}
	return strings.TrimSpace(string(data))
}

// gitPushResult holds the outcome of a git push attempt inside a workspace.
type gitPushResult struct {
	Pushed                bool
	CommitSha             string
	BranchName            string
	PrURL                 string
	PrNumber              int
	HasUncommittedChanges bool
	Error                 string
}

type gitlabMergeRequestResponse struct {
	WebURL string `json:"web_url"`
	IID    int    `json:"iid"`
}

func (s *Server) runWorkspaceGitCommand(containerID, workDir, user string, args ...string) (string, error) {
	timeout := s.config.GitExecTimeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	stdout, stderr, err := s.execInContainer(ctx, containerID, user, workDir, append([]string{"git"}, args...)...)
	output := strings.TrimSpace(stdout)
	if strings.TrimSpace(stderr) != "" {
		output = strings.TrimSpace(output + "\n" + strings.TrimSpace(stderr))
	}
	return output, err
}

// gitPushWorkspaceChanges runs git status/add/commit/push inside the workspace
// container and optionally creates a PR. When skipPR is true (conversation mode),
// the PR creation step is skipped — the human controls when to create PRs.
func (s *Server) gitPushWorkspaceChanges(workspaceID string, skipPR bool) gitPushResult {
	result := gitPushResult{}

	containerID, workDir, user, err := s.resolveContainerForWorkspace(workspaceID)
	if err != nil {
		result.Error = fmt.Sprintf("resolve container: %s", err)
		return result
	}

	// Check for uncommitted changes
	statusOutput, err := s.runWorkspaceGitCommand(containerID, workDir, user, "status", "--porcelain")
	if err != nil {
		result.Error = fmt.Sprintf("git status failed: %s", err)
		return result
	}

	if statusOutput == "" {
		// No changes — nothing to push. Check if there are unpushed commits.
		logOutput, logErr := s.runWorkspaceGitCommand(containerID, workDir, user, "log", "--oneline", "@{push}..", "--")
		if logErr != nil || strings.TrimSpace(logOutput) == "" {
			slog.Info("No changes or unpushed commits", "workspaceId", workspaceID)
			return result
		}
		// There are unpushed commits — push them
	} else {
		result.HasUncommittedChanges = true

		// Stage all changes
		if _, err := s.runWorkspaceGitCommand(containerID, workDir, user, "add", "-A"); err != nil {
			result.Error = fmt.Sprintf("git add failed: %s", err)
			return result
		}

		// Commit
		commitOutput, err := s.runWorkspaceGitCommand(containerID, workDir, user, "commit", "-m", "chore: save agent work\n\nAuto-committed by SAM on agent completion.")
		if err != nil {
			result.Error = fmt.Sprintf("git commit failed: %s: %s", err, commitOutput)
			return result
		}
	}

	// Get the commit SHA
	sha, _ := s.runWorkspaceGitCommand(containerID, workDir, user, "rev-parse", "HEAD")
	result.CommitSha = sha

	// Get the current branch name
	branchOutput, _ := s.runWorkspaceGitCommand(containerID, workDir, user, "rev-parse", "--abbrev-ref", "HEAD")
	result.BranchName = branchOutput

	// Push
	pushOutput, err := s.runWorkspaceGitCommand(containerID, workDir, user, "push", "--set-upstream", "origin", "HEAD")
	if err != nil {
		result.Error = fmt.Sprintf("git push failed: %s: %s", err, pushOutput)
		return result
	}
	result.Pushed = true

	slog.Info("Git push succeeded", "workspaceId", workspaceID, "branch", result.BranchName, "sha", result.CommitSha)

	// Try to create a PR via gh (best-effort) — skip in conversation mode
	if !skipPR {
		prURL, prNumber := s.tryCreateReviewRequest(workspaceID, containerID, workDir, user, result.BranchName)
		result.PrURL = prURL
		result.PrNumber = prNumber
	}

	return result
}

func (s *Server) tryCreateReviewRequest(workspaceID, containerID, workDir, user, sourceBranch string) (string, int) {
	if runtime, ok := s.getWorkspaceRuntime(workspaceID); ok {
		switch strings.ToLower(strings.TrimSpace(runtime.RepoProvider)) {
		case "gitlab":
			return s.tryCreateGitLabMergeRequest(runtime, sourceBranch)
		case "artifacts":
			slog.Info("Review request creation skipped for Artifacts workspace", "workspaceID", workspaceID)
			return "", 0
		}
	}
	return s.tryCreatePR(containerID, workDir, user)
}

func (s *Server) tryCreateGitLabMergeRequest(runtime *WorkspaceRuntime, sourceBranch string) (string, int) {
	if runtime == nil {
		return "", 0
	}
	host := strings.TrimSpace(runtime.RepositoryHost)
	repositoryPath := strings.TrimSpace(runtime.RepositoryPath)
	targetBranch := strings.TrimSpace(runtime.Branch)
	if host == "" || repositoryPath == "" || sourceBranch == "" || targetBranch == "" {
		slog.Warn("GitLab MR creation skipped: repository metadata missing", "workspaceID", runtime.ID)
		return "", 0
	}

	// Bound the entire MR flow (token fetch + create + 409 lookup) so a dead or
	// slow GitLab host cannot stall task completion. Mirrors tryCreatePR.
	timeout := s.config.GitExecTimeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	resp, err := s.fetchGitTokenResponseForWorkspace(ctx, runtime.ID, "")
	if err != nil {
		slog.Warn("GitLab MR creation skipped: token fetch failed", "workspaceID", runtime.ID, "error", err)
		return "", 0
	}

	form := url.Values{}
	form.Set("source_branch", sourceBranch)
	form.Set("target_branch", targetBranch)
	form.Set("title", fmt.Sprintf("SAM task changes from %s", sourceBranch))
	endpoint := fmt.Sprintf(
		"https://%s/api/v4/projects/%s/merge_requests",
		host,
		url.PathEscape(repositoryPath),
	)
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		endpoint,
		strings.NewReader(form.Encode()),
	)
	if err != nil {
		slog.Warn("GitLab MR create request build failed", "workspaceID", runtime.ID, "error", err)
		return "", 0
	}
	req.Header.Set("Authorization", "Bearer "+resp.Token)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	httpResp, err := s.controlPlaneHTTPClient(0).Do(req)
	if err != nil {
		slog.Warn("GitLab MR create failed", "workspaceID", runtime.ID, "error", err)
		return "", 0
	}
	defer httpResp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(httpResp.Body, 8*1024))
	if httpResp.StatusCode < 200 || httpResp.StatusCode >= 300 {
		if httpResp.StatusCode == http.StatusConflict {
			if existingURL, existingIID := s.getExistingGitLabMergeRequest(ctx, runtime, host, repositoryPath, sourceBranch, targetBranch, resp.Token); existingURL != "" {
				return existingURL, existingIID
			}
		}
		slog.Warn("GitLab MR create returned non-success", "workspaceID", runtime.ID, "status", httpResp.StatusCode, "body", redactTaskCallbackDiagnosticText(strings.TrimSpace(string(body))))
		return "", 0
	}
	var payload gitlabMergeRequestResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		slog.Warn("GitLab MR create response decode failed", "workspaceID", runtime.ID, "error", err)
		return "", 0
	}
	return payload.WebURL, payload.IID
}

func (s *Server) getExistingGitLabMergeRequest(ctx context.Context, runtime *WorkspaceRuntime, host, repositoryPath, sourceBranch, targetBranch, token string) (string, int) {
	params := url.Values{}
	params.Set("state", "opened")
	params.Set("source_branch", sourceBranch)
	params.Set("target_branch", targetBranch)
	params.Set("per_page", "1")
	endpoint := fmt.Sprintf(
		"https://%s/api/v4/projects/%s/merge_requests?%s",
		host,
		url.PathEscape(repositoryPath),
		params.Encode(),
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		slog.Warn("GitLab MR lookup request build failed", "workspaceID", runtime.ID, "error", err)
		return "", 0
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")

	httpResp, err := s.controlPlaneHTTPClient(0).Do(req)
	if err != nil {
		slog.Warn("GitLab MR lookup failed", "workspaceID", runtime.ID, "error", err)
		return "", 0
	}
	defer httpResp.Body.Close()
	if httpResp.StatusCode < 200 || httpResp.StatusCode >= 300 {
		slog.Warn("GitLab MR lookup returned non-success", "workspaceID", runtime.ID, "status", httpResp.StatusCode)
		return "", 0
	}
	body, _ := io.ReadAll(io.LimitReader(httpResp.Body, 8*1024))
	var payload []gitlabMergeRequestResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		slog.Warn("GitLab MR lookup response decode failed", "workspaceID", runtime.ID, "error", err)
		return "", 0
	}
	if len(payload) == 0 {
		return "", 0
	}
	return payload[0].WebURL, payload[0].IID
}

// tryCreatePR attempts to create a GitHub PR using gh CLI inside the container.
// Returns (prURL, prNumber) on success, or ("", 0) on failure.
func (s *Server) tryCreatePR(containerID, workDir, user string) (string, int) {
	timeout := s.config.GitExecTimeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	stdout, stderr, err := s.execInContainer(ctx, containerID, user, workDir,
		"gh", "pr", "create",
		"--fill",
		"--head", "HEAD",
	)
	outputStr := strings.TrimSpace(stdout)
	if strings.TrimSpace(stderr) != "" {
		outputStr = strings.TrimSpace(outputStr + "\n" + strings.TrimSpace(stderr))
	}
	if err != nil {
		// Check if a PR already exists
		if strings.Contains(outputStr, "already exists") {
			slog.Info("PR already exists for this branch", "output", outputStr)
			// Try to get the existing PR URL
			return s.getExistingPRURL(containerID, workDir, user)
		}
		slog.Warn("gh pr create failed (non-fatal)", "error", err, "output", outputStr)
		return "", 0
	}

	// gh pr create outputs the PR URL on success
	prURL := outputStr
	if !strings.HasPrefix(prURL, "https://") {
		// Try to extract URL from output
		for _, line := range strings.Split(outputStr, "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "https://") {
				prURL = strings.TrimSpace(line)
				break
			}
		}
	}

	slog.Info("PR created", "url", prURL)
	return prURL, 0
}

// getExistingPRURL looks up the existing PR URL for the current branch.
func (s *Server) getExistingPRURL(containerID, workDir, user string) (string, int) {
	timeout := s.config.GitExecTimeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	output, _, err := s.execInContainer(ctx, containerID, user, workDir,
		"gh", "pr", "view", "--json", "url,number", "--jq", ".url",
	)
	if err != nil {
		return "", 0
	}
	return strings.TrimSpace(output), 0
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
