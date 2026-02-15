package acp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
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

// GatewayConfig holds configuration for the ACP gateway.
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
	// OnActivity is called when there's ACP activity (for idle detection).
	OnActivity func()
	// BootLog is the reporter for sending structured logs to the control plane.
	// Agent errors (stderr, crashes) are reported here for observability.
	BootLog BootLogReporter
	// PreviousAcpSessionID is the ACP session ID from a previous connection.
	// When set, the gateway will attempt LoadSession instead of NewSession
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
}

// Gateway bridges a gorilla/websocket connection to an ACP agent subprocess.
// It handles agent selection, process lifecycle, and bidirectional message forwarding.
type Gateway struct {
	config  GatewayConfig
	conn    *websocket.Conn
	writeMu sync.Mutex

	// Current agent state
	mu           sync.Mutex
	process      *AgentProcess
	acpConn      *acpsdk.ClientSideConnection
	agentType    string
	sessionID    acpsdk.SessionId
	restartCount int
	// permissionMode stores the user's chosen permission behavior for the agent.
	// Possible values: "default", "acceptEdits", "bypassPermissions"
	permissionMode string

	// closed is set when Close() is called to signal a takeover
	closed bool

	// stderrBuf collects recent stderr output from the agent process for error reporting.
	stderrMu  sync.Mutex
	stderrBuf strings.Builder
}

// NewGateway creates a new ACP gateway for WebSocket-to-agent bridging.
func NewGateway(config GatewayConfig, conn *websocket.Conn) *Gateway {
	return &Gateway{
		config: config,
		conn:   conn,
	}
}

// Close terminates the gateway by closing the underlying WebSocket connection.
// This causes Run() to return, cleaning up the agent process. It is safe to
// call from any goroutine and is used by the takeover pattern when a new
// ACP connection replaces an existing one.
func (g *Gateway) Close() {
	g.mu.Lock()
	g.closed = true
	g.mu.Unlock()

	// Send a close frame and close the connection. This unblocks ReadMessage()
	// in Run(), causing the gateway to shut down cleanly.
	g.conn.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseGoingAway, "session takeover"),
		time.Now().Add(5*time.Second),
	)
	g.conn.Close()
}

// pingInterval is the interval between WebSocket pings to detect stale connections.
const pingInterval = 30 * time.Second

// pongTimeout is the deadline for receiving a pong after sending a ping.
const pongTimeout = 10 * time.Second

// Run starts the gateway, bridging WebSocket messages to/from the agent subprocess.
func (g *Gateway) Run(ctx context.Context) error {
	defer g.cleanup()

	// Configure pong handler to extend the read deadline when pong is received.
	g.conn.SetReadDeadline(time.Now().Add(pingInterval + pongTimeout))
	g.conn.SetPongHandler(func(string) error {
		g.conn.SetReadDeadline(time.Now().Add(pingInterval + pongTimeout))
		return nil
	})

	// Start ping ticker to detect stale connections
	pingTicker := time.NewTicker(pingInterval)
	defer pingTicker.Stop()

	// Run ping sender in background
	go func() {
		for range pingTicker.C {
			g.writeMu.Lock()
			err := g.conn.WriteControl(
				websocket.PingMessage,
				nil,
				time.Now().Add(5*time.Second),
			)
			g.writeMu.Unlock()
			if err != nil {
				return // Connection is dead, Run() will detect via ReadMessage error
			}
		}
	}()

	// Start WebSocket reader
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		msgType, data, err := g.conn.ReadMessage()
		if err != nil {
			g.mu.Lock()
			wasClosed := g.closed
			g.mu.Unlock()
			if wasClosed || websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				g.reportLifecycle("info", "Gateway WebSocket closed normally", map[string]interface{}{
					"wasTakeover": wasClosed,
				})
				return nil
			}
			g.reportLifecycle("warn", "Gateway WebSocket read error (connection lost)", map[string]interface{}{
				"error": err.Error(),
			})
			return fmt.Errorf("failed to read WebSocket message: %w", err)
		}

		// Reset read deadline on any message
		g.conn.SetReadDeadline(time.Now().Add(pingInterval + pongTimeout))

		if msgType != websocket.TextMessage {
			continue
		}

		// Check for control messages
		if err := g.handleControlMessage(ctx, data); err != nil {
			log.Printf("Error handling control message: %v", err)
		}
	}
}

// handleControlMessage processes control plane messages (agent selection)
// and routes ACP JSON-RPC messages through the SDK.
func (g *Gateway) handleControlMessage(ctx context.Context, data []byte) error {
	// Check for our custom control messages first
	var control SelectAgentMessage
	if err := json.Unmarshal(data, &control); err == nil {
		if control.Type == MsgSelectAgent {
			g.handleSelectAgent(ctx, control.AgentType)
			return nil
		}
	}

	// Parse as JSON-RPC to route ACP methods through the SDK
	var rpcMsg struct {
		JSONRPC string          `json:"jsonrpc"`
		Method  string          `json:"method"`
		ID      json.RawMessage `json:"id,omitempty"`
		Params  json.RawMessage `json:"params,omitempty"`
	}
	if err := json.Unmarshal(data, &rpcMsg); err != nil {
		log.Printf("Failed to parse WebSocket message: %v", err)
		return nil
	}

	switch rpcMsg.Method {
	case "session/prompt":
		go g.handlePromptRequest(ctx, rpcMsg.ID, rpcMsg.Params)
	default:
		// Forward unknown methods to agent stdin (fallback)
		g.forwardToAgent(data)
	}
	return nil
}

// handleSelectAgent handles agent selection requests from the browser.
func (g *Gateway) handleSelectAgent(ctx context.Context, agentType string) {
	g.mu.Lock()

	log.Printf("Agent selection requested: %s", agentType)

	// Capture previous ACP session ID before stopping the agent.
	// On reconnection, if the same agent type is selected, we can use
	// LoadSession to restore conversation context.
	previousAcpSessionID := ""
	previousAgentType := g.agentType
	if g.sessionID != "" {
		previousAcpSessionID = string(g.sessionID)
	}
	// Also check config for session ID from a previous WebSocket connection.
	// On reconnect (fresh gateway), g.sessionID and g.agentType are empty,
	// so we fall back to the values passed via config from the persistent store.
	if previousAcpSessionID == "" && g.config.PreviousAcpSessionID != "" {
		previousAcpSessionID = g.config.PreviousAcpSessionID
		g.config.PreviousAcpSessionID = ""
	}
	if previousAgentType == "" && g.config.PreviousAgentType != "" {
		previousAgentType = g.config.PreviousAgentType
		g.config.PreviousAgentType = ""
	}

	// Stop current agent if running
	if g.process != nil {
		g.stopCurrentAgentLocked()
	}

	g.agentType = agentType
	g.restartCount = 0
	g.mu.Unlock()

	// Send starting status
	g.sendAgentStatus(StatusStarting, agentType, "")

	// Reset stderr buffer for the new agent
	g.stderrMu.Lock()
	g.stderrBuf.Reset()
	g.stderrMu.Unlock()

	g.reportLifecycle("info", "Agent selection started", map[string]interface{}{
		"agentType":            agentType,
		"previousAcpSessionID": previousAcpSessionID,
		"previousAgentType":    previousAgentType,
		"sessionId":            g.config.SessionID,
	})

	// Fetch credential from control plane
	cred, err := g.fetchAgentKey(ctx, agentType)
	if err != nil {
		errMsg := fmt.Sprintf("Failed to fetch credential for %s — check Settings", agentType)
		log.Printf("Agent credential fetch failed: %v", err)
		g.sendAgentStatus(StatusError, agentType, errMsg)
		g.reportAgentError(agentType, "agent_key_fetch", errMsg, err.Error())
		return
	}
	g.reportLifecycle("info", "Agent credential fetched", map[string]interface{}{
		"agentType":      agentType,
		"credentialKind": cred.credentialKind,
	})

	// Ensure the ACP adapter binary is installed in the devcontainer.
	// Repos with their own .devcontainer config skip --additional-features
	// during bootstrap, so the binary may not be present.
	info := getAgentCommandInfo(agentType, cred.credentialKind)
	if err := g.ensureAgentInstalled(ctx, info); err != nil {
		errMsg := fmt.Sprintf("Failed to install %s: %v", info.command, err)
		log.Printf("Agent install failed: %v", err)
		g.sendAgentStatus(StatusError, agentType, errMsg)
		g.reportAgentError(agentType, "agent_install", errMsg, err.Error())
		return
	}
	g.reportLifecycle("info", "Agent binary verified/installed", map[string]interface{}{
		"agentType": agentType,
		"command":   info.command,
	})

	// Fetch user's agent settings (non-blocking: defaults used if unavailable)
	settings := g.fetchAgentSettings(ctx, agentType)
	if settings != nil {
		log.Printf("Agent settings loaded: model=%q permissionMode=%q", settings.Model, settings.PermissionMode)
	}

	// Only attempt LoadSession if reconnecting with the same agent type
	loadSessionID := ""
	if previousAcpSessionID != "" && previousAgentType == agentType {
		loadSessionID = previousAcpSessionID
		log.Printf("ACP: will attempt LoadSession with sessionID=%s (previousAgentType=%s matches requested=%s)", loadSessionID, previousAgentType, agentType)
		g.reportLifecycle("info", "LoadSession will be attempted", map[string]interface{}{
			"agentType":            agentType,
			"previousAcpSessionID": previousAcpSessionID,
		})
	} else if previousAcpSessionID != "" {
		log.Printf("ACP: skipping LoadSession — agent type mismatch (previous=%q, requested=%q)", previousAgentType, agentType)
		g.reportLifecycle("info", "LoadSession skipped: agent type mismatch", map[string]interface{}{
			"previousAgentType": previousAgentType,
			"requestedAgent":    agentType,
		})
	}

	// Start the agent process
	g.mu.Lock()
	if err := g.startAgent(ctx, agentType, cred, settings, loadSessionID); err != nil {
		g.mu.Unlock()
		log.Printf("Agent start failed: %v", err)
		g.sendAgentStatus(StatusError, agentType, err.Error())
		g.reportAgentError(agentType, "agent_start", err.Error(), "")
		return
	}
	g.mu.Unlock()

	g.reportLifecycle("info", "Agent ready", map[string]interface{}{
		"agentType": agentType,
		"sessionId": g.config.SessionID,
	})
	g.reportEvent("info", "agent.ready", fmt.Sprintf("Agent %s is ready", agentType), map[string]interface{}{
		"agentType": agentType,
	})
	g.sendAgentStatus(StatusReady, agentType, "")
}

// handlePromptRequest routes a session/prompt request from the browser through
// the ACP SDK instead of forwarding raw JSON to agent stdin. The SDK manages
// the protocol lifecycle (request IDs, response matching) while streaming
// session/update notifications flow back via gatewayClient.SessionUpdate().
func (g *Gateway) handlePromptRequest(ctx context.Context, reqID json.RawMessage, params json.RawMessage) {
	// Signal activity for idle detection
	if g.config.OnActivity != nil {
		g.config.OnActivity()
	}

	g.mu.Lock()
	acpConn := g.acpConn
	sessionID := g.sessionID
	g.mu.Unlock()

	if acpConn == nil || sessionID == acpsdk.SessionId("") {
		log.Printf("Prompt request received but no ACP session active")
		g.reportLifecycle("warn", "Prompt received but no ACP session active", nil)
		g.sendJSONRPCError(reqID, -32603, "No ACP session active")
		return
	}

	// Parse the prompt content from the browser's request.
	// Browser sends: { prompt: [{ type: "text", text: "..." }] }
	var promptParams struct {
		Prompt []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"prompt"`
	}
	if err := json.Unmarshal(params, &promptParams); err != nil {
		log.Printf("Failed to parse prompt params: %v", err)
		g.sendJSONRPCError(reqID, -32602, "Invalid prompt params")
		return
	}

	// Build ACP ContentBlock array from browser prompt
	var blocks []acpsdk.ContentBlock
	for _, p := range promptParams.Prompt {
		if p.Type == "text" && p.Text != "" {
			blocks = append(blocks, acpsdk.TextBlock(p.Text))
		}
	}
	if len(blocks) == 0 {
		g.sendJSONRPCError(reqID, -32602, "Empty prompt")
		return
	}

	log.Printf("ACP: sending Prompt (session=%s, blocks=%d)", sessionID, len(blocks))
	promptStart := time.Now()
	g.reportLifecycle("info", "ACP Prompt started", map[string]interface{}{
		"acpSessionId": string(sessionID),
		"blockCount":   len(blocks),
	})

	// Prompt() is blocking — it waits for the agent to complete processing.
	// While it runs, session/update notifications are dispatched to
	// gatewayClient.SessionUpdate() which forwards them to the browser.
	resp, err := acpConn.Prompt(ctx, acpsdk.PromptRequest{
		SessionId: sessionID,
		Prompt:    blocks,
	})
	if err != nil {
		log.Printf("ACP Prompt failed: %v", err)
		g.reportLifecycle("warn", "ACP Prompt failed", map[string]interface{}{
			"error":    err.Error(),
			"duration": time.Since(promptStart).String(),
		})
		g.sendJSONRPCError(reqID, -32603, fmt.Sprintf("Prompt failed: %v", err))
		return
	}

	log.Printf("ACP: Prompt completed (stopReason=%s)", resp.StopReason)
	g.reportLifecycle("info", "ACP Prompt completed", map[string]interface{}{
		"stopReason": string(resp.StopReason),
		"duration":   time.Since(promptStart).String(),
	})

	// Send the prompt response back to the browser as a JSON-RPC result
	result, _ := json.Marshal(resp)
	response := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(reqID),
		"result":  json.RawMessage(result),
	}
	data, _ := json.Marshal(response)
	g.writeRawJSON(data)
}

// sendJSONRPCError sends a JSON-RPC error response to the browser.
func (g *Gateway) sendJSONRPCError(reqID json.RawMessage, code int, message string) {
	resp := map[string]interface{}{
		"jsonrpc": "2.0",
		"error": map[string]interface{}{
			"code":    code,
			"message": message,
		},
	}
	if reqID != nil {
		resp["id"] = json.RawMessage(reqID)
	}
	data, _ := json.Marshal(resp)
	g.writeRawJSON(data)
}

// ensureAgentInstalled checks if the ACP adapter binary exists in the devcontainer
// and installs it on-demand if missing. This handles repos with their own
// .devcontainer config where --additional-features is skipped during bootstrap.
func (g *Gateway) ensureAgentInstalled(ctx context.Context, info agentCommandInfo) error {
	if info.installCmd == "" {
		return nil // Unknown agent, skip install check
	}

	containerID, err := g.config.ContainerResolver()
	if err != nil {
		return fmt.Errorf("failed to discover devcontainer: %w", err)
	}

	// Quick check: if binary already exists, skip install
	checkArgs := []string{"exec", containerID, "which", info.command}
	checkCmd := exec.CommandContext(ctx, "docker", checkArgs...)
	if err := checkCmd.Run(); err == nil {
		log.Printf("Agent binary %s is already installed", info.command)
		return nil
	}

	g.sendAgentStatus(StatusInstalling, info.command, "")
	return installAgentBinary(ctx, containerID, info)
}

// installAgentBinary checks if the agent command exists in the given container
// and installs it via the provided installCmd if missing. The install runs as
// root to ensure permissions for system-level package installs. Returns nil if
// the binary was already present or was installed successfully.
func installAgentBinary(ctx context.Context, containerID string, info agentCommandInfo) error {
	// Check if the command already exists
	checkArgs := []string{"exec", containerID, "which", info.command}
	checkCmd := exec.CommandContext(ctx, "docker", checkArgs...)
	if err := checkCmd.Run(); err == nil {
		log.Printf("Agent binary %s is already installed", info.command)
		return nil
	}

	log.Printf("Agent binary %s not found in container, installing", info.command)

	// Check if npm exists; if not, install Node.js first (most devcontainers
	// are Debian/Ubuntu-based). Run as root for system-level package installs.
	installScript := fmt.Sprintf(
		`which npm >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq nodejs npm; }; %s`,
		info.installCmd,
	)

	installArgs := []string{"exec", "-u", "root", containerID, "sh", "-c", installScript}
	installCmd := exec.CommandContext(ctx, "docker", installArgs...)
	output, err := installCmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("install command failed: %w: %s", err, strings.TrimSpace(string(output)))
	}

	log.Printf("Agent binary %s installed successfully", info.command)
	return nil
}

// startAgent spawns the agent process and sets up the ACP connection.
// If previousAcpSessionID is non-empty and the agent supports LoadSession,
// it will attempt to restore the previous conversation instead of creating
// a new blank session.
func (g *Gateway) startAgent(ctx context.Context, agentType string, cred *agentCredential, settings *agentSettingsPayload, previousAcpSessionID string) error {
	// Resolve container ID
	containerID, err := g.config.ContainerResolver()
	if err != nil {
		return fmt.Errorf("failed to discover devcontainer: %w", err)
	}

	// Look up agent command and args from well-known agent definitions
	// Pass the credential kind to determine the correct environment variable
	info := getAgentCommandInfo(agentType, cred.credentialKind)

	// Build environment variables: credential + optional model setting
	envVars := []string{fmt.Sprintf("%s=%s", info.envVarName, cred.credential)}
	if settings != nil && settings.Model != "" {
		modelEnv := getModelEnvVar(agentType)
		if modelEnv != "" {
			envVars = append(envVars, fmt.Sprintf("%s=%s", modelEnv, settings.Model))
			log.Printf("Agent model override: %s=%s", modelEnv, settings.Model)
		}
	}

	// Store permission mode for use in permission request handling
	if settings != nil && settings.PermissionMode != "" {
		g.permissionMode = settings.PermissionMode
	} else {
		g.permissionMode = "default"
	}

	process, err := StartProcess(ProcessConfig{
		ContainerID:   containerID,
		ContainerUser: g.config.ContainerUser,
		AcpCommand:    info.command,
		AcpArgs:       info.args,
		EnvVars:       envVars,
		WorkDir:       g.config.ContainerWorkDir,
	})
	if err != nil {
		return fmt.Errorf("failed to start agent process: %w", err)
	}

	g.process = process

	// Create ACP client-side connection using the SDK
	client := &gatewayClient{gateway: g}
	g.acpConn = acpsdk.NewClientSideConnection(client, process.Stdin(), process.Stdout())

	// Monitor stderr for error detection
	go g.monitorStderr(process)

	// Monitor process exit for crash detection
	go g.monitorProcessExit(ctx, process, agentType, cred, settings)

	// Initialize the ACP protocol handshake.
	// The agent expects Initialize → NewSession (or LoadSession) before any Prompt calls.
	initCtx, initCancel := context.WithTimeout(ctx, 30*time.Second)
	defer initCancel()

	log.Printf("ACP: sending Initialize request")
	g.reportLifecycle("info", "ACP Initialize started", map[string]interface{}{
		"agentType": agentType,
	})
	initResp, err := g.acpConn.Initialize(initCtx, acpsdk.InitializeRequest{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
		ClientCapabilities: acpsdk.ClientCapabilities{
			Fs: acpsdk.FileSystemCapability{ReadTextFile: true, WriteTextFile: true},
		},
	})
	if err != nil {
		g.reportLifecycle("warn", "ACP Initialize failed", map[string]interface{}{
			"agentType": agentType,
			"error":     err.Error(),
		})
		return fmt.Errorf("ACP initialize failed: %w", err)
	}
	log.Printf("ACP: Initialize succeeded (loadSession=%v)", initResp.AgentCapabilities.LoadSession)
	g.reportLifecycle("info", "ACP Initialize succeeded", map[string]interface{}{
		"agentType":          agentType,
		"supportsLoadSession": initResp.AgentCapabilities.LoadSession,
	})

	// Attempt LoadSession if we have a previous session ID and the agent supports it.
	// LoadSession restores conversation context — the agent replays all messages
	// as session/update notifications which flow to the browser.
	if previousAcpSessionID != "" && initResp.AgentCapabilities.LoadSession {
		log.Printf("ACP: attempting LoadSession with previous sessionID=%s", previousAcpSessionID)
		g.reportLifecycle("info", "ACP LoadSession started", map[string]interface{}{
			"agentType":            agentType,
			"previousAcpSessionID": previousAcpSessionID,
		})
		g.reportEvent("info", "agent.load_session", "Restoring previous conversation", map[string]interface{}{
			"previousAcpSessionID": previousAcpSessionID,
		})
		_, loadErr := g.acpConn.LoadSession(initCtx, acpsdk.LoadSessionRequest{
			SessionId:  acpsdk.SessionId(previousAcpSessionID),
			Cwd:        g.config.ContainerWorkDir,
			McpServers: []acpsdk.McpServer{},
		})
		if loadErr == nil {
			g.sessionID = acpsdk.SessionId(previousAcpSessionID)
			log.Printf("ACP: LoadSession succeeded, sessionID=%s", previousAcpSessionID)
			g.reportLifecycle("info", "ACP LoadSession succeeded", map[string]interface{}{
				"agentType":   agentType,
				"acpSessionId": previousAcpSessionID,
			})
			g.reportEvent("info", "agent.load_session_ok", "Previous conversation restored", map[string]interface{}{
				"acpSessionId": previousAcpSessionID,
			})
			g.persistAcpSessionID(agentType)
			return nil
		}
		log.Printf("ACP: LoadSession failed (falling back to NewSession): %v", loadErr)
		g.reportLifecycle("warn", "ACP LoadSession failed, falling back to NewSession", map[string]interface{}{
			"agentType": agentType,
			"error":     loadErr.Error(),
		})
		g.reportEvent("warn", "agent.load_session_failed", "Could not restore conversation, starting fresh", map[string]interface{}{
			"error": loadErr.Error(),
		})
	} else if previousAcpSessionID != "" {
		log.Printf("ACP: agent does not support LoadSession, using NewSession instead")
		g.reportLifecycle("info", "Agent does not support LoadSession", map[string]interface{}{
			"agentType": agentType,
		})
	}

	log.Printf("ACP: sending NewSession request")
	g.reportLifecycle("info", "ACP NewSession started", map[string]interface{}{
		"agentType": agentType,
	})
	sessResp, err := g.acpConn.NewSession(initCtx, acpsdk.NewSessionRequest{
		Cwd:        g.config.ContainerWorkDir,
		McpServers: []acpsdk.McpServer{},
	})
	if err != nil {
		g.reportLifecycle("warn", "ACP NewSession failed", map[string]interface{}{
			"agentType": agentType,
			"error":     err.Error(),
		})
		return fmt.Errorf("ACP new session failed: %w", err)
	}
	g.sessionID = sessResp.SessionId
	log.Printf("ACP: NewSession succeeded, sessionID=%s", string(g.sessionID))
	g.reportLifecycle("info", "ACP NewSession succeeded", map[string]interface{}{
		"agentType":   agentType,
		"acpSessionId": string(g.sessionID),
	})
	g.persistAcpSessionID(agentType)

	return nil
}

// monitorStderr reads the agent's stderr, logs it, and collects it for error reporting.
func (g *Gateway) monitorStderr(process *AgentProcess) {
	scanner := bufio.NewScanner(process.Stderr())
	for scanner.Scan() {
		line := scanner.Text()
		log.Printf("Agent stderr: %s", line)
		g.stderrMu.Lock()
		if g.stderrBuf.Len() < 4096 { // Cap collected stderr at 4KB
			if g.stderrBuf.Len() > 0 {
				g.stderrBuf.WriteByte('\n')
			}
			g.stderrBuf.WriteString(line)
		}
		g.stderrMu.Unlock()
	}
}

// getAndClearStderr returns the collected stderr output and resets the buffer.
func (g *Gateway) getAndClearStderr() string {
	g.stderrMu.Lock()
	defer g.stderrMu.Unlock()
	s := g.stderrBuf.String()
	g.stderrBuf.Reset()
	return s
}

// monitorProcessExit detects when the agent process crashes and attempts restart.
func (g *Gateway) monitorProcessExit(ctx context.Context, process *AgentProcess, agentType string, cred *agentCredential, settings *agentSettingsPayload) {
	err := process.Wait()

	// Brief delay to let stderr goroutine finish collecting output
	time.Sleep(100 * time.Millisecond)
	stderrOutput := g.getAndClearStderr()

	uptime := time.Since(process.startTime)
	exitInfo := "exit=0"
	if err != nil {
		exitInfo = fmt.Sprintf("exit=%v", err)
	}
	log.Printf("Agent process exited: type=%s, uptime=%v, %s, stderr=%d bytes",
		agentType, uptime.Round(time.Millisecond), exitInfo, len(stderrOutput))

	// Detect rapid exit (within 5s) regardless of exit code. Any exit this
	// fast indicates a crash or misconfiguration — even exit code 0.
	// Report the error BEFORE the ownership check so error data reaches the
	// control plane even if cleanup() already ran (race with WebSocket close).
	isRapidExit := uptime < 5*time.Second
	if isRapidExit {
		errMsg := fmt.Sprintf("Agent %s crashed on startup (exited in %v, %s)", agentType, uptime.Round(time.Millisecond), exitInfo)
		if stderrOutput != "" {
			errMsg = fmt.Sprintf("%s: %s", errMsg, truncate(stderrOutput, 500))
		}
		log.Printf("Agent rapid exit: %s", errMsg)
		// Report to boot-log FIRST — this is fire-and-forget and must not be
		// gated by the ownership check, which may fail if cleanup() already ran.
		g.reportAgentError(agentType, "agent_crash", errMsg, stderrOutput)
	}

	g.mu.Lock()
	// Only handle status updates and restarts if this is still the active process.
	// Error reporting above already ran unconditionally.
	if g.process != process {
		g.mu.Unlock()
		log.Printf("Agent process monitor: process replaced (cleanup() likely ran), skipping status/restart")
		return
	}

	if isRapidExit {
		g.process = nil
		g.acpConn = nil
		g.sessionID = ""
		g.mu.Unlock()

		// Build error message for WebSocket status (same as reported above)
		errMsg := fmt.Sprintf("Agent %s crashed on startup (exited in %v, %s)", agentType, uptime.Round(time.Millisecond), exitInfo)
		if stderrOutput != "" {
			errMsg = fmt.Sprintf("%s: %s", errMsg, truncate(stderrOutput, 500))
		}
		g.sendAgentStatus(StatusError, agentType, errMsg)
		return
	}

	g.restartCount++
	if g.restartCount > g.config.MaxRestartAttempts {
		log.Printf("Agent exceeded max restart attempts (%d)", g.config.MaxRestartAttempts)
		g.process = nil
		g.acpConn = nil
		g.sessionID = ""
		g.mu.Unlock()
		crashMsg := "Agent crashed and could not be restarted"
		if stderrOutput != "" {
			crashMsg = fmt.Sprintf("%s: %s", crashMsg, truncate(stderrOutput, 500))
		}
		g.sendAgentStatus(StatusError, agentType, crashMsg)
		g.reportAgentError(agentType, "agent_max_restarts", crashMsg, stderrOutput)
		return
	}

	g.process = nil
	g.acpConn = nil
	g.sessionID = ""
	g.mu.Unlock()

	log.Printf("Attempting agent restart (%d/%d)", g.restartCount, g.config.MaxRestartAttempts)
	g.sendAgentStatus(StatusRestarting, agentType, "")

	// Brief delay before restart
	time.Sleep(time.Second)

	g.mu.Lock()
	if err := g.startAgent(ctx, agentType, cred, settings, ""); err != nil {
		g.mu.Unlock()
		log.Printf("Agent restart failed: %v", err)
		g.sendAgentStatus(StatusError, agentType, err.Error())
		g.reportAgentError(agentType, "agent_restart_failed", err.Error(), "")
		return
	}
	g.mu.Unlock()

	g.sendAgentStatus(StatusReady, agentType, "")
}

// reportAgentError sends an agent error to both the boot-log endpoint and
// the error reporter for CF Workers observability. Fire-and-forget.
func (g *Gateway) reportAgentError(agentType, step, message, detail string) {
	if g.config.BootLog != nil {
		g.config.BootLog.Log(step, "failed", fmt.Sprintf("[%s] %s", agentType, message), detail)
	}
	if g.config.ErrorReporter != nil {
		g.config.ErrorReporter.ReportError(
			fmt.Errorf("%s", message),
			"acp-gateway",
			g.config.WorkspaceID,
			map[string]interface{}{
				"agentType": agentType,
				"step":      step,
				"detail":    detail,
			},
		)
	}
}

// reportLifecycle sends an info or warn lifecycle event to the error reporter
// for CF Workers observability. Fire-and-forget.
func (g *Gateway) reportLifecycle(level, message string, ctx map[string]interface{}) {
	if g.config.ErrorReporter == nil {
		return
	}
	switch level {
	case "warn":
		g.config.ErrorReporter.ReportWarn(message, "acp-gateway", g.config.WorkspaceID, ctx)
	default:
		g.config.ErrorReporter.ReportInfo(message, "acp-gateway", g.config.WorkspaceID, ctx)
	}
}

// reportEvent emits a workspace event visible in the UI event log.
func (g *Gateway) reportEvent(level, eventType, message string, detail map[string]interface{}) {
	if g.config.EventAppender != nil {
		g.config.EventAppender.AppendEvent(g.config.WorkspaceID, level, eventType, message, detail)
	}
}

// truncate limits a string to maxLen characters, appending "..." if truncated.
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

// forwardToAgent sends a message to the agent's stdin.
func (g *Gateway) forwardToAgent(message []byte) {
	g.mu.Lock()
	process := g.process
	g.mu.Unlock()

	if process == nil {
		log.Printf("No agent process running, dropping message")
		return
	}

	// Write message as a single NDJSON line (append newline)
	data := append(message, '\n')
	if _, err := process.Stdin().Write(data); err != nil {
		log.Printf("Failed to write to agent stdin: %v", err)
	}
}

// sendAgentStatus sends an agent_status control message to the WebSocket.
func (g *Gateway) sendAgentStatus(status AgentStatus, agentType, errMsg string) {
	msg := AgentStatusMessage{
		Type:      MsgAgentStatus,
		Status:    status,
		AgentType: agentType,
		Error:     errMsg,
	}
	g.writeJSON(msg)
}

// writeJSON writes a JSON message to the WebSocket with mutex protection.
func (g *Gateway) writeJSON(v interface{}) {
	g.writeMu.Lock()
	defer g.writeMu.Unlock()
	if err := g.conn.WriteJSON(v); err != nil {
		log.Printf("Failed to write to WebSocket: %v", err)
		g.reportLifecycle("warn", "WebSocket writeJSON failed", map[string]interface{}{
			"error": err.Error(),
		})
	}
}

// writeRawJSON writes raw JSON bytes to the WebSocket.
func (g *Gateway) writeRawJSON(data []byte) {
	g.writeMu.Lock()
	defer g.writeMu.Unlock()
	if err := g.conn.WriteMessage(websocket.TextMessage, data); err != nil {
		log.Printf("Failed to write raw message to WebSocket: %v", err)
		g.reportLifecycle("warn", "WebSocket writeRawJSON failed", map[string]interface{}{
			"error":      err.Error(),
			"dataLength": len(data),
		})
	}
}

// stopCurrentAgentLocked stops the current agent process. Must hold g.mu.
func (g *Gateway) stopCurrentAgentLocked() {
	if g.process != nil {
		_ = g.process.Stop()
		g.process = nil
	}
	g.acpConn = nil
	g.sessionID = ""
}

// persistAcpSessionID saves the current ACP session ID to both the in-memory
// session manager and the SQLite persistence store for reconnection support.
func (g *Gateway) persistAcpSessionID(agentType string) {
	sessionID := string(g.sessionID)
	if sessionID == "" {
		return
	}

	// Update in-memory session manager
	if g.config.SessionManager != nil && g.config.SessionID != "" {
		if err := g.config.SessionManager.UpdateAcpSessionID(
			g.config.WorkspaceID, g.config.SessionID, sessionID, agentType,
		); err != nil {
			log.Printf("Failed to persist ACP session ID to session manager: %v", err)
		} else {
			log.Printf("ACP session ID persisted to session manager: %s", sessionID)
		}
	}

	// Update SQLite persistence store
	if g.config.TabStore != nil && g.config.SessionID != "" {
		if err := g.config.TabStore.UpdateTabAcpSessionID(g.config.SessionID, sessionID); err != nil {
			log.Printf("Failed to persist ACP session ID to tab store: %v", err)
		} else {
			log.Printf("ACP session ID persisted to tab store: %s", sessionID)
		}
	}
}

// cleanup stops any running agent process.
func (g *Gateway) cleanup() {
	g.reportLifecycle("info", "Gateway cleanup started", map[string]interface{}{
		"agentType": g.agentType,
		"sessionId": g.config.SessionID,
	})
	g.mu.Lock()
	defer g.mu.Unlock()
	g.stopCurrentAgentLocked()
}

// agentCredential holds the credential and its type returned from the control plane.
type agentCredential struct {
	credential     string
	credentialKind string // "api-key" or "oauth-token"
}

// fetchAgentKey retrieves the decrypted agent credential from the control plane.
func (g *Gateway) fetchAgentKey(ctx context.Context, agentType string) (*agentCredential, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/agent-key", g.config.ControlPlaneURL, g.config.WorkspaceID)

	body, err := json.Marshal(map[string]string{"agentType": agentType})
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", url, byteReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+g.config.CallbackToken)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch agent key: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("no credential configured for %s", agentType)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("control plane returned status %d", resp.StatusCode)
	}

	var result struct {
		APIKey         string `json:"apiKey"`
		CredentialKind string `json:"credentialKind"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	if result.APIKey == "" {
		return nil, fmt.Errorf("empty credential returned for %s", agentType)
	}

	// Default to api-key for backward compatibility
	if result.CredentialKind == "" {
		result.CredentialKind = "api-key"
	}

	return &agentCredential{
		credential:     result.APIKey,
		credentialKind: result.CredentialKind,
	}, nil
}

func byteReader(data []byte) io.ReadCloser {
	return io.NopCloser(bytes.NewReader(data))
}

// agentSettingsPayload holds per-user, per-agent settings from the control plane.
type agentSettingsPayload struct {
	Model          string `json:"model"`
	PermissionMode string `json:"permissionMode"`
}

// fetchAgentSettings retrieves the user's agent settings from the control plane.
// Returns nil settings (not an error) if no settings are configured.
func (g *Gateway) fetchAgentSettings(ctx context.Context, agentType string) *agentSettingsPayload {
	url := fmt.Sprintf("%s/api/workspaces/%s/agent-settings", g.config.ControlPlaneURL, g.config.WorkspaceID)

	body, err := json.Marshal(map[string]string{"agentType": agentType})
	if err != nil {
		log.Printf("Failed to marshal agent settings request: %v", err)
		return nil
	}

	req, err := http.NewRequestWithContext(ctx, "POST", url, byteReader(body))
	if err != nil {
		log.Printf("Failed to create agent settings request: %v", err)
		return nil
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+g.config.CallbackToken)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("Failed to fetch agent settings: %v", err)
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("Agent settings returned status %d, using defaults", resp.StatusCode)
		return nil
	}

	var result agentSettingsPayload
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		log.Printf("Failed to decode agent settings: %v", err)
		return nil
	}

	return &result
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

// gatewayClient implements the acp.Client interface, forwarding agent
// notifications and requests to the browser via WebSocket.
type gatewayClient struct {
	gateway *Gateway
}

func (c *gatewayClient) SessionUpdate(_ context.Context, params acpsdk.SessionNotification) error {
	// Forward the session update notification to the browser as JSON
	data, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "session/update",
		"params":  params,
	})
	if err != nil {
		return fmt.Errorf("failed to marshal session update: %w", err)
	}
	c.gateway.writeRawJSON(data)
	return nil
}

func (c *gatewayClient) RequestPermission(_ context.Context, params acpsdk.RequestPermissionRequest) (acpsdk.RequestPermissionResponse, error) {
	// Forward permission request to browser for observability
	data, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "permission/request",
		"params":  params,
	})
	if err != nil {
		return acpsdk.RequestPermissionResponse{}, fmt.Errorf("failed to marshal permission request: %w", err)
	}
	c.gateway.writeRawJSON(data)

	// Handle based on permission mode:
	// - "bypassPermissions": auto-approve all requests
	// - "acceptEdits": auto-approve all requests (file edits + other operations)
	// - "default": auto-approve (current behavior; browser-driven approval deferred)
	//
	// All modes currently auto-approve since the browser-to-gateway permission
	// response channel is not yet implemented. The permission mode also controls
	// the agent's own permission behavior via CLI flags passed at startup.
	mode := c.gateway.permissionMode
	if mode == "" {
		mode = "default"
	}
	log.Printf("Permission request (mode=%s): %d options available", mode, len(params.Options))

	if len(params.Options) > 0 {
		return acpsdk.RequestPermissionResponse{
			Outcome: acpsdk.NewRequestPermissionOutcomeSelected(params.Options[0].OptionId),
		}, nil
	}
	return acpsdk.RequestPermissionResponse{
		Outcome: acpsdk.NewRequestPermissionOutcomeCancelled(),
	}, nil
}

func (c *gatewayClient) ReadTextFile(ctx context.Context, params acpsdk.ReadTextFileRequest) (acpsdk.ReadTextFileResponse, error) {
	if params.Path == "" {
		return acpsdk.ReadTextFileResponse{}, fmt.Errorf("file path is required")
	}

	containerID, err := c.gateway.config.ContainerResolver()
	if err != nil {
		return acpsdk.ReadTextFileResponse{}, fmt.Errorf("failed to resolve container: %w", err)
	}

	timeout := c.gateway.config.FileExecTimeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	content, stderr, err := execInContainer(execCtx, containerID, c.gateway.config.ContainerUser, "", "cat", params.Path)
	if err != nil {
		log.Printf("[acp] ReadTextFile error for %q: %v, stderr: %s", params.Path, err, stderr)
		return acpsdk.ReadTextFileResponse{}, fmt.Errorf("failed to read file %q: %v", params.Path, err)
	}

	maxSize := c.gateway.config.FileMaxSize
	if maxSize == 0 {
		maxSize = 1048576 // 1 MB
	}
	if len(content) > maxSize {
		return acpsdk.ReadTextFileResponse{}, fmt.Errorf("file %q exceeds maximum size of %d bytes", params.Path, maxSize)
	}

	content = applyLineLimit(content, params.Line, params.Limit)

	return acpsdk.ReadTextFileResponse{Content: content}, nil
}

func (c *gatewayClient) WriteTextFile(ctx context.Context, params acpsdk.WriteTextFileRequest) (acpsdk.WriteTextFileResponse, error) {
	if params.Path == "" {
		return acpsdk.WriteTextFileResponse{}, fmt.Errorf("file path is required")
	}

	containerID, err := c.gateway.config.ContainerResolver()
	if err != nil {
		return acpsdk.WriteTextFileResponse{}, fmt.Errorf("failed to resolve container: %w", err)
	}

	timeout := c.gateway.config.FileExecTimeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Use tee to write stdin to the file. tee handles creating/overwriting files.
	dockerArgs := []string{"exec", "-i"}
	if c.gateway.config.ContainerUser != "" {
		dockerArgs = append(dockerArgs, "-u", c.gateway.config.ContainerUser)
	}
	dockerArgs = append(dockerArgs, containerID, "tee", params.Path)

	cmd := exec.CommandContext(execCtx, "docker", dockerArgs...)
	cmd.Stdin = strings.NewReader(params.Content)

	var stderrBuf bytes.Buffer
	cmd.Stdout = io.Discard // tee echoes input to stdout, discard it
	cmd.Stderr = &stderrBuf

	if err := cmd.Run(); err != nil {
		stderrStr := strings.TrimSpace(stderrBuf.String())
		log.Printf("[acp] WriteTextFile error for %q: %v, stderr: %s", params.Path, err, stderrStr)
		return acpsdk.WriteTextFileResponse{}, fmt.Errorf("failed to write file %q: %v", params.Path, err)
	}

	return acpsdk.WriteTextFileResponse{}, nil
}

func (c *gatewayClient) CreateTerminal(_ context.Context, _ acpsdk.CreateTerminalRequest) (acpsdk.CreateTerminalResponse, error) {
	return acpsdk.CreateTerminalResponse{}, fmt.Errorf("CreateTerminal not supported by gateway")
}

func (c *gatewayClient) KillTerminalCommand(_ context.Context, _ acpsdk.KillTerminalCommandRequest) (acpsdk.KillTerminalCommandResponse, error) {
	return acpsdk.KillTerminalCommandResponse{}, fmt.Errorf("KillTerminalCommand not supported by gateway")
}

func (c *gatewayClient) TerminalOutput(_ context.Context, _ acpsdk.TerminalOutputRequest) (acpsdk.TerminalOutputResponse, error) {
	return acpsdk.TerminalOutputResponse{}, fmt.Errorf("TerminalOutput not supported by gateway")
}

func (c *gatewayClient) ReleaseTerminal(_ context.Context, _ acpsdk.ReleaseTerminalRequest) (acpsdk.ReleaseTerminalResponse, error) {
	return acpsdk.ReleaseTerminalResponse{}, fmt.Errorf("ReleaseTerminal not supported by gateway")
}

func (c *gatewayClient) WaitForTerminalExit(_ context.Context, _ acpsdk.WaitForTerminalExitRequest) (acpsdk.WaitForTerminalExitResponse, error) {
	return acpsdk.WaitForTerminalExitResponse{}, fmt.Errorf("WaitForTerminalExit not supported by gateway")
}

// The following methods are not yet available in the current ACP SDK version
// TODO: Uncomment when SDK is updated
/*
func (c *gatewayClient) ListTextFiles(_ context.Context, _ acpsdk.ListTextFilesRequest) (acpsdk.ListTextFilesResponse, error) {
	return acpsdk.ListTextFilesResponse{}, fmt.Errorf("ListTextFiles not supported by gateway")
}

func (c *gatewayClient) EditTextFile(_ context.Context, _ acpsdk.EditTextFileRequest) (acpsdk.EditTextFileResponse, error) {
	return acpsdk.EditTextFileResponse{}, fmt.Errorf("EditTextFile not supported by gateway")
}

func (c *gatewayClient) CreateDirectory(_ context.Context, _ acpsdk.CreateDirectoryRequest) (acpsdk.CreateDirectoryResponse, error) {
	return acpsdk.CreateDirectoryResponse{}, fmt.Errorf("CreateDirectory not supported by gateway")
}

func (c *gatewayClient) MoveResource(_ context.Context, _ acpsdk.MoveResourceRequest) (acpsdk.MoveResourceResponse, error) {
	return acpsdk.MoveResourceResponse{}, fmt.Errorf("MoveResource not supported by gateway")
}

func (c *gatewayClient) StartTerminal(_ context.Context, _ acpsdk.StartTerminalRequest) (acpsdk.StartTerminalResponse, error) {
	return acpsdk.StartTerminalResponse{}, fmt.Errorf("StartTerminal not supported by gateway")
}

func (c *gatewayClient) SendTerminalInput(_ context.Context, _ acpsdk.SendTerminalInputRequest) (acpsdk.SendTerminalInputResponse, error) {
	return acpsdk.SendTerminalInputResponse{}, fmt.Errorf("SendTerminalInput not supported by gateway")
}

func (c *gatewayClient) ResizeTerminal(_ context.Context, _ acpsdk.ResizeTerminalRequest) (acpsdk.ResizeTerminalResponse, error) {
	return acpsdk.ResizeTerminalResponse{}, fmt.Errorf("ResizeTerminal not supported by gateway")
}

func (c *gatewayClient) CloseTerminal(_ context.Context, _ acpsdk.CloseTerminalRequest) (acpsdk.CloseTerminalResponse, error) {
	return acpsdk.CloseTerminalResponse{}, fmt.Errorf("CloseTerminal not supported by gateway")
}

func (c *gatewayClient) WaitForTerminalExit(_ context.Context, _ acpsdk.WaitForTerminalExitRequest) (acpsdk.WaitForTerminalExitResponse, error) {
	return acpsdk.WaitForTerminalExitResponse{}, fmt.Errorf("WaitForTerminalExit not supported by gateway")
}
*/

// agentCommandInfo holds the command, args, env var, and install command for an agent.
type agentCommandInfo struct {
	command    string
	args       []string
	envVarName string
	installCmd string // npm install command to run if binary is missing
}

// getAgentCommandInfo returns the ACP command, args, env var name, and install command for a given agent type.
// These match the agent catalog defined in packages/shared/src/agents.ts.
// The credentialKind parameter determines which environment variable to use for Claude Code.
func getAgentCommandInfo(agentType string, credentialKind string) agentCommandInfo {
	switch agentType {
	case "claude-code":
		if credentialKind == "oauth-token" {
			// OAuth tokens use a different environment variable
			return agentCommandInfo{"claude-code-acp", nil, "CLAUDE_CODE_OAUTH_TOKEN", "npm install -g @zed-industries/claude-code-acp"}
		}
		return agentCommandInfo{"claude-code-acp", nil, "ANTHROPIC_API_KEY", "npm install -g @zed-industries/claude-code-acp"}
	case "openai-codex":
		return agentCommandInfo{"codex-acp", nil, "OPENAI_API_KEY", "npm install -g @zed-industries/codex-acp"}
	case "google-gemini":
		return agentCommandInfo{"gemini", []string{"--experimental-acp"}, "GEMINI_API_KEY", "npm install -g @google/gemini-cli"}
	default:
		return agentCommandInfo{agentType, nil, "API_KEY", ""}
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
	default:
		return ""
	}
}
