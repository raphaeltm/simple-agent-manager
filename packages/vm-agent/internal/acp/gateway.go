package acp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
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
	// OnActivity is called when there's ACP activity (for idle detection).
	OnActivity func()
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

	mu     sync.Mutex
	closed bool
}

// NewGateway creates a new Gateway that relays WebSocket messages to a SessionHost.
func NewGateway(host *SessionHost, conn *websocket.Conn, viewerID string) *Gateway {
	return &Gateway{
		host:     host,
		viewerID: viewerID,
		conn:     conn,
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

// pingInterval is the interval between WebSocket pings to detect stale connections.
const pingInterval = 30 * time.Second

// pongTimeout is the deadline for receiving a pong after sending a ping.
const pongTimeout = 10 * time.Second

// Run reads WebSocket messages and routes them to the SessionHost.
// It blocks until the WebSocket closes or the context is cancelled.
// When it returns, the caller should call SessionHost.DetachViewer().
func (g *Gateway) Run(ctx context.Context) error {
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

	// Read WebSocket messages and route to SessionHost
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
				return nil
			}
			return fmt.Errorf("WebSocket read error: %w", err)
		}

		// Reset read deadline on any message
		g.conn.SetReadDeadline(time.Now().Add(pingInterval + pongTimeout))

		if msgType != websocket.TextMessage {
			continue
		}

		g.handleMessage(ctx, data)
	}
}

// handleMessage parses a WebSocket message and routes it to the SessionHost.
func (g *Gateway) handleMessage(ctx context.Context, data []byte) {
	// Check for select_agent control message
	var control SelectAgentMessage
	if err := json.Unmarshal(data, &control); err == nil {
		if control.Type == MsgSelectAgent {
			go g.host.SelectAgent(ctx, control.AgentType)
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
		log.Printf("Failed to parse WebSocket message: %v", err)
		return
	}

	switch rpcMsg.Method {
	case "session/prompt":
		go g.host.HandlePrompt(ctx, rpcMsg.ID, rpcMsg.Params, g.viewerID)
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
