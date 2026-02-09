package acp

import (
	"bytes"
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/gorilla/websocket"
)

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
	restartCount int
}

// NewGateway creates a new ACP gateway for WebSocket-to-agent bridging.
func NewGateway(config GatewayConfig, conn *websocket.Conn) *Gateway {
	return &Gateway{
		config: config,
		conn:   conn,
	}
}

// Run starts the gateway, bridging WebSocket messages to/from the agent subprocess.
func (g *Gateway) Run(ctx context.Context) error {
	defer g.cleanup()

	// Start WebSocket reader
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		msgType, data, err := g.conn.ReadMessage()
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				return nil
			}
			return fmt.Errorf("failed to read WebSocket message: %w", err)
		}

		if msgType != websocket.TextMessage {
			continue
		}

		// Check for control messages
		if err := g.handleControlMessage(ctx, data); err != nil {
			log.Printf("Error handling control message: %v", err)
		}
	}
}

// handleControlMessage processes control plane messages (agent selection).
func (g *Gateway) handleControlMessage(ctx context.Context, data []byte) error {
	var msg json.RawMessage
	if err := json.Unmarshal(data, &msg); err == nil {
		var control ControlMessage
		if err := json.Unmarshal(data, &control); err == nil {
			if control.Type == MsgSelectAgent {
				g.handleSelectAgent(ctx, control.AgentType)
				return nil
			}
		}
	}

	// Forward to agent if not a control message
	g.forwardToAgent(data)
	return nil
}

// handleSelectAgent handles agent selection requests from the browser.
func (g *Gateway) handleSelectAgent(ctx context.Context, agentType string) {
	g.mu.Lock()
	defer g.mu.Unlock()

	log.Printf("Agent selection requested: %s", agentType)

	// Stop current agent if running
	if g.process != nil {
		g.stopCurrentAgentLocked()
	}

	g.agentType = agentType
	g.restartCount = 0

	// Send starting status
	g.sendAgentStatus(StatusStarting, agentType, "")

	// Fetch credential from control plane
	cred, err := g.fetchAgentKey(ctx, agentType)
	if err != nil {
		errMsg := fmt.Sprintf("Failed to fetch credential for %s — check Settings", agentType)
		log.Printf("Agent credential fetch failed: %v", err)
		g.sendAgentStatus(StatusError, agentType, errMsg)
		return
	}

	// Start the agent process
	if err := g.startAgent(ctx, agentType, cred); err != nil {
		log.Printf("Agent start failed: %v", err)
		g.sendAgentStatus(StatusError, agentType, err.Error())
		return
	}

	g.sendAgentStatus(StatusReady, agentType, "")
}

// startAgent spawns the agent process and sets up the ACP connection.
func (g *Gateway) startAgent(ctx context.Context, agentType string, cred *agentCredential) error {
	// Resolve container ID
	containerID, err := g.config.ContainerResolver()
	if err != nil {
		return fmt.Errorf("failed to discover devcontainer: %w", err)
	}

	// Look up agent command and args from well-known agent definitions
	// Pass the credential kind to determine the correct environment variable
	info := getAgentCommandInfo(agentType, cred.credentialKind)

	process, err := StartProcess(ProcessConfig{
		ContainerID:   containerID,
		ContainerUser: g.config.ContainerUser,
		AcpCommand:    info.command,
		AcpArgs:       info.args,
		EnvVars:       []string{fmt.Sprintf("%s=%s", info.envVarName, cred.credential)},
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
	go g.monitorProcessExit(ctx, process, agentType, cred)

	// Start forwarding agent stdout (NDJSON) to WebSocket
	// Note: The ACP SDK's ClientSideConnection reads from stdout internally,
	// so we don't need a separate stdout reader. The SDK dispatches to our
	// gatewayClient methods (SessionUpdate, RequestPermission, etc.)

	return nil
}

// monitorStderr reads the agent's stderr for error messages.
func (g *Gateway) monitorStderr(process *AgentProcess) {
	scanner := bufio.NewScanner(process.Stderr())
	for scanner.Scan() {
		line := scanner.Text()
		log.Printf("Agent stderr: %s", line)
	}
}

// monitorProcessExit detects when the agent process crashes and attempts restart.
func (g *Gateway) monitorProcessExit(ctx context.Context, process *AgentProcess, agentType string, cred *agentCredential) {
	err := process.Wait()

	g.mu.Lock()
	// Only handle if this is still the active process
	if g.process != process {
		g.mu.Unlock()
		return
	}

	if err != nil {
		log.Printf("Agent process exited with error: %v", err)
	}

	// Detect rapid exit — likely an auth error (invalid/expired credential)
	uptime := time.Since(process.startTime)
	if uptime < 5*time.Second && err != nil {
		g.process = nil
		g.acpConn = nil
		g.mu.Unlock()
		credType := "API key"
		if cred.credentialKind == "oauth-token" {
			credType = "OAuth token"
		}
		errMsg := fmt.Sprintf("%s for %s may be invalid or expired — update it in Settings", credType, agentType)
		g.sendAgentStatus(StatusError, agentType, errMsg)
		return
	}

	g.restartCount++
	if g.restartCount > g.config.MaxRestartAttempts {
		log.Printf("Agent exceeded max restart attempts (%d)", g.config.MaxRestartAttempts)
		g.process = nil
		g.acpConn = nil
		g.mu.Unlock()
		g.sendAgentStatus(StatusError, agentType, "Agent crashed and could not be restarted")
		return
	}

	g.process = nil
	g.acpConn = nil
	g.mu.Unlock()

	log.Printf("Attempting agent restart (%d/%d)", g.restartCount, g.config.MaxRestartAttempts)
	g.sendAgentStatus(StatusRestarting, agentType, "")

	// Brief delay before restart
	time.Sleep(time.Second)

	g.mu.Lock()
	if err := g.startAgent(ctx, agentType, cred); err != nil {
		g.mu.Unlock()
		log.Printf("Agent restart failed: %v", err)
		g.sendAgentStatus(StatusError, agentType, err.Error())
		return
	}
	g.mu.Unlock()

	g.sendAgentStatus(StatusReady, agentType, "")
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
	}
}

// writeRawJSON writes raw JSON bytes to the WebSocket.
func (g *Gateway) writeRawJSON(data []byte) {
	g.writeMu.Lock()
	defer g.writeMu.Unlock()
	if err := g.conn.WriteMessage(websocket.TextMessage, data); err != nil {
		log.Printf("Failed to write raw message to WebSocket: %v", err)
	}
}

// stopCurrentAgentLocked stops the current agent process. Must hold g.mu.
func (g *Gateway) stopCurrentAgentLocked() {
	if g.process != nil {
		_ = g.process.Stop()
		g.process = nil
	}
	g.acpConn = nil
}

// cleanup stops any running agent process.
func (g *Gateway) cleanup() {
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
	// Forward permission request to browser
	data, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "permission/request",
		"params":  params,
	})
	if err != nil {
		return acpsdk.RequestPermissionResponse{}, fmt.Errorf("failed to marshal permission request: %w", err)
	}
	c.gateway.writeRawJSON(data)

	// For now, auto-approve by selecting the first "allow" option.
	// In a full implementation, this would wait for the browser's response
	// via a channel-based mechanism.
	if len(params.Options) > 0 {
		return acpsdk.RequestPermissionResponse{
			Outcome: acpsdk.NewRequestPermissionOutcomeSelected(params.Options[0].OptionId),
		}, nil
	}
	return acpsdk.RequestPermissionResponse{
		Outcome: acpsdk.NewRequestPermissionOutcomeCancelled(),
	}, nil
}

func (c *gatewayClient) ReadTextFile(_ context.Context, _ acpsdk.ReadTextFileRequest) (acpsdk.ReadTextFileResponse, error) {
	return acpsdk.ReadTextFileResponse{}, fmt.Errorf("ReadTextFile not supported by gateway")
}

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