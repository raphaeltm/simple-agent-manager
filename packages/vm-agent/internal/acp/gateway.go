package acp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

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
}

// GatewayConfig holds configuration for the ACP gateway and SessionHost.
type GatewayConfig struct {
	// InitTimeoutMs is the ACP initialization timeout in milliseconds.
	InitTimeoutMs int
	// MaxRestartAttempts is the maximum number of restart attempts on crash.
	MaxRestartAttempts int
	// ControlPlaneURL is the URL for fetching agent API keys.
	ControlPlaneURL string
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
		go g.host.HandlePrompt(ctx, rpcMsg.ID, rpcMsg.Params, g.viewerID)
	case "session/cancel":
		// Cancel the in-flight prompt context. Also forward to agent stdin
		// so the agent process itself can react to the cancellation signal.
		g.host.CancelPrompt()
		g.host.ForwardToAgent(data)
	default:
		g.host.ForwardToAgent(data)
	}
}

// --- Shared types and utilities used by both Gateway and SessionHost ---

// agentCredential holds the credential and its type returned from the control plane.
type agentCredential struct {
	credential     string
	credentialKind string // "api-key" or "oauth-token"
}

func byteReader(data []byte) io.ReadCloser {
	return io.NopCloser(bytes.NewReader(data))
}

// agentSettingsPayload holds per-user, per-agent settings from the control plane.
type agentSettingsPayload struct {
	Model          string `json:"model"`
	PermissionMode string `json:"permissionMode"`
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
func writeAuthFileToContainer(ctx context.Context, containerID, user, authFilePath, content string) error {
	// Shell script reads credential from stdin via cat, avoiding any env/arg exposure.
	// 1. Resolves the user's home directory reliably (docker exec -u does NOT update $HOME)
	// 2. Creates the parent directory with restricted permissions
	// 3. Reads stdin into the target file with restricted permissions
	//
	// NOTE: $HOME in docker exec -u is unreliable — it inherits the container's env
	// (often /root even when running as a non-root user). We resolve the home directory
	// from /etc/passwd via getent, falling back to $HOME if getent is unavailable.
	script := fmt.Sprintf(
		`set -e; home=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6) || home="$HOME"; dir="$home/%s"; mkdir -p "$(dirname "$dir")" && chmod 700 "$(dirname "$dir")"; cat > "$dir" && chmod 600 "$dir"`,
		authFilePath,
	)

	dockerArgs := []string{"exec", "-i"}
	if user != "" {
		dockerArgs = append(dockerArgs, "-u", user)
	}
	dockerArgs = append(dockerArgs, containerID, "sh", "-c", script)

	cmd := exec.CommandContext(ctx, "docker", dockerArgs...)
	cmd.Stdin = strings.NewReader(content)

	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker exec failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

// readAuthFileFromContainer reads credential content from a file inside a container.
// authFilePath is relative to the user's home directory (e.g. ".codex/auth.json").
// Returns the file content, or an error if the file cannot be read.
// Output is capped at 1 MB to prevent memory exhaustion from unexpected content.
func readAuthFileFromContainer(ctx context.Context, containerID, user, authFilePath string) (string, error) {
	// Validate authFilePath to prevent shell injection. Currently always a
	// hardcoded constant, but we defend in depth against future misuse.
	if strings.ContainsAny(authFilePath, ";\"`'$\\") || strings.Contains(authFilePath, "..") {
		return "", fmt.Errorf("invalid authFilePath: %q", authFilePath)
	}

	// Same home directory resolution as writeAuthFileToContainer.
	script := fmt.Sprintf(
		`set -e; home=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6) || home="$HOME"; cat "$home/%s"`,
		authFilePath,
	)

	// -i not needed: no stdin, stdout captured via cmd.Output().
	dockerArgs := []string{"exec"}
	if user != "" {
		dockerArgs = append(dockerArgs, "-u", user)
	}
	dockerArgs = append(dockerArgs, containerID, "sh", "-c", script)

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
			`rm -rf /usr/local/lib/node_modules/@zed-industries/.%s-* /usr/local/share/nvm/versions/node/*/lib/node_modules/@zed-industries/.%s-* 2>/dev/null; true`,
			info.command, info.command,
		)
		cleanupArgs := []string{"exec", "-u", "root", containerID, "sh", "-c", cleanupScript}
		cleanupCmd := exec.CommandContext(ctx, "docker", cleanupArgs...)
		_ = cleanupCmd.Run() // best-effort cleanup
	}

	// For npm-based agents, ensure npm is available before running the install.
	// Non-npm agents (e.g., pip-based) handle their own prerequisites in installCmd.
	var installScript string
	if info.isNpmBased {
		installScript = fmt.Sprintf(
			`which npm >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq nodejs npm; }; %s`,
			info.installCmd,
		)
	} else {
		installScript = info.installCmd
	}

	installArgs := []string{"exec", "-u", "root", containerID, "sh", "-c", installScript}
	installCmd := exec.CommandContext(ctx, "docker", installArgs...)
	output, err := installCmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("install command failed: %w: %s", err, strings.TrimSpace(string(output)))
	}

	slog.Info("Agent binary installed successfully", "command", info.command)
	return nil
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

// getAgentCommandInfo returns the ACP command, args, env var name, and install command for a given agent type.
// These match the agent catalog defined in packages/shared/src/agents.ts.
// The credentialKind parameter determines which environment variable to use for Claude Code.
func getAgentCommandInfo(agentType string, credentialKind string) agentCommandInfo {
	switch agentType {
	case "claude-code":
		if credentialKind == "oauth-token" {
			return agentCommandInfo{"claude-agent-acp", nil, "CLAUDE_CODE_OAUTH_TOKEN", "npm install -g @zed-industries/claude-agent-acp", true, "", ""}
		}
		return agentCommandInfo{"claude-agent-acp", nil, "ANTHROPIC_API_KEY", "npm install -g @zed-industries/claude-agent-acp", true, "", ""}
	case "openai-codex":
		if credentialKind == "oauth-token" {
			return agentCommandInfo{
				command:    "codex-acp",
				args:       nil,
				envVarName: "",
				installCmd: "npm install -g @zed-industries/codex-acp",
				isNpmBased: true,
				injectionMode: "auth-file",
				authFilePath:  ".codex/auth.json",
			}
		}
		return agentCommandInfo{"codex-acp", nil, "OPENAI_API_KEY", "npm install -g @zed-industries/codex-acp", true, "", ""}
	case "google-gemini":
		return agentCommandInfo{"gemini", []string{"--experimental-acp"}, "GEMINI_API_KEY", "npm install -g @google/gemini-cli", true, "", ""}
	case "mistral-vibe":
		return agentCommandInfo{"vibe-acp", nil, "MISTRAL_API_KEY", `which pip3 >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq python3-pip; }; pip3 install --break-system-packages mistral-vibe`, false, "", ""}
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
		return "VIBE_ACTIVE_MODEL"
	default:
		return ""
	}
}
