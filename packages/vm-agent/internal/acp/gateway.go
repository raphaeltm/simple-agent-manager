package acp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const localShellPath = "/bin/sh"

// BootLogReporter sends structured log entries to the control plane.
// It must be non-nil and have a valid token for logging to work.
type BootLogReporter interface {
	Log(step, status, message string, detail ...string)
}

// ErrorReporter sends structured error entries to CF Workers observability.
// All methods must be nil-safe.
type ErrorReporter interface {
	ReportError(err error, source, workspaceID string, ctx map[string]interface{})
	ReportInfo(message, source, workspaceID string, ctx map[string]interface{})
	ReportWarn(message, source, workspaceID string, ctx map[string]interface{})
}

// EventAppender appends structured events to the workspace event log.
// This allows the gateway to emit events visible in the UI event log
// without depending on the server package directly.
type EventAppender interface {
	AppendEvent(workspaceID, level, eventType, message string, detail map[string]interface{})
}

// SessionUpdater persists ACP session IDs for reconnection with LoadSession.
type SessionUpdater interface {
	// UpdateAcpSessionID updates the ACP session ID and agent type for a session.
	UpdateAcpSessionID(workspaceID, sessionID, acpSessionID, agentType string) error
}

// TabSessionUpdater persists ACP session IDs to the SQLite persistence store.
type TabSessionUpdater interface {
	// UpdateTabAcpSessionID updates the ACP session ID for a tab.
	UpdateTabAcpSessionID(tabID, acpSessionID string) error
}

// TabLastPromptUpdater persists the last user prompt for session discoverability.
type TabLastPromptUpdater interface {
	// UpdateTabLastPrompt updates the last user message for a tab.
	UpdateTabLastPrompt(tabID, lastPrompt string) error
}

// SessionLastPromptUpdater persists the last user prompt in the in-memory session manager.
type SessionLastPromptUpdater interface {
	// UpdateLastPrompt stores the last user message for a session.
	UpdateLastPrompt(workspaceID, sessionID, lastPrompt string) error
}

// CredentialSyncer syncs updated credentials back to the control plane.
// This is used for agents with file-based credential injection (e.g. codex-acp
// auth.json) where the agent may refresh tokens during a session.
type CredentialSyncer interface {
	// SyncCredential sends updated credential content back to the control plane.
	// agentType identifies the agent (e.g. "openai-codex").
	// credentialKind is "api-key" or "oauth-token".
	// credential is the raw credential content (e.g. auth.json body).
	SyncCredential(ctx context.Context, workspaceID, agentType, credentialKind, credential string) error
}

// MessageReporter enqueues chat messages for batched delivery to the control plane.
// All methods must be nil-safe (a nil reporter is a no-op).
type MessageReporter interface {
	// Enqueue adds a message to the outbox for eventual HTTP delivery.
	Enqueue(msg MessageReportEntry) error
}

// MessageReportEntry is the data needed to enqueue a chat message.
// It mirrors messagereport.Message but lives in the acp package to avoid
// circular imports.
type MessageReportEntry struct {
	MessageID    string
	SessionID    string
	Role         string
	Content      string
	ToolMetadata string
	Timestamp    string
	Origin       string
}

// GatewayConfig holds configuration for the ACP gateway and SessionHost.
type GatewayConfig struct {
	// InitTimeoutMs is the fallback ACP initialization timeout in milliseconds.
	// Used when per-phase timeouts below are not set (0).
	InitTimeoutMs int
	// InitializeTimeoutMs is the timeout for the Initialize RPC in milliseconds.
	// When 0, falls back to InitTimeoutMs.
	InitializeTimeoutMs int
	// NewSessionTimeoutMs is the timeout for the NewSession RPC in milliseconds.
	// When 0, falls back to InitTimeoutMs.
	NewSessionTimeoutMs int
	// LoadSessionTimeoutMs is the timeout for the LoadSession RPC in milliseconds.
	// When 0, falls back to InitTimeoutMs.
	LoadSessionTimeoutMs int
	// MaxRestartAttempts is the maximum number of restart attempts on crash.
	MaxRestartAttempts int
	// ControlPlaneURL is the URL for fetching agent API keys.
	ControlPlaneURL string
	// ProjectID is the project that owns this workspace (used for activity reporting).
	ProjectID string
	// NodeID is the node running this workspace (used for activity reporting).
	NodeID string
	// WorkspaceID is the current workspace identifier.
	WorkspaceID string
	// SessionID is the agent session identifier (used for persistence).
	SessionID string
	// CallbackToken is the JWT for authenticating with the control plane.
	CallbackToken string
	// ContainerResolver returns the devcontainer's Docker container ID.
	ContainerResolver func() (string, error)
	// ContainerUser is the user to run as inside the container.
	ContainerUser string
	// ContainerWorkDir is the working directory inside the container.
	ContainerWorkDir string
	// ProcessLauncher starts ACP subprocesses. Nil uses Docker exec, preserving
	// the traditional VM/devcontainer path.
	ProcessLauncher ProcessLauncher
	// GitTokenFetcher returns a fresh GitHub installation token for the
	// workspace. It is called at ACP session start to inject GH_TOKEN into
	// the agent process. If nil or returns error, GH_TOKEN is omitted.
	GitTokenFetcher func(ctx context.Context) (string, error)
	// BootLog is the reporter for sending structured logs to the control plane.
	// Agent errors (stderr, crashes) are reported here for observability.
	BootLog BootLogReporter
	// PreviousAcpSessionID is the ACP session ID from a previous connection.
	// When set, the SessionHost will attempt LoadSession instead of NewSession
	// to restore conversation context on reconnection.
	PreviousAcpSessionID string
	// PreviousAgentType is the agent type from the previous connection.
	// Used together with PreviousAcpSessionID to decide whether LoadSession
	// should be attempted (only if the same agent type is being reconnected).
	PreviousAgentType string
	// SessionManager persists ACP session IDs for reconnection.
	SessionManager SessionUpdater
	// TabStore persists ACP session IDs to the SQLite store.
	TabStore TabSessionUpdater
	// FileExecTimeout is the timeout for file read/write operations via docker exec.
	FileExecTimeout time.Duration
	// FileMaxSize is the maximum file size in bytes for read operations.
	FileMaxSize int
	// ErrorReporter sends structured error entries to CF Workers observability.
	// Agent errors (crashes, install failures, prompt failures) are reported here.
	ErrorReporter ErrorReporter
	// EventAppender appends events to the workspace event log (visible in UI).
	EventAppender EventAppender
	// PingInterval is the WebSocket ping interval. Zero uses DefaultPingInterval.
	PingInterval time.Duration
	// PongTimeout is the pong deadline after sending a ping. Zero uses DefaultPongTimeout.
	PongTimeout time.Duration
	// PromptTimeout bounds how long a prompt can run before force-stop fallback.
	PromptTimeout time.Duration
	// PromptCancelGracePeriod waits after cancel before force-stopping unresponsive prompt.
	PromptCancelGracePeriod time.Duration
	// PromptRetryMaxRetries bounds transient provider prompt retries after the initial attempt.
	PromptRetryMaxRetries int
	// PromptRetryInitialDelay is the first backoff before retrying a transient provider prompt error.
	PromptRetryInitialDelay time.Duration
	// PromptRetryMaxDelay caps exponential backoff for transient provider prompt retries.
	PromptRetryMaxDelay time.Duration
	// PromptRetrySleeper is injectable for tests. Nil uses time.Sleep with context cancellation.
	PromptRetrySleeper func(context.Context, time.Duration) error
	// ActivityRereportInterval refreshes prompt activity while a prompt is active.
	// Zero disables the periodic re-report loop.
	ActivityRereportInterval time.Duration
	// TerminalActivityReportAttempts is the retry budget for terminal/error
	// activity reports. Zero uses the legacy cheap retry policy.
	TerminalActivityReportAttempts int
	// TerminalActivityReportBackoff is the delay between terminal/error retries.
	TerminalActivityReportBackoff time.Duration
	// RecoveryWatchdogTimeout bounds crash recovery after a prompt disconnect.
	// Zero uses DefaultRecoveryWatchdogTimeout.
	RecoveryWatchdogTimeout time.Duration
	// RestartDecayWindow resets restartCount after this quiet period. Zero uses
	// DefaultRestartDecayWindow.
	RestartDecayWindow time.Duration
	// TabLastPromptStore persists the last user prompt to SQLite for session discoverability.
	TabLastPromptStore TabLastPromptUpdater
	// SessionLastPromptManager persists the last user prompt in the in-memory session manager.
	SessionLastPromptManager SessionLastPromptUpdater
	// IdleSuspendTimeout is how long a session can be idle with no viewers before
	// being automatically suspended. Zero disables auto-suspend.
	IdleSuspendTimeout time.Duration
	// OnSuspend is called when auto-suspend triggers. The server uses this to
	// update the agent session status and remove the SessionHost from the map.
	OnSuspend func(workspaceID, sessionID string)
	// MessageReporter enqueues chat messages for batched delivery to the
	// control plane. When nil, message persistence is a no-op.
	MessageReporter MessageReporter
	// OnPromptComplete is called after a prompt finishes (success or failure).
	// Used by task-driven workspaces to report completion back to the control plane.
	// When nil, no callback fires. The string arg is the stop reason (e.g. "end_turn", "error").
	OnPromptComplete func(stopReason string, promptErr error)
	// SAMEnvFallback provides fallback SAM environment variables (KEY=value pairs)
	// injected into ACP sessions when the bootstrap-written /etc/sam/env file is
	// missing or incomplete. Built from the vm-agent's own config at startup.
	SAMEnvFallback []string
	// CredentialSyncer syncs updated file-based credentials (e.g. auth.json)
	// back to the control plane after a session ends. When nil, no sync occurs.
	CredentialSyncer CredentialSyncer
	// McpServers are MCP server configs to inject into ACP sessions.
	// When non-empty, these are converted to acpsdk.McpServer entries
	// and passed in NewSession/LoadSession requests.
	McpServers []McpServerEntry
	// ModelOverride, if non-empty, overrides the model fetched from user agent settings.
	// Set by the control plane when an agent profile specifies a model.
	ModelOverride string
	// PermissionModeOverride, if non-empty, overrides the permission mode fetched from
	// user agent settings. Set by the control plane when an agent profile specifies a permission mode.
	PermissionModeOverride string
	// EffortOverride, if non-empty, overrides the reasoning effort fetched from user agent settings.
	// Values are provider-neutral: "auto", "low", "medium", "high", "xhigh", "max".
	EffortOverride string
	// OpencodeProviderOverride, if non-empty, overrides the OpenCode inference provider.
	// Values: "opencode-zen", "opencode-go", "custom".
	OpencodeProviderOverride string
	// OpencodeBaseURLOverride, if non-empty, overrides the OpenCode base URL
	// (used for the "custom" provider).
	OpencodeBaseURLOverride string
	// HTTPClient is the HTTP client used for outbound control-plane calls
	// (credential fetches, settings fetches). Must have an explicit timeout.
	HTTPClient *http.Client
}

// McpServerEntry is a lightweight MCP server config passed from the control
// plane for injection into ACP sessions. It represents an HTTP MCP server
// with bearer token authentication.
type McpServerEntry struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

// Gateway is a thin per-WebSocket relay between a browser and a SessionHost.
// It reads messages from the WebSocket and routes them to the SessionHost.
// It does NOT own the agent process — that responsibility belongs to SessionHost.
//
// When the WebSocket closes, the Gateway detaches from the SessionHost but
// does NOT stop the agent. The agent continues running until explicitly stopped.
type Gateway struct {
	host     *SessionHost
	viewerID string
	conn     *websocket.Conn
	// viewerDone is closed when the viewer's write pump exits (write failure).
	// The read loop selects on this to exit immediately instead of waiting for
	// the read deadline (40s) to expire.
	viewerDone <-chan struct{}

	mu     sync.Mutex
	closed bool
}

// NewGateway creates a new Gateway that relays WebSocket messages to a SessionHost.
func NewGateway(host *SessionHost, conn *websocket.Conn, viewerID string, viewerDone <-chan struct{}) *Gateway {
	return &Gateway{
		host:       host,
		viewerID:   viewerID,
		conn:       conn,
		viewerDone: viewerDone,
	}
}

// Close terminates the gateway by closing the underlying WebSocket connection.
// This causes Run() to return. The agent process is NOT stopped.
func (g *Gateway) Close() {
	g.mu.Lock()
	g.closed = true
	g.mu.Unlock()

	g.conn.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseGoingAway, "connection closed"),
		time.Now().Add(5*time.Second),
	)
	g.conn.Close()
}

// DefaultPingInterval is the default interval between WebSocket pings to detect stale connections.
// Override via ACP_PING_INTERVAL env var.
const DefaultPingInterval = 30 * time.Second

// DefaultPongTimeout is the default deadline for receiving a pong after sending a ping.
// Override via ACP_PONG_TIMEOUT env var.
const DefaultPongTimeout = 10 * time.Second

// Run reads WebSocket messages and routes them to the SessionHost.
// It blocks until the WebSocket closes or the context is cancelled.
// When it returns, the caller should call SessionHost.DetachViewer().
func (g *Gateway) Run(ctx context.Context) error {
	// Resolve ping/pong intervals from host config, falling back to defaults.
	pi := g.host.config.PingInterval
	if pi <= 0 {
		pi = DefaultPingInterval
	}
	pt := g.host.config.PongTimeout
	if pt <= 0 {
		pt = DefaultPongTimeout
	}

	// Configure pong handler to extend the read deadline when pong is received.
	g.conn.SetReadDeadline(time.Now().Add(pi + pt))
	g.conn.SetPongHandler(func(string) error {
		g.conn.SetReadDeadline(time.Now().Add(pi + pt))
		return nil
	})

	// Start ping ticker to detect stale connections
	pingTicker := time.NewTicker(pi)
	defer pingTicker.Stop()

	// Run ping sender in background
	go func() {
		for range pingTicker.C {
			g.mu.Lock()
			closed := g.closed
			g.mu.Unlock()
			if closed {
				return
			}
			// Write ping directly on the connection — viewer write pump handles
			// data messages, but control frames are safe to write concurrently.
			err := g.conn.WriteControl(
				websocket.PingMessage,
				nil,
				time.Now().Add(5*time.Second),
			)
			if err != nil {
				return
			}
		}
	}()

	// Read WebSocket messages and route to SessionHost.
	// We use a goroutine for reading because ReadMessage() is blocking and
	// we need to also select on viewerDone (write pump failure) and ctx.Done().
	type readResult struct {
		msgType int
		data    []byte
		err     error
	}
	readCh := make(chan readResult, 1)

	go func() {
		for {
			msgType, data, err := g.conn.ReadMessage()
			readCh <- readResult{msgType, data, err}
			if err != nil {
				return
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-g.viewerDone:
			// Write pump died — connection is broken, exit immediately
			return fmt.Errorf("viewer write pump closed")
		case msg := <-readCh:
			if msg.err != nil {
				g.mu.Lock()
				wasClosed := g.closed
				g.mu.Unlock()
				if wasClosed || websocket.IsCloseError(msg.err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
					return nil
				}
				return fmt.Errorf("WebSocket read error: %w", msg.err)
			}

			// Reset read deadline on any message
			g.conn.SetReadDeadline(time.Now().Add(pi + pt))

			if msg.msgType != websocket.TextMessage {
				continue
			}

			g.handleMessage(ctx, msg.data)
		}
	}
}

// handleMessage parses a WebSocket message and routes it to the SessionHost.
func (g *Gateway) handleMessage(ctx context.Context, data []byte) {
	// Check for control messages (select_agent, ping)
	var control struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &control); err == nil {
		switch ControlMessageType(control.Type) {
		case MsgSelectAgent:
			var selectMsg SelectAgentMessage
			if err := json.Unmarshal(data, &selectMsg); err == nil {
				go g.host.SelectAgent(ctx, selectMsg.AgentType)
			}
			return
		case MsgPing:
			// Application-level keepalive: respond with pong via the viewer's
			// send channel so the message flows through the same write path as
			// all other data. This works through any proxy (Cloudflare, etc.)
			// because it is a regular data frame, not a WebSocket control frame.
			g.host.SendPongToViewer(g.viewerID)
			return
		}
	}

	// Parse as JSON-RPC
	var rpcMsg struct {
		JSONRPC string          `json:"jsonrpc"`
		Method  string          `json:"method"`
		ID      json.RawMessage `json:"id,omitempty"`
		Params  json.RawMessage `json:"params,omitempty"`
	}
	if err := json.Unmarshal(data, &rpcMsg); err != nil {
		slog.Warn("Failed to parse WebSocket message", "error", err)
		return
	}

	switch rpcMsg.Method {
	case "session/prompt":
		go g.host.HandlePrompt(ctx, rpcMsg.ID, rpcMsg.Params, g.viewerID, false)
	case "session/cancel":
		// Cancel the in-flight prompt context. Also forward to agent stdin
		// so the agent process itself can react to the cancellation signal.
		if g.host.AgentType() == "opencode" {
			g.host.cancelPrompt(false)
			g.host.StopProcessForPromptCancel()
		} else {
			g.host.CancelPrompt()
			// Construct a well-formed cancel message with sessionId rather than
			// forwarding raw browser data which may omit required params.
			cancelMessage, err := g.host.cancelNotification()
			if err != nil {
				slog.Warn("Gateway: could not build session/cancel notification", "error", err)
				return
			}
			g.host.ForwardToAgent(cancelMessage)
		}
	default:
		g.host.ForwardToAgent(data)
	}
}

// --- Shared types and utilities used by both Gateway and SessionHost ---

// agentCredential holds the credential and its type returned from the control plane.
type agentCredential struct {
	credential     string
	credentialKind string // "api-key" or "oauth-token"
	// AI proxy fields (set for claude-code/openai-codex when the AI proxy is
	// enabled and the user has no dedicated agent key). OpenCode is always
	// bring-your-own-key and never uses these.
	inferenceConfig *inferenceConfig
}

// inferenceConfig holds platform AI proxy configuration returned by the control plane
// when the user has no dedicated agent credential and the AI proxy is enabled.
type inferenceConfig struct {
	Provider     string `json:"provider"`     // e.g. "openai-compatible"
	BaseURL      string `json:"baseURL"`      // e.g. "https://api.example.com/ai/v1"
	Model        string `json:"model"`        // e.g. "@cf/qwen/qwen3-30b-a3b-fp8"
	APIKeySource string `json:"apiKeySource"` // "callback-token" means use workspace callback token and replace {wstoken}
}

func byteReader(data []byte) io.ReadCloser {
	return io.NopCloser(bytes.NewReader(data))
}

// agentSettingsPayload holds per-user, per-agent settings from the control plane.
type agentSettingsPayload struct {
	Model            string `json:"model"`
	PermissionMode   string `json:"permissionMode"`
	Effort           string `json:"effort"`
	OpencodeProvider string `json:"opencodeProvider"`
	OpencodeBaseURL  string `json:"opencodeBaseUrl"`
}

// truncate limits a string to maxLen characters, appending "..." if truncated.
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

// applyLineLimit applies Line and Limit parameters to file content for partial reads.
// Line is 1-based. Returns the selected portion of content.
func applyLineLimit(content string, line *int, limit *int) string {
	if line == nil && limit == nil {
		return content
	}
	lines := strings.Split(content, "\n")
	startLine := 0
	if line != nil && *line > 1 {
		startLine = *line - 1
		if startLine >= len(lines) {
			return ""
		}
		lines = lines[startLine:]
	}
	if limit != nil && *limit > 0 && *limit < len(lines) {
		lines = lines[:*limit]
	}
	return strings.Join(lines, "\n")
}

// execInContainer runs a command inside a devcontainer and returns stdout.
// Uses docker exec with optional user flag.
func execInContainer(ctx context.Context, containerID, user, workDir string, args ...string) (stdout string, stderr string, err error) {
	dockerArgs := []string{"exec", "-i"}
	if user != "" {
		dockerArgs = append(dockerArgs, "-u", user)
	}
	if workDir != "" {
		dockerArgs = append(dockerArgs, "-w", workDir)
	}
	dockerArgs = append(dockerArgs, containerID)
	dockerArgs = append(dockerArgs, args...)

	cmd := exec.CommandContext(ctx, "docker", dockerArgs...)

	var stdoutBuf, stderrBuf bytes.Buffer
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf

	if err := cmd.Run(); err != nil {
		return "", strings.TrimSpace(stderrBuf.String()), fmt.Errorf("command failed: %w", err)
	}

	return stdoutBuf.String(), strings.TrimSpace(stderrBuf.String()), nil
}

// writeAuthFileToContainer writes credential content to a file inside a container.
// It creates the parent directory with 0700 permissions and the file with 0600.
// authFilePath is relative to the user's home directory (e.g. ".codex/auth.json").
// Content is streamed via stdin to avoid exposing secrets in process args or env.
func validateAuthFilePath(authFilePath string) error {
	// Prevent shell injection in the sh -c scripts used by the read/write helpers.
	if strings.ContainsAny(authFilePath, ";\"`'$\\") || strings.Contains(authFilePath, "..") {
		return fmt.Errorf("invalid authFilePath: %q", authFilePath)
	}
	return nil
}

func resolveContainerHomeDir(ctx context.Context, containerID, user string) (string, error) {
	// Method 1: Try getent passwd (most reliable in standard containers)
	username, stderr, err := execInContainer(ctx, containerID, user, "", "id", "-un")
	if err != nil {
		if stderr != "" {
			slog.Debug("Failed to get username for home dir resolution", "stderr", stderr)
		}
	} else {
		username = strings.TrimSpace(username)
		passwdEntry, stderr, err := execInContainer(
			ctx,
			containerID,
			user,
			"",
			"getent",
			"passwd",
			username,
		)
		if err == nil {
			fields := strings.Split(strings.TrimSpace(passwdEntry), ":")
			if len(fields) >= 6 && fields[5] != "" {
				slog.Debug("Resolved home directory via getent", "path", fields[5])
				return fields[5], nil
			}
		} else if stderr != "" {
			slog.Debug("getent failed while resolving home directory", "stderr", stderr)
		}
	}

	// Method 2: Try HOME environment variable
	home, stderr, err := execInContainer(ctx, containerID, user, "", "printenv", "HOME")
	if err == nil {
		trimmedHome := strings.TrimSpace(home)
		if trimmedHome != "" {
			slog.Debug("Resolved home directory via HOME environment variable", "path", trimmedHome)
			return trimmedHome, nil
		}
	} else if stderr != "" {
		slog.Debug("Failed to get HOME environment variable", "stderr", stderr)
	}

	// Method 3: Fallback to /root for minimal containers
	// This handles edge cases where neither getent nor HOME work
	slog.Warn("Failed to resolve container home directory via getent and HOME env, falling back to /root",
		"container", containerID,
		"user", user)
	return "/root", nil
}

// resolveAuthFileTargetPath resolves the absolute target path for a relative
// auth/config file inside a container. When the relative path starts with
// ".codex/" and the container has CODEX_HOME set, the file is placed under
// $CODEX_HOME instead of $HOME — this matches where the Codex CLI actually
// looks for its configuration.
func resolveAuthFileTargetPath(ctx context.Context, containerID, user, authFilePath string) (string, error) {
	// Check for CODEX_HOME override when the path targets the .codex directory.
	if strings.HasPrefix(authFilePath, ".codex/") || authFilePath == ".codex" {
		codexHome, _, err := execInContainer(ctx, containerID, user, "", "printenv", "CODEX_HOME")
		if err == nil {
			trimmed := strings.TrimSpace(codexHome)
			if trimmed != "" {
				// authFilePath is e.g. ".codex/auth.json" — strip the ".codex/" prefix
				// and join with CODEX_HOME to get the absolute path.
				rel := strings.TrimPrefix(authFilePath, ".codex/")
				if rel == ".codex" {
					rel = ""
				}
				target := path.Join(trimmed, rel)
				slog.Debug("Resolved auth file path via CODEX_HOME",
					"codexHome", trimmed,
					"authFilePath", authFilePath,
					"targetPath", target)
				return target, nil
			}
		}
	}

	// Default: resolve relative to the user's home directory.
	homeDir, err := resolveContainerHomeDir(ctx, containerID, user)
	if err != nil {
		slog.Warn("resolveContainerHomeDir returned error, falling back to /root",
			"error", err,
			"container", containerID,
			"user", user)
		homeDir = "/root"
	}
	return path.Join(homeDir, authFilePath), nil
}

func writeAuthFileToContainer(ctx context.Context, containerID, user, authFilePath, content string) error {
	if err := validateAuthFilePath(authFilePath); err != nil {
		return err
	}

	targetPath, err := resolveAuthFileTargetPath(ctx, containerID, user, authFilePath)
	if err != nil {
		return fmt.Errorf("resolve auth file target path: %w", err)
	}
	parentDir := path.Dir(targetPath)

	if _, stderr, err := execInContainer(ctx, containerID, user, "", "mkdir", "-p", parentDir); err != nil {
		if stderr != "" {
			return fmt.Errorf("create auth file parent dir: %w: %s", err, stderr)
		}
		return fmt.Errorf("create auth file parent dir: %w", err)
	}
	if _, stderr, err := execInContainer(ctx, containerID, user, "", "chmod", "700", parentDir); err != nil {
		if stderr != "" {
			return fmt.Errorf("chmod auth file parent dir: %w: %s", err, stderr)
		}
		return fmt.Errorf("chmod auth file parent dir: %w", err)
	}

	dockerArgs := []string{"exec", "-i"}
	if user != "" {
		dockerArgs = append(dockerArgs, "-u", user)
	}
	dockerArgs = append(dockerArgs, containerID, "tee", targetPath)

	cmd := exec.CommandContext(ctx, "docker", dockerArgs...)
	cmd.Stdin = strings.NewReader(content)
	cmd.Stdout = io.Discard

	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("write auth file content: %w: %s", err, strings.TrimSpace(stderr.String()))
	}

	if _, stderrText, err := execInContainer(ctx, containerID, user, "", "chmod", "600", targetPath); err != nil {
		if stderrText != "" {
			return fmt.Errorf("chmod auth file: %w: %s", err, stderrText)
		}
		return fmt.Errorf("chmod auth file: %w", err)
	}
	return nil
}

// readAuthFileFromContainer reads credential content from a file inside a container.
// authFilePath is relative to the user's home directory (e.g. ".codex/auth.json").
// Returns the file content, or an error if the file cannot be read.
// Output is capped at 1 MB to prevent memory exhaustion from unexpected content.
func readAuthFileFromContainer(ctx context.Context, containerID, user, authFilePath string) (string, error) {
	if err := validateAuthFilePath(authFilePath); err != nil {
		return "", err
	}

	targetPath, err := resolveAuthFileTargetPath(ctx, containerID, user, authFilePath)
	if err != nil {
		return "", fmt.Errorf("resolve auth file target path: %w", err)
	}

	dockerArgs := []string{"exec"}
	if user != "" {
		dockerArgs = append(dockerArgs, "-u", user)
	}
	dockerArgs = append(dockerArgs, containerID, "cat", targetPath)

	cmd := exec.CommandContext(ctx, "docker", dockerArgs...)

	// Cap output at 1 MB to guard against unexpectedly large files.
	const maxCredentialSize = 1 << 20 // 1 MB
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", fmt.Errorf("docker exec stdout pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("docker exec start failed: %w", err)
	}
	var buf bytes.Buffer
	if _, err := io.Copy(&buf, io.LimitReader(stdout, maxCredentialSize)); err != nil {
		_ = cmd.Wait()
		return "", fmt.Errorf("docker exec read failed: %w", err)
	}
	if err := cmd.Wait(); err != nil {
		return "", fmt.Errorf("docker exec failed: %w", err)
	}
	return buf.String(), nil
}

// agentInstallMu serializes concurrent agent binary installs to prevent
// npm ENOTEMPTY errors when two SelectAgent calls race.
var agentInstallMu sync.Mutex

// installAgentBinary checks if the agent command exists in the given container
// and installs it via the provided installCmd if missing. The install runs as
// root to ensure permissions for system-level package installs. Returns nil if
// the binary was already present or was installed successfully.
//
// A package-level mutex serializes installs so that concurrent SelectAgent
// calls do not race on npm global installs (which causes ENOTEMPTY errors).
// The fast-path `which` check runs without the mutex; only the slow install
// path acquires it, with a double-check after acquisition.
func installAgentBinary(ctx context.Context, containerID string, info agentCommandInfo) error {
	// Fast path: check without mutex — avoids contention when already installed.
	checkArgs := []string{"exec", containerID, "which", info.command}
	checkCmd := exec.CommandContext(ctx, "docker", checkArgs...)
	if err := checkCmd.Run(); err == nil {
		slog.Info("Agent binary is already installed", "command", info.command)
		return nil
	}

	// Slow path: acquire mutex to serialize installs.
	agentInstallMu.Lock()
	defer agentInstallMu.Unlock()

	// Bail out if context was cancelled while waiting for the mutex.
	if ctx.Err() != nil {
		return ctx.Err()
	}

	// Double-check after acquiring mutex — another goroutine may have installed it.
	recheckCmd := exec.CommandContext(ctx, "docker", checkArgs...)
	if err := recheckCmd.Run(); err == nil {
		slog.Info("Agent binary was installed by another goroutine", "command", info.command)
		return nil
	}

	slog.Info("Agent binary not found in container, installing", "command", info.command)

	// For npm-based installs, clean up stale partial install directories left
	// by previous failed npm installs. npm renames the target directory to a temp
	// name (with random suffix) during install; if the install fails, these
	// directories can block subsequent installs with ENOTEMPTY.
	if info.isNpmBased {
		cleanupScript := fmt.Sprintf(
			`rm -rf /usr/local/lib/node_modules/.%s-* /usr/local/lib/node_modules/*/.%s-* /usr/local/share/nvm/versions/node/*/lib/node_modules/.%s-* /usr/local/share/nvm/versions/node/*/lib/node_modules/*/.%s-* 2>/dev/null; true`,
			info.command, info.command, info.command, info.command,
		)
		cleanupArgs := []string{"exec", "-u", "root", containerID, "sh", "-c", cleanupScript}
		cleanupCmd := exec.CommandContext(ctx, "docker", cleanupArgs...)
		_ = cleanupCmd.Run() // best-effort cleanup
	}

	// For npm-based agents, ensure npm is available before running the install.
	// Non-npm agents (e.g., pip-based) handle their own prerequisites in installCmd.
	installScript := agentInstallScript(info)

	installArgs := []string{"exec", "-u", "root", containerID, "sh", "-c", installScript}
	installCmd := exec.CommandContext(ctx, "docker", installArgs...)
	output, err := installCmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("install command failed: %w: %s", err, strings.TrimSpace(string(output)))
	}

	slog.Info("Agent binary installed successfully", "command", info.command)
	return nil
}

// installAgentBinaryLocal installs the ACP adapter binary in the LOCAL process
// namespace (standalone / cf-container mode), mirroring installAgentBinary but
// without docker exec. In standalone mode the vm-agent runs INSIDE the container,
// so agents are installed and spawned in the same filesystem/PID namespace and
// resolved via the vm-agent's own $PATH (see startLocalProcess). The install
// script is the same hardcoded literal from getAgentCommandInfo — never derived
// from external input.
func installAgentBinaryLocal(ctx context.Context, info agentCommandInfo) error {
	// Fast path: check without mutex. exec.LookPath matches how startLocalProcess
	// resolves the command, so this is the correct "already installed" check.
	if _, err := exec.LookPath(info.command); err == nil {
		slog.Info("Agent binary is already installed (local)", "command", info.command)
		return nil
	}

	// Slow path: acquire mutex to serialize installs (shared with docker path).
	agentInstallMu.Lock()
	defer agentInstallMu.Unlock()

	// Bail out if context was cancelled while waiting for the mutex.
	if ctx.Err() != nil {
		return ctx.Err()
	}

	// Double-check after acquiring mutex — another goroutine may have installed it.
	if _, err := exec.LookPath(info.command); err == nil {
		slog.Info("Agent binary was installed by another goroutine (local)", "command", info.command)
		return nil
	}

	slog.Info("Agent binary not found locally, installing", "command", info.command)

	// For npm-based installs, clean up stale partial install directories left
	// by previous failed npm installs (same rationale as the docker path).
	if info.isNpmBased {
		cleanupScript := fmt.Sprintf(
			`rm -rf /usr/local/lib/node_modules/.%s-* /usr/local/lib/node_modules/*/.%s-* /usr/local/share/nvm/versions/node/*/lib/node_modules/.%s-* /usr/local/share/nvm/versions/node/*/lib/node_modules/*/.%s-* 2>/dev/null; true`,
			info.command, info.command, info.command, info.command,
		)
		cleanupCmd := exec.CommandContext(ctx, localShellPath, "-c", cleanupScript)
		_ = cleanupCmd.Run() // best-effort cleanup
	}

	installScript := agentInstallScript(info)
	installCmd := exec.CommandContext(ctx, localShellPath, "-c", installScript)
	output, err := installCmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("local install command failed: %w: %s", err, strings.TrimSpace(string(output)))
	}

	slog.Info("Agent binary installed successfully (local)", "command", info.command)
	return nil
}

func agentInstallScript(info agentCommandInfo) string {
	if !info.isNpmBased {
		return info.installCmd
	}
	return fmt.Sprintf(
		`node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"; { which npm >/dev/null 2>&1 && [ "$node_major" -ge 20 ]; } || { rm -f /etc/apt/sources.list.d/github-cli.list /etc/apt/keyrings/githubcli-archive-keyring.gpg; apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs npm && npm install -g n && n 22 && hash -r; }; %s`,
		info.installCmd,
	)
}

// agentCommandInfo holds the command, args, env var, and install command for an agent.
// SECURITY: installCmd is passed to sh -c inside the container. It must always be a
// hardcoded literal from getAgentCommandInfo — never derived from external input.
type agentCommandInfo struct {
	command       string
	args          []string
	envVarName    string
	installCmd    string // shell command to run if binary is missing (npm, pip, etc.)
	isNpmBased    bool   // true for agents installed via npm; controls prerequisite injection and cleanup
	injectionMode string // "env" (default) or "auth-file" — how the credential is injected
	authFilePath  string // relative to home dir, e.g. ".codex/auth.json" (only when injectionMode == "auth-file")
}

const codexACPInstallCommand = "npm install -g @agentclientprotocol/codex-acp@1.1.2"

// getAgentCommandInfo returns the ACP command, args, env var name, and install command for a given agent type.
// These match the agent catalog defined in packages/shared/src/agents.ts.
// The credentialKind parameter determines which environment variable to use for Claude Code.
func getAgentCommandInfo(agentType string, credentialKind string) agentCommandInfo {
	switch agentType {
	case "claude-code":
		if credentialKind == "oauth-token" {
			return agentCommandInfo{"claude-agent-acp", nil, "CLAUDE_CODE_OAUTH_TOKEN", "npm install -g @agentclientprotocol/claude-agent-acp@0.58.1", true, "", ""}
		}
		return agentCommandInfo{"claude-agent-acp", nil, "ANTHROPIC_API_KEY", "npm install -g @agentclientprotocol/claude-agent-acp@0.58.1", true, "", ""}
	case "openai-codex":
		// Use -c to override sandbox_mode via codex-acp's config override flag.
		// This takes the highest priority in the Codex config hierarchy,
		// overriding both project and user config.toml files. Required because
		// SAM workspaces run inside containers without CAP_NET_ADMIN, which
		// causes bubblewrap (bwrap) sandbox to fail with
		// "RTM_NEWADDR: Operation not permitted".
		// NOTE: --sandbox is a flag on the `codex` CLI, NOT on `codex-acp`.
		// codex-acp uses -c key=value for config overrides.
		codexSandboxArgs := []string{"-c", `sandbox_mode="danger-full-access"`}
		if credentialKind == "oauth-token" {
			return agentCommandInfo{
				command:       "codex-acp",
				args:          codexSandboxArgs,
				envVarName:    "",
				installCmd:    codexACPInstallCommand,
				isNpmBased:    true,
				injectionMode: "auth-file",
				authFilePath:  ".codex/auth.json",
			}
		}
		return agentCommandInfo{"codex-acp", codexSandboxArgs, "OPENAI_API_KEY", codexACPInstallCommand, true, "", ""}
	case "google-gemini":
		return agentCommandInfo{"gemini", []string{"--acp"}, "GEMINI_API_KEY", "npm install -g @google/gemini-cli@0.50.0", true, "", ""}
	case "mistral-vibe":
		return agentCommandInfo{"vibe-acp", nil, "MISTRAL_API_KEY", `curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh && UV_TOOL_DIR=/opt/uv-tools UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_TOOL_BIN_DIR=/usr/local/bin uv tool install mistral-vibe==2.19.1 --python 3.12 --quiet`, false, "", ""}
	case "opencode":
		return agentCommandInfo{
			command:       "opencode",
			args:          []string{"acp"},
			envVarName:    "OPENCODE_API_KEY",
			installCmd:    "npm install -g opencode-ai@1.17.18",
			isNpmBased:    true,
			injectionMode: "",
			authFilePath:  "",
		}
	case "amp":
		return agentCommandInfo{
			command:    "acp-amp",
			args:       []string{"run"},
			envVarName: "AMP_API_KEY",
			installCmd: `curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh && UV_TOOL_DIR=/opt/uv-tools UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_TOOL_BIN_DIR=/usr/local/bin uv tool install acp-amp==0.1.3 --with agent-client-protocol==0.7.1 --with amp-sdk==0.1.2 --with pydantic==2.12.5 --with pydantic-core==2.41.5 --with annotated-types==0.7.0 --with typing-inspection==0.4.2 --with typing-extensions==4.15.0 --python 3.12 --quiet && npm install -g @ampcode/cli@0.0.1783785389-g0da70d && UV_PYTHON_INSTALL_DIR=/opt/uv-python uv run --python 3.12 python -c "
PYTHON_SDK_PATH = "/opt/uv-tools/acp-amp/lib/python3.12/site-packages/acp_amp/driver/python_sdk.py"
AMP_TYPES_PATH = "/opt/uv-tools/acp-amp/lib/python3.12/site-packages/amp_sdk/types.py"

# Patch 1: acp-amp error handling — include ProcessError.stderr in error messages
with open(PYTHON_SDK_PATH, encoding="utf-8") as handle:
    t = handle.read()
t = t.replace('\"message\": str(exc)', '\"message\": str(exc) + (" stderr: " + exc.stderr if hasattr(exc, "stderr") and exc.stderr else "")')

# Patch 2: acp-amp MCP config — wrap raw dict in MCPConfig to fix pydantic Union
# validation silently producing empty servers when dict keys are server names.
# Also handle env:None which causes MCPServer validation to reject the entry.
old_mcp = '''        if mcp_config:
            base["mcp_config"] = mcp_config
            base["mcpConfig"] = mcp_config'''
new_mcp = '''        if mcp_config:
            from amp_sdk.types import MCPConfig
            cleaned = {}
            for _n, _c in mcp_config.items():
                if isinstance(_c, dict):
                    _cc = dict(_c)
                    if _cc.get("env") is None:
                        _cc["env"] = {}
                    cleaned[_n] = _cc
                else:
                    cleaned[_n] = _c
            _wrapped = MCPConfig(servers=cleaned)
            base["mcp_config"] = _wrapped
            base["mcpConfig"] = _wrapped'''
t = t.replace(old_mcp, new_mcp)
with open(PYTHON_SDK_PATH, "w", encoding="utf-8") as handle:
    handle.write(t)
print('Patched acp-amp: error handling + MCP config wrapping')

# Patch 3: amp_sdk visibility default — change from workspace to private
with open(AMP_TYPES_PATH, encoding="utf-8") as handle:
    vt = handle.read()
vt = vt.replace('visibility: Optional[Literal["private", "public", "workspace", "group"]] = "workspace"', 'visibility: Optional[Literal["private", "public", "workspace", "group"]] = "private"')
with open(AMP_TYPES_PATH, "w", encoding="utf-8") as handle:
    handle.write(vt)
print('Patched amp_sdk: visibility default to private')
"`,
			// isNpmBased must be true because installCmd chains `npm install -g @ampcode/cli@0.0.1783785389-g0da70d`
			// after the uv install. The Node.js bootstrap preamble ensures npm is available
			// inside devcontainers that don't ship with Node.js pre-installed.
			isNpmBased:    true,
			injectionMode: "",
			authFilePath:  "",
		}
	default:
		return agentCommandInfo{agentType, nil, "API_KEY", "", false, "", ""}
	}
}

// getModelEnvVar returns the environment variable name used to set the model
// for a given agent type. Returns empty string if no model env var is known.
func getModelEnvVar(agentType string) string {
	switch agentType {
	case "claude-code":
		return "ANTHROPIC_MODEL"
	case "openai-codex":
		return "OPENAI_MODEL"
	case "google-gemini":
		return "GEMINI_MODEL"
	case "mistral-vibe":
		// NOTE: startAgent handles mistral-vibe specially — it writes a
		// ~/.vibe/config.toml and sets VIBE_ACTIVE_MODEL unconditionally,
		// bypassing the generic getModelEnvVar path. This entry is retained
		// for completeness and potential external callers.
		return "VIBE_ACTIVE_MODEL"
	case "opencode":
		// Model is set via OPENCODE_CONFIG_CONTENT env var, not a standalone model env var.
		return ""
	default:
		return ""
	}
}

// getAgentExtraEnvVars returns additional environment variables required by
// specific agent types. These are always injected regardless of user settings.
func getAgentExtraEnvVars(agentType string) []string {
	switch agentType {
	case "mistral-vibe":
		// vibe-acp v2.4.2 sends empty client_name and client_version in API
		// request metadata when running in ACP (headless) mode. Mistral's API
		// validates that metadata values are non-empty, rejecting all requests.
		// Inject these via VIBE_-prefixed env vars to work around the upstream bug.
		return []string{
			"VIBE_CLIENT_NAME=sam",
			"VIBE_CLIENT_VERSION=1.0.1",
			"PYTHONUNBUFFERED=1",
		}
	case "amp":
		// AMP_DEBUG makes amp_sdk print the full CLI command to stderr (core.py),
		// which monitorStderr captures. PYTHONUNBUFFERED ensures immediate output.
		return []string{
			"AMP_DEBUG=1",
			"PYTHONUNBUFFERED=1",
		}
	default:
		return nil
	}
}

// tomlEscapeBasicString escapes a string for use inside a TOML basic string
// (double-quoted). Backslashes must be escaped first, then double quotes.
func tomlEscapeBasicString(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return s
}

const (
	codexManagedMcpStartMarker = "# BEGIN SAM MANAGED MCP"
	codexManagedMcpEndMarker   = "# END SAM MANAGED MCP"
	codexProxyProviderID       = "sam-openai"
	codexProxyProviderEnvKey   = "OPENAI_API_KEY"
)

type codexProxyProviderConfig struct {
	baseURL string
	model   string
}

func codexMcpServerName(index, total int) string {
	if total <= 1 {
		return "sam-mcp"
	}
	return fmt.Sprintf("sam-mcp-%d", index)
}

func codexMcpTokenEnvVar(index, total int) string {
	if total <= 1 {
		return "SAM_MCP_TOKEN"
	}
	return fmt.Sprintf("SAM_MCP_TOKEN_%d", index)
}

func removeManagedCodexMcpBlock(existing string) string {
	for {
		start := strings.Index(existing, codexManagedMcpStartMarker)
		if start == -1 {
			return existing
		}
		endRel := strings.Index(existing[start:], codexManagedMcpEndMarker)
		if endRel == -1 {
			return existing[:start]
		}
		end := start + endRel + len(codexManagedMcpEndMarker)
		if end < len(existing) && existing[end] == '\n' {
			end++
		}
		existing = existing[:start] + existing[end:]
	}
}

func mergeManagedCodexMcpConfig(existing, managed string) string {
	cleaned := strings.TrimRight(removeManagedCodexMcpBlock(existing), "\n")
	managed = strings.TrimSpace(managed)

	switch {
	case cleaned == "" && managed == "":
		return ""
	case cleaned == "":
		return managed + "\n"
	case managed == "":
		return cleaned + "\n"
	default:
		return cleaned + "\n\n" + managed + "\n"
	}
}

func codexProxyProviderConfigFromCredential(cred *agentCredential, callbackToken string) *codexProxyProviderConfig {
	if cred == nil || cred.inferenceConfig == nil {
		return nil
	}
	// Auth-file credentials (OAuth tokens) use auth.json injection, not env-var-based
	// proxy providers. Generating a proxy provider config here would produce a
	// config.toml entry with env_key = "OPENAI_API_KEY" that is never set,
	// causing Codex to crash immediately.
	if cred.credentialKind == "oauth-token" {
		return nil
	}
	if cred.inferenceConfig.Provider != "openai-proxy" && cred.inferenceConfig.Provider != "openai-passthrough" {
		return nil
	}
	baseURL := strings.ReplaceAll(cred.inferenceConfig.BaseURL, "{wstoken}", callbackToken)
	if baseURL == "" || strings.ContainsAny(baseURL, "\n\r") {
		return nil
	}
	model := cred.inferenceConfig.Model
	if strings.ContainsAny(model, "\n\r") {
		model = ""
	}
	return &codexProxyProviderConfig{baseURL: baseURL, model: model}
}

func generateCodexProxyProviderConfig(config *codexProxyProviderConfig) string {
	if config == nil {
		return ""
	}

	var b strings.Builder
	b.WriteString("# SAM-managed Codex provider for proxy-backed sessions.\n")
	if config.model != "" {
		b.WriteString(fmt.Sprintf("model = \"%s\"\n", tomlEscapeBasicString(config.model)))
	}
	b.WriteString(fmt.Sprintf("model_provider = \"%s\"\n\n", codexProxyProviderID))
	b.WriteString(fmt.Sprintf("[model_providers.%s]\n", codexProxyProviderID))
	b.WriteString("name = \"SAM OpenAI Proxy\"\n")
	b.WriteString(fmt.Sprintf("base_url = \"%s\"\n", tomlEscapeBasicString(config.baseURL)))
	b.WriteString(fmt.Sprintf("env_key = \"%s\"\n", codexProxyProviderEnvKey))
	b.WriteString("wire_api = \"responses\"\n\n")
	return b.String()
}

func normalizeAgentEffort(effort string) string {
	trimmed := strings.TrimSpace(effort)
	switch trimmed {
	case "low", "medium", "high", "xhigh", "max":
		return trimmed
	default:
		return ""
	}
}

func normalizeCodexEffort(effort string) string {
	trimmed := strings.TrimSpace(effort)
	switch trimmed {
	case "low", "medium", "high", "xhigh":
		return trimmed
	default:
		return ""
	}
}

// generateCodexMcpConfig produces a managed TOML block for Codex MCP server
// configuration plus the environment variables referenced by
// bearer_token_env_var. Codex natively supports streamable HTTP MCP servers
// via ~/.codex/config.toml.
func generateCodexMcpConfig(mcpServers []McpServerEntry, proxyProvider *codexProxyProviderConfig, effort string) (string, []string) {
	providerConfig := generateCodexProxyProviderConfig(proxyProvider)
	codexEffort := normalizeCodexEffort(effort)
	if len(mcpServers) == 0 && providerConfig == "" && codexEffort == "" {
		return "", nil
	}

	validServers := make([]McpServerEntry, 0, len(mcpServers))
	for i, server := range mcpServers {
		if strings.ContainsAny(server.URL, "\n\r") || strings.ContainsAny(server.Token, "\n\r") {
			slog.Warn("Skipping Codex MCP server with control characters in URL or token",
				"index", i, "url_length", len(server.URL))
			continue
		}
		validServers = append(validServers, server)
	}
	if len(validServers) == 0 && providerConfig == "" && codexEffort == "" {
		return "", nil
	}

	var config strings.Builder
	envVars := make([]string, 0, len(validServers))

	config.WriteString(codexManagedMcpStartMarker)
	config.WriteString("\n# Added by SAM vm-agent for Codex ACP sessions.\n")
	config.WriteString("sandbox_mode = \"danger-full-access\"\n")
	config.WriteString("approval_policy = \"never\"\n")
	if codexEffort != "" {
		config.WriteString(fmt.Sprintf("model_reasoning_effort = \"%s\"\n", codexEffort))
	}
	config.WriteString(providerConfig)

	for i, server := range validServers {
		name := codexMcpServerName(i, len(validServers))
		config.WriteString(fmt.Sprintf("[mcp_servers.%s]\n", name))
		config.WriteString(fmt.Sprintf("url = \"%s\"\n", tomlEscapeBasicString(server.URL)))
		if server.Token != "" {
			tokenEnvVar := codexMcpTokenEnvVar(i, len(validServers))
			config.WriteString(fmt.Sprintf("bearer_token_env_var = \"%s\"\n", tokenEnvVar))
			envVars = append(envVars, fmt.Sprintf("%s=%s", tokenEnvVar, server.Token))
		}
		config.WriteString("\n")
	}

	config.WriteString(codexManagedMcpEndMarker)
	config.WriteString("\n")
	return config.String(), envVars
}

// vibeDefaultActiveModel is the model alias used when no user model override
// is configured. Defaults to Mistral Large (their most capable model).
// Override at deployment via VIBE_DEFAULT_ACTIVE_MODEL env var.
var vibeDefaultActiveModel = func() string {
	if v := os.Getenv("VIBE_DEFAULT_ACTIVE_MODEL"); v != "" {
		return v
	}
	return "mistral-large"
}()

// sanitizeVibeModelAlias validates and sanitizes a model alias string to
// prevent TOML injection. Aliases must be alphanumeric with hyphens only.
// Returns the sanitized alias, or the default if the input is invalid.
func sanitizeVibeModelAlias(alias string) string {
	if alias == "" {
		return vibeDefaultActiveModel
	}
	for _, c := range alias {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.') {
			slog.Warn("Invalid Vibe model alias, falling back to default",
				"requested", alias, "default", vibeDefaultActiveModel)
			return vibeDefaultActiveModel
		}
	}
	return alias
}

// vibeBuiltinAliases lists the aliases that are always defined in the
// generated config. If the user selects one of these, no extra entry is needed.
var vibeBuiltinAliases = map[string]bool{
	"mistral-large": true,
	"devstral-2":    true,
	"codestral":     true,
}

// generateVibeConfig produces a TOML config for ~/.vibe/config.toml that
// defines model aliases so users can select models beyond the built-in
// defaults. The activeModel parameter sets which alias is active.
// If activeModel doesn't match a built-in alias, a dynamic [[models]] entry
// is generated using the value as both the alias and the Mistral API model name.
// This allows the UI model catalog to use raw Mistral API IDs without needing
// vm-agent changes when new models are released.
// If mcpServers is provided, it includes MCP server configurations for tool discovery.
func generateVibeConfig(activeModel string, mcpServers []McpServerEntry) string {
	activeModel = sanitizeVibeModelAlias(activeModel)

	config := fmt.Sprintf(`# Generated by SAM vm-agent — do not edit manually.
# This config defines model aliases and MCP servers for Mistral Vibe ACP sessions.

active_model = "%s"

# Mistral Large — most capable model
[[models]]
name = "mistral-large-latest"
provider = "mistral"
alias = "mistral-large"
temperature = 0.2

# Devstral 2 — default coding model
[[models]]
name = "mistral-vibe-cli-latest"
provider = "mistral"
alias = "devstral-2"
temperature = 0.2

# Codestral — code-specialized model
[[models]]
name = "codestral-latest"
provider = "mistral"
alias = "codestral"
temperature = 0.2
`, activeModel)

	// If the active model isn't a built-in alias, generate a dynamic entry
	// using the model ID as both alias and API name. This lets the UI catalog
	// list raw Mistral API model IDs (e.g. "mistral-medium-3-5-2604") without
	// requiring vm-agent updates for each new model.
	if activeModel != vibeDefaultActiveModel && !vibeBuiltinAliases[activeModel] {
		config += fmt.Sprintf(`
# Dynamic model entry (from SAM user settings)
[[models]]
name = "%s"
provider = "mistral"
alias = "%s"
temperature = 0.2
`, activeModel, activeModel)
	}

	// Append MCP server configurations if provided
	for i, server := range mcpServers {
		// Skip entries with control characters that would corrupt TOML
		if strings.ContainsAny(server.URL, "\n\r") || strings.ContainsAny(server.Token, "\n\r") {
			slog.Warn("Skipping MCP server with control characters in URL or token",
				"index", i, "url_length", len(server.URL))
			continue
		}
		safeURL := tomlEscapeBasicString(server.URL)
		config += fmt.Sprintf("\n[[mcp_servers]]\nname = \"sam-mcp-%d\"\ntransport = \"http\"\nurl = \"%s\"\n", i, safeURL)
		if server.Token != "" {
			safeToken := tomlEscapeBasicString(server.Token)
			config += fmt.Sprintf("headers = { Authorization = \"Bearer %s\" }\n", safeToken)
		}
	}

	return config
}

// resolveVibeActiveModel determines which model alias to use for a Mistral
// Vibe session. Returns the user's model override if set, otherwise the
// platform default (Mistral Large).
func resolveVibeActiveModel(settings *agentSettingsPayload) string {
	if settings != nil && settings.Model != "" {
		return settings.Model
	}
	return vibeDefaultActiveModel
}

// Default values for OpenCode provider configuration.
// Each has an env-var override so operators can change them without rebuilding the binary.
const (
	DefaultOpencodeProvider          = "opencode-zen"
	DefaultOpencodeModel             = "opencode/claude-sonnet-4-6"
	DefaultOpencodeGoModel           = "opencode-go/glm-5.2"
	DefaultCompatibleFallbackBaseURL = "http://localhost:11434/v1"
)

// stripCFPrefix removes the "@cf/" prefix from Workers AI model IDs.
// OpenCode's model resolver treats "@cf/" as a provider prefix, causing
// ProviderModelNotFoundError. The AI proxy re-adds @cf/ server-side.
func stripCFPrefix(model string) string {
	return strings.TrimPrefix(model, "@cf/")
}

func getOpencodeDefault(envKey, fallback string) string {
	if v := os.Getenv(envKey); v != "" {
		return v
	}
	return fallback
}

func normalizeOpencodeProvider(provider string) string {
	switch provider {
	case "opencode-zen", "opencode-go", "custom":
		return provider
	default:
		return DefaultOpencodeProvider
	}
}

func resolveOpencodeDefaultModel(provider string) string {
	switch provider {
	case "opencode-go":
		return getOpencodeDefault("OPENCODE_GO_DEFAULT_MODEL", DefaultOpencodeGoModel)
	default:
		return getOpencodeDefault("OPENCODE_DEFAULT_MODEL", DefaultOpencodeModel)
	}
}

func resolveOpencodeModel(provider string, settings *agentSettingsPayload) string {
	if settings != nil && settings.Model != "" {
		return settings.Model
	}
	return resolveOpencodeDefaultModel(provider)
}

// buildOpencodeConfig creates the OPENCODE_CONFIG_CONTENT JSON structure
// based on the provider selected in agent settings.
//
// OpenCode requires custom (non-built-in) providers to include:
//   - "npm": the AI SDK package name (e.g. "@ai-sdk/openai-compatible")
//   - "models": a map registering model aliases so OpenCode recognises them
//   - model field: formatted as "providerID/modelAlias"
//
// Built-in providers (OpenCode Zen, OpenCode Go) have pre-registered models
// reached purely by model namespace and need only OPENCODE_API_KEY — no
// provider block. Only "custom" (bring-your-own OpenAI-compatible endpoint)
// needs the npm/models keys plus a baseURL.
func buildOpencodeConfig(settings *agentSettingsPayload) map[string]interface{} {
	provider := DefaultOpencodeProvider

	if settings != nil && settings.OpencodeProvider != "" {
		provider = settings.OpencodeProvider
	}
	provider = normalizeOpencodeProvider(provider)
	model := resolveOpencodeModel(provider, settings)

	slog.Debug("buildOpencodeConfig: input",
		"provider", provider,
		"rawModel", model)

	// Strip @cf/ prefix from Workers AI model IDs for custom providers.
	model = stripCFPrefix(model)

	slog.Debug("buildOpencodeConfig: after stripCFPrefix",
		"model", model,
		"provider", provider)

	config := map[string]interface{}{}

	switch provider {
	case "opencode-zen", "opencode-go":
		config["model"] = model
	case "custom":
		baseURL := getOpencodeDefault("OPENCODE_COMPATIBLE_DEFAULT_BASE_URL", DefaultCompatibleFallbackBaseURL)
		if settings != nil && settings.OpencodeBaseURL != "" {
			baseURL = settings.OpencodeBaseURL
		}
		modelAlias := sanitizeModelAlias(model)
		config["model"] = "custom/" + modelAlias
		config["provider"] = map[string]interface{}{
			"custom": map[string]interface{}{
				"npm":  "@ai-sdk/openai-compatible",
				"name": "Custom Provider",
				"options": map[string]interface{}{
					"baseURL": baseURL,
					"apiKey":  "{env:OPENCODE_API_KEY}",
				},
				"models": map[string]interface{}{
					modelAlias: map[string]interface{}{
						"name": model,
					},
				},
			},
		}
	default:
		// Unknown provider — fail closed to the Zen default (model-only config).
		config["model"] = model
	}

	return config
}

// opencodeProviderNeedsNpmPackage returns the npm package name that a given
// OpenCode provider requires, or "" if the provider is built-in.
// OpenCode uses Bun to auto-install npm packages for custom providers, but
// our containers only have Node.js/npm. Without pre-installation, the provider
// silently fails and OpenCode returns end_turn with no content.
func opencodeProviderNeedsNpmPackage(provider string) string {
	switch provider {
	case "custom":
		return "@ai-sdk/openai-compatible"
	default:
		return ""
	}
}

// preInstallOpencodeProviderDeps installs the npm package required by a custom
// OpenCode provider into ~/.cache/opencode/node_modules/ — the exact location
// where OpenCode resolves provider packages at runtime.
//
// OpenCode embeds Bun and uses it internally for provider package loading.
// Pre-installing via npm is sufficient — the node_modules structure is compatible
// with Bun's module resolver. Without pre-installation, OpenCode's embedded Bun
// would auto-install the package, but this can fail in network-restricted environments.
func preInstallOpencodeProviderDeps(ctx context.Context, containerID, user, npmPackage string) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}

	homeDir, err := resolveContainerHomeDir(ctx, containerID, user)
	if err != nil {
		homeDir = "/root"
	}
	cacheDir := path.Join(homeDir, ".cache", "opencode")

	// Create the cache directory structure that OpenCode expects
	if _, _, err := execInContainer(ctx, containerID, user, "", "mkdir", "-p", cacheDir); err != nil {
		return fmt.Errorf("create opencode cache dir: %w", err)
	}

	// Install the package into the cache directory so OpenCode finds it
	// at ~/.cache/opencode/node_modules/@ai-sdk/openai-compatible.
	// Use --no-save to avoid writing package.json/package-lock.json that
	// could conflict with OpenCode's own package management.
	slog.Info("Pre-installing OpenCode provider dependency",
		"package", npmPackage,
		"cacheDir", cacheDir,
		"container", containerID)
	stdout, stderr, err := execInContainer(ctx, containerID, user, cacheDir, "npm", "install", "--no-save", npmPackage)
	if err != nil {
		return fmt.Errorf("npm install %s in cache dir: %w: %s", npmPackage, err, stderr)
	}
	slog.Info("Pre-installed OpenCode provider dependency",
		"package", npmPackage,
		"cacheDir", cacheDir,
		"container", containerID,
		"stdoutLen", len(stdout),
		"stderrLen", len(stderr))
	return nil
}

// sanitizeModelAlias creates a clean model alias from a full model ID.
// Strips provider prefixes (e.g. "meta/llama-4" → "llama-4") and replaces
// characters that could break JSON or OpenCode's provider/model split.
func sanitizeModelAlias(model string) string {
	// If model has a provider prefix like "meta/llama-4-scout", take the last segment.
	// The provider prefix conflicts with OpenCode's "providerID/modelAlias" format.
	if idx := strings.LastIndex(model, "/"); idx >= 0 {
		model = model[idx+1:]
	}
	return model
}

// writeVibeConfigToContainer writes a .vibe/config.toml into the container
// for the Mistral Vibe agent. This is necessary because VIBE_ACTIVE_MODEL
// expects a config alias (not a raw API model name), and only "devstral-2"
// is defined by default. If mcpServers is provided, it includes MCP server
// configurations for tool discovery.
func writeVibeConfigToContainer(ctx context.Context, containerID, user, activeModel string, mcpServers []McpServerEntry) error {
	config := generateVibeConfig(activeModel, mcpServers)
	return writeAuthFileToContainer(ctx, containerID, user, ".vibe/config.toml", config)
}

// readOptionalFileFromContainer reads a file inside a container if it exists,
// returning an empty string when the file is absent.
func readOptionalFileFromContainer(ctx context.Context, containerID, user, filePath string) (string, error) {
	if strings.ContainsAny(filePath, ";\"`'$\\") || strings.Contains(filePath, "..") {
		return "", fmt.Errorf("invalid filePath: %q", filePath)
	}

	targetPath, err := resolveAuthFileTargetPath(ctx, containerID, user, filePath)
	if err != nil {
		return "", fmt.Errorf("resolve file target path: %w", err)
	}

	// Check if file exists first
	dockerArgs := []string{"exec"}
	if user != "" {
		dockerArgs = append(dockerArgs, "-u", user)
	}
	dockerArgs = append(dockerArgs, containerID, "test", "-f", targetPath)

	cmd := exec.CommandContext(ctx, "docker", dockerArgs...)
	if err := cmd.Run(); err != nil {
		// File doesn't exist, return empty string
		return "", nil
	}

	// File exists, read its content
	dockerArgs = dockerArgs[:len(dockerArgs)-3] // Remove "test", "-f", targetPath
	dockerArgs = append(dockerArgs, "cat", targetPath)

	cmd = exec.CommandContext(ctx, "docker", dockerArgs...)
	const maxFileSize = 1 << 20 // 1 MB
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", fmt.Errorf("docker exec stdout pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("docker exec start failed: %w", err)
	}
	var buf bytes.Buffer
	if _, err := io.Copy(&buf, io.LimitReader(stdout, maxFileSize)); err != nil {
		_ = cmd.Wait()
		return "", fmt.Errorf("docker exec read failed: %w", err)
	}
	if err := cmd.Wait(); err != nil {
		return "", fmt.Errorf("docker exec failed: %w", err)
	}
	return buf.String(), nil
}

// writeCodexConfigToContainer updates ~/.codex/config.toml with a SAM-managed
// MCP block. Existing non-SAM config is preserved, and prior SAM-managed blocks
// are replaced so resumed or restarted sessions do not accumulate stale tokens.
func writeCodexConfigToContainer(ctx context.Context, containerID, user string, mcpServers []McpServerEntry, proxyProvider *codexProxyProviderConfig, effort string) ([]string, error) {
	managedConfig, envVars := generateCodexMcpConfig(mcpServers, proxyProvider, effort)
	existingConfig, err := readOptionalFileFromContainer(ctx, containerID, user, ".codex/config.toml")
	if err != nil {
		return nil, err
	}
	mergedConfig := mergeManagedCodexMcpConfig(existingConfig, managedConfig)
	if mergedConfig == "" {
		return nil, nil
	}
	if err := writeAuthFileToContainer(ctx, containerID, user, ".codex/config.toml", mergedConfig); err != nil {
		return nil, err
	}
	return envVars, nil
}
