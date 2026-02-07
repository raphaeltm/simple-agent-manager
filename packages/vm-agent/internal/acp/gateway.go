package acp

import (
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

// NewGateway creates a new ACP gateway for a WebSocket connection.
func NewGateway(conn *websocket.Conn, cfg GatewayConfig) *Gateway {
	return &Gateway{
		config: cfg,
		conn:   conn,
	}
}

// Run starts the gateway's main loop, handling WebSocket messages.
// It blocks until the WebSocket connection is closed or an unrecoverable error occurs.
func (g *Gateway) Run(ctx context.Context) {
	defer g.cleanup()

	for {
		_, message, err := g.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("ACP WebSocket error: %v", err)
			}
			return
		}

		if g.config.OnActivity != nil {
			g.config.OnActivity()
		}

		isControl, controlType := ParseWebSocketMessage(message)
		if isControl && controlType == MsgSelectAgent {
			var selectMsg SelectAgentMessage
			if err := json.Unmarshal(message, &selectMsg); err != nil {
				log.Printf("Invalid select_agent message: %v", err)
				continue
			}
			g.handleSelectAgent(ctx, selectMsg.AgentType)
		} else {
			// Forward ACP JSON-RPC message to agent stdin
			g.forwardToAgent(message)
		}
	}
}

// handleSelectAgent stops the current agent (if any) and starts a new one.
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

	// Fetch API key from control plane
	apiKey, err := g.fetchAgentKey(ctx, agentType)
	if err != nil {
		errMsg := fmt.Sprintf("Failed to fetch API key for %s — check Settings", agentType)
		log.Printf("Agent key fetch failed: %v", err)
		g.sendAgentStatus(StatusError, agentType, errMsg)
		return
	}

	// Start the agent process
	if err := g.startAgent(ctx, agentType, apiKey); err != nil {
		log.Printf("Agent start failed: %v", err)
		g.sendAgentStatus(StatusError, agentType, err.Error())
		return
	}

	g.sendAgentStatus(StatusReady, agentType, "")
}

// startAgent spawns the agent process and sets up the ACP connection.
func (g *Gateway) startAgent(ctx context.Context, agentType, apiKey string) error {
	// Resolve container ID
	containerID, err := g.config.ContainerResolver()
	if err != nil {
		return fmt.Errorf("failed to discover devcontainer: %w", err)
	}

	// Look up agent command and args from well-known agent definitions
	acpCommand, acpArgs, envVarName := getAgentCommandInfo(agentType)

	process, err := StartProcess(ProcessConfig{
		ContainerID:   containerID,
		ContainerUser: g.config.ContainerUser,
		AcpCommand:    acpCommand,
		AcpArgs:       acpArgs,
		EnvVars:       []string{fmt.Sprintf("%s=%s", envVarName, apiKey)},
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
	go g.monitorProcessExit(ctx, process, agentType, apiKey)

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
func (g *Gateway) monitorProcessExit(ctx context.Context, process *AgentProcess, agentType, apiKey string) {
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

	// Detect rapid exit — likely an auth error (invalid/expired API key)
	uptime := time.Since(process.startTime)
	if uptime < 5*time.Second && err != nil {
		g.process = nil
		g.acpConn = nil
		g.mu.Unlock()
		errMsg := fmt.Sprintf("API key for %s may be invalid or expired — update it in Settings", agentType)
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
	if err := g.startAgent(ctx, agentType, apiKey); err != nil {
		g.mu.Unlock()
		log.Printf("Agent restart failed: %v", err)
		g.sendAgentStatus(StatusError, agentType, err.Error())
		return
	}
	g.mu.Unlock()

	g.sendAgentStatus(StatusReady, agentType, "")
}

// forwardToAgent sends a raw WebSocket message to the agent's stdin as NDJSON.
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

// fetchAgentKey retrieves the decrypted agent API key from the control plane.
func (g *Gateway) fetchAgentKey(ctx context.Context, agentType string) (string, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/agent-key", g.config.ControlPlaneURL, g.config.WorkspaceID)

	body, err := json.Marshal(map[string]string{"agentType": agentType})
	if err != nil {
		return "", fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", url, byteReader(body))
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+g.config.CallbackToken)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to fetch agent key: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return "", fmt.Errorf("no API key configured for %s", agentType)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("control plane returned status %d", resp.StatusCode)
	}

	var result struct {
		APIKey string `json:"apiKey"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("failed to decode response: %w", err)
	}

	if result.APIKey == "" {
		return "", fmt.Errorf("empty API key returned for %s", agentType)
	}

	return result.APIKey, nil
}

type byteReaderImpl struct {
	data []byte
	pos  int
}

func byteReader(data []byte) *byteReaderImpl {
	return &byteReaderImpl{data: data}
}

func (r *byteReaderImpl) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	n := copy(p, r.data[r.pos:])
	r.pos += n
	return n, nil
}

func (r *byteReaderImpl) Close() error {
	return nil
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
	// Not supported by the gateway — agents handle file operations themselves
	return acpsdk.ReadTextFileResponse{}, fmt.Errorf("ReadTextFile not supported by gateway")
}

func (c *gatewayClient) WriteTextFile(_ context.Context, _ acpsdk.WriteTextFileRequest) (acpsdk.WriteTextFileResponse, error) {
	return acpsdk.WriteTextFileResponse{}, fmt.Errorf("WriteTextFile not supported by gateway")
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

// getAgentCommandInfo returns the ACP command, args, and env var name for a given agent type.
// These match the agent catalog defined in packages/shared/src/agents.ts.
func getAgentCommandInfo(agentType string) (command string, args []string, envVarName string) {
	switch agentType {
	case "claude-code":
		return "claude-code-acp", nil, "ANTHROPIC_API_KEY"
	case "openai-codex":
		return "codex-acp", nil, "OPENAI_API_KEY"
	case "google-gemini":
		return "gemini", []string{"--experimental-acp"}, "GEMINI_API_KEY"
	default:
		return agentType, nil, "API_KEY"
	}
}
