package acp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/gorilla/websocket"
)

// SessionHostStatus represents the lifecycle state of a SessionHost.
type SessionHostStatus string

const (
	HostIdle      SessionHostStatus = "idle"      // No agent selected yet
	HostStarting  SessionHostStatus = "starting"  // Agent being initialized
	HostReady     SessionHostStatus = "ready"     // Agent ready for prompts
	HostPrompting SessionHostStatus = "prompting" // Prompt in progress
	HostError     SessionHostStatus = "error"     // Agent in error state
	HostStopped   SessionHostStatus = "stopped"   // Explicitly stopped
)

const (
	// DefaultPromptTimeout bounds how long a single ACP Prompt call can run.
	DefaultPromptTimeout = 60 * time.Minute
	// DefaultPromptCancelGracePeriod is how long we wait after cancel before
	// force-stopping an unresponsive agent process.
	DefaultPromptCancelGracePeriod = 5 * time.Second
)

// DefaultMessageBufferSize is the default maximum number of messages buffered
// per session for late-join replay. Override via ACP_MESSAGE_BUFFER_SIZE.
const DefaultMessageBufferSize = 5000

// DefaultViewerSendBuffer is the default channel buffer size per viewer.
// Override via ACP_VIEWER_SEND_BUFFER.
const DefaultViewerSendBuffer = 256

// SessionHostConfig holds configuration for a SessionHost.
// It extends GatewayConfig with multi-viewer settings.
type SessionHostConfig struct {
	GatewayConfig

	// MessageBufferSize is the maximum number of messages to buffer for
	// late-join replay. When the buffer is full, oldest messages are evicted.
	MessageBufferSize int

	// ViewerSendBuffer is the channel buffer size per viewer. If a viewer's
	// channel is full, messages are dropped for that viewer.
	ViewerSendBuffer int
}

// BufferedMessage holds a single message in the replay buffer.
type BufferedMessage struct {
	Data      []byte
	SeqNum    uint64
	Timestamp time.Time
}

// Viewer represents a single WebSocket connection to a SessionHost.
type Viewer struct {
	ID     string
	conn   *websocket.Conn
	sendCh chan []byte
	done   chan struct{}
	once   sync.Once
}

// Done returns a channel that is closed when the viewer's write pump exits.
// Used by the Gateway to detect write failures and exit its read loop promptly.
func (v *Viewer) Done() <-chan struct{} {
	return v.done
}

// SessionHost manages a single ACP agent session independently of any
// browser WebSocket connection. It owns the agent process, the ACP SDK
// connection, and a message buffer for late-join replay.
//
// Multiple WebSocket connections (viewers) can attach simultaneously.
// The agent process lives until Stop() is called explicitly.
type SessionHost struct {
	config SessionHostConfig

	// Agent state (guarded by mu)
	mu             sync.RWMutex
	process        *AgentProcess
	acpConn        *acpsdk.ClientSideConnection
	agentType      string
	sessionID      acpsdk.SessionId
	restartCount   int
	permissionMode string
	status         SessionHostStatus
	statusErr      string

	// Viewers (guarded by viewerMu)
	viewerMu sync.RWMutex
	viewers  map[string]*Viewer

	// Message buffer for late-join replay (guarded by bufMu)
	bufMu      sync.RWMutex
	messageBuf []BufferedMessage
	seqCounter uint64

	// Prompt lifecycle state.
	// promptMu guards promptInFlight (serialization gate only).
	promptMu       sync.Mutex
	promptInFlight bool
	promptSeq      uint64
	// promptCancelMu guards promptCancel independently from promptMu so that
	// CancelPrompt() can read it without waiting for Prompt() to finish.
	promptCancelMu sync.Mutex
	// promptCancel cancels the in-flight Prompt() context. Protected by promptCancelMu.
	promptCancel context.CancelFunc
	// activePromptID identifies the in-flight prompt associated with promptCancel.
	// Protected by promptCancelMu.
	activePromptID uint64

	// Stderr collection
	stderrMu  sync.Mutex
	stderrBuf strings.Builder

	// Auto-suspend timer (guarded by viewerMu)
	suspendTimer *time.Timer

	// Lifecycle
	ctx    context.Context
	cancel context.CancelFunc
}

// NewSessionHost creates a new SessionHost for the given session.
// The host starts in HostIdle status. Call SelectAgent to start an agent.
func NewSessionHost(config SessionHostConfig) *SessionHost {
	if config.MessageBufferSize <= 0 {
		config.MessageBufferSize = DefaultMessageBufferSize
	}
	if config.ViewerSendBuffer <= 0 {
		config.ViewerSendBuffer = DefaultViewerSendBuffer
	}

	ctx, cancel := context.WithCancel(context.Background())

	return &SessionHost{
		config:     config,
		status:     HostIdle,
		viewers:    make(map[string]*Viewer),
		messageBuf: make([]BufferedMessage, 0, 256),
		ctx:        ctx,
		cancel:     cancel,
	}
}

// Status returns the current status of the SessionHost.
func (h *SessionHost) Status() SessionHostStatus {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.status
}

// AgentType returns the current agent type, or empty string if no agent selected.
func (h *SessionHost) AgentType() string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.agentType
}

// ContainerWorkDir returns the configured working directory for this session host.
func (h *SessionHost) ContainerWorkDir() string {
	return h.config.ContainerWorkDir
}

// ViewerCount returns the number of active viewers.
func (h *SessionHost) ViewerCount() int {
	h.viewerMu.RLock()
	defer h.viewerMu.RUnlock()
	return len(h.viewers)
}

// AttachViewer registers a new WebSocket connection as a viewer of this session.
// It sends the current session state, replays all buffered messages, then signals
// replay completion. Returns nil if the session is stopped.
func (h *SessionHost) AttachViewer(id string, conn *websocket.Conn) *Viewer {
	h.mu.RLock()
	if h.status == HostStopped {
		h.mu.RUnlock()
		return nil
	}
	currentStatus := h.status
	currentAgentType := h.agentType
	currentErr := h.statusErr
	h.mu.RUnlock()

	viewer := &Viewer{
		ID:     id,
		conn:   conn,
		sendCh: make(chan []byte, h.config.ViewerSendBuffer),
		done:   make(chan struct{}),
	}

	// Start the viewer's write pump goroutine
	go h.viewerWritePump(viewer)

	// Register the viewer and cancel any pending auto-suspend timer.
	h.viewerMu.Lock()
	h.viewers[id] = viewer
	if h.suspendTimer != nil {
		h.suspendTimer.Stop()
		h.suspendTimer = nil
		slog.Info("SessionHost: auto-suspend timer cancelled (viewer attached)", "sessionID", h.config.SessionID)
	}
	h.viewerMu.Unlock()

	slog.Info("SessionHost: viewer attached", "sessionID", h.config.SessionID, "viewerID", id, "totalViewers", h.ViewerCount())

	// Send current session state
	h.sendToViewerPriority(viewer, h.marshalSessionState(currentStatus, currentAgentType, currentErr))

	// Replay buffered messages
	h.replayToViewer(viewer)

	// Signal replay complete
	h.sendToViewerPriority(viewer, h.marshalControl(MsgSessionReplayDone, nil))

	// Send a post-replay authoritative state snapshot with replayCount=0.
	// This closes the race where prompt status changes during replay and the
	// initial pre-replay snapshot becomes stale. replayCount MUST be 0 because
	// the replay has already been delivered — a non-zero value would cause the
	// browser to re-enter replay mode, calling prepareForReplay() which wipes
	// all just-replayed messages.
	finalStatus, finalAgentType, finalErr := h.currentSessionState()
	h.sendToViewerPriority(viewer, h.marshalSessionStateWithReplayCount(finalStatus, finalAgentType, finalErr, 0))

	return viewer
}

// DetachViewer removes a viewer from the session. This does NOT stop the agent.
// When the last viewer disconnects and IdleSuspendTimeout > 0, an auto-suspend
// timer is started. The timer is cancelled if a viewer attaches before it fires.
func (h *SessionHost) DetachViewer(viewerID string) {
	h.viewerMu.Lock()
	viewer, ok := h.viewers[viewerID]
	if ok {
		delete(h.viewers, viewerID)
	}
	remainingViewers := len(h.viewers)

	// Start auto-suspend timer when last viewer disconnects.
	if remainingViewers == 0 && h.config.IdleSuspendTimeout > 0 && h.suspendTimer == nil {
		timeout := h.config.IdleSuspendTimeout
		h.suspendTimer = time.AfterFunc(timeout, func() {
			h.autoSuspend()
		})
		slog.Info("SessionHost: auto-suspend timer started", "sessionID", h.config.SessionID, "timeout", timeout)
	}
	h.viewerMu.Unlock()

	if ok && viewer != nil {
		viewer.once.Do(func() { close(viewer.done) })
		slog.Info("SessionHost: viewer detached", "sessionID", h.config.SessionID, "viewerID", viewerID, "totalViewers", remainingViewers)
	}
}

// autoSuspend is called by the suspend timer. It re-checks conditions before
// suspending to avoid interrupting work that started after the timer was set.
func (h *SessionHost) autoSuspend() {
	// Re-check conditions under lock: no viewers and not prompting.
	// Hold viewerMu across both checks to prevent races with DetachViewer.
	h.viewerMu.Lock()
	h.suspendTimer = nil // Timer has fired, clear reference.
	if len(h.viewers) > 0 {
		h.viewerMu.Unlock()
		slog.Info("SessionHost: auto-suspend aborted (viewers present)", "sessionID", h.config.SessionID)
		return
	}

	// Check prompting status while still holding viewerMu to prevent race
	// where a viewer detaches and also tries to start a timer.
	if h.IsPrompting() {
		// Re-arm the timer without releasing the lock.
		if h.suspendTimer == nil {
			h.suspendTimer = time.AfterFunc(h.config.IdleSuspendTimeout, func() {
				h.autoSuspend()
			})
		}
		h.viewerMu.Unlock()
		slog.Info("SessionHost: auto-suspend deferred (prompt in progress)", "sessionID", h.config.SessionID)
		return
	}
	h.viewerMu.Unlock()

	slog.Info("SessionHost: auto-suspending idle viewerless session", "sessionID", h.config.SessionID)
	h.reportLifecycle("info", "SessionHost auto-suspending (idle, no viewers)", map[string]interface{}{
		"sessionId": h.config.SessionID,
	})

	acpSessionID, agentType := h.Suspend()

	// Notify the server so it can update the session status.
	if h.config.OnSuspend != nil {
		h.config.OnSuspend(h.config.WorkspaceID, h.config.SessionID)
	}

	h.reportEvent("info", "agent_session.auto_suspended", "Session auto-suspended (idle, no viewers)", map[string]interface{}{
		"sessionId":    h.config.SessionID,
		"acpSessionId": acpSessionID,
		"agentType":    agentType,
	})
}

// SelectAgent handles agent selection requests from a browser.
// It fetches credentials, installs the binary, starts the process,
// and initializes the ACP session.
func (h *SessionHost) SelectAgent(ctx context.Context, agentType string) {
	h.mu.Lock()

	slog.Info("SessionHost: agent selection requested", "sessionID", h.config.SessionID, "agentType", agentType)

	// Capture previous ACP session ID before stopping the agent.
	previousAcpSessionID := ""
	previousAgentType := h.agentType
	if h.sessionID != "" {
		previousAcpSessionID = string(h.sessionID)
	}
	if previousAcpSessionID == "" && h.config.PreviousAcpSessionID != "" {
		previousAcpSessionID = h.config.PreviousAcpSessionID
		h.config.PreviousAcpSessionID = ""
	}
	if previousAgentType == "" && h.config.PreviousAgentType != "" {
		previousAgentType = h.config.PreviousAgentType
		h.config.PreviousAgentType = ""
	}

	// Stop current agent if running
	if h.process != nil {
		h.stopCurrentAgentLocked()
	}

	h.agentType = agentType
	h.restartCount = 0
	h.status = HostStarting
	h.statusErr = ""
	h.mu.Unlock()

	// Broadcast starting status
	h.broadcastAgentStatus(StatusStarting, agentType, "")

	// Reset stderr buffer
	h.stderrMu.Lock()
	h.stderrBuf.Reset()
	h.stderrMu.Unlock()

	h.reportLifecycle("info", "Agent selection started", map[string]interface{}{
		"agentType":            agentType,
		"previousAcpSessionID": previousAcpSessionID,
		"previousAgentType":    previousAgentType,
		"sessionId":            h.config.SessionID,
	})

	// Fetch credential from control plane
	cred, err := h.fetchAgentKey(ctx, agentType)
	if err != nil {
		errMsg := fmt.Sprintf("Failed to fetch credential for %s — check Settings", agentType)
		slog.Error("Agent credential fetch failed", "error", err)
		h.setStatus(HostError, errMsg)
		h.broadcastAgentStatus(StatusError, agentType, errMsg)
		h.reportAgentError(agentType, "agent_key_fetch", errMsg, err.Error())
		return
	}
	h.reportLifecycle("info", "Agent credential fetched", map[string]interface{}{
		"agentType":      agentType,
		"credentialKind": cred.credentialKind,
	})

	// Ensure the ACP adapter binary is installed
	info := getAgentCommandInfo(agentType, cred.credentialKind)
	if err := h.ensureAgentInstalled(ctx, info); err != nil {
		errMsg := fmt.Sprintf("Failed to install %s: %v", info.command, err)
		slog.Error("Agent install failed", "error", err)
		h.setStatus(HostError, errMsg)
		h.broadcastAgentStatus(StatusError, agentType, errMsg)
		h.reportAgentError(agentType, "agent_install", errMsg, err.Error())
		return
	}
	h.reportLifecycle("info", "Agent binary verified/installed", map[string]interface{}{
		"agentType": agentType,
		"command":   info.command,
	})

	// Fetch user's agent settings (non-blocking)
	settings := h.fetchAgentSettings(ctx, agentType)
	if settings != nil {
		slog.Info("Agent settings loaded", "model", settings.Model, "permissionMode", settings.PermissionMode)
	}

	// Only attempt LoadSession if reconnecting with the same agent type
	loadSessionID := ""
	if previousAcpSessionID != "" && previousAgentType == agentType {
		loadSessionID = previousAcpSessionID
		slog.Info("ACP: will attempt LoadSession", "sessionID", loadSessionID)
		h.reportLifecycle("info", "LoadSession will be attempted", map[string]interface{}{
			"agentType":            agentType,
			"previousAcpSessionID": previousAcpSessionID,
		})
	} else if previousAcpSessionID != "" {
		slog.Info("ACP: skipping LoadSession, agent type mismatch", "previousAgentType", previousAgentType, "requestedAgentType", agentType)
		h.reportLifecycle("info", "LoadSession skipped: agent type mismatch", map[string]interface{}{
			"previousAgentType": previousAgentType,
			"requestedAgent":    agentType,
		})
	}

	// Start the agent process
	h.mu.Lock()
	if err := h.startAgent(ctx, agentType, cred, settings, loadSessionID); err != nil {
		h.status = HostError
		h.statusErr = err.Error()
		h.mu.Unlock()
		slog.Error("Agent start failed", "error", err)
		h.broadcastAgentStatus(StatusError, agentType, err.Error())
		h.reportAgentError(agentType, "agent_start", err.Error(), "")
		return
	}
	h.status = HostReady
	h.statusErr = ""
	h.mu.Unlock()

	h.reportLifecycle("info", "Agent ready", map[string]interface{}{
		"agentType": agentType,
		"sessionId": h.config.SessionID,
	})
	h.reportEvent("info", "agent.ready", fmt.Sprintf("Agent %s is ready", agentType), map[string]interface{}{
		"agentType": agentType,
	})
	h.broadcastAgentStatus(StatusReady, agentType, "")
}

// HandlePrompt routes a session/prompt request through the ACP SDK.
// Only one prompt runs at a time — concurrent requests are serialized.
func (h *SessionHost) HandlePrompt(ctx context.Context, reqID json.RawMessage, params json.RawMessage, viewerID string) {
	h.mu.RLock()
	acpConn := h.acpConn
	sessionID := h.sessionID
	h.mu.RUnlock()

	if acpConn == nil || sessionID == acpsdk.SessionId("") {
		slog.Warn("Prompt request received but no ACP session active")
		h.reportLifecycle("warn", "Prompt received but no ACP session active", nil)
		h.sendJSONRPCErrorToViewer(viewerID, reqID, -32603, "No ACP session active")
		return
	}

	// Parse the prompt content
	var promptParams struct {
		Prompt []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"prompt"`
	}
	if err := json.Unmarshal(params, &promptParams); err != nil {
		slog.Error("Failed to parse prompt params", "error", err)
		h.sendJSONRPCErrorToViewer(viewerID, reqID, -32602, "Invalid prompt params")
		return
	}

	var blocks []acpsdk.ContentBlock
	var firstTextContent string
	for _, p := range promptParams.Prompt {
		if p.Type == "text" && p.Text != "" {
			blocks = append(blocks, acpsdk.TextBlock(p.Text))
			if firstTextContent == "" {
				firstTextContent = p.Text
			}
		}
	}
	if len(blocks) == 0 {
		h.sendJSONRPCErrorToViewer(viewerID, reqID, -32602, "Empty prompt")
		return
	}

	// Capture the last user message for session discoverability in history UI.
	if firstTextContent != "" {
		h.persistLastPrompt(firstTextContent)
	}

	// Inject synthetic user_message_chunk notifications into the broadcast
	// stream. Claude Code does NOT echo user input as session/update during
	// live prompts — it only sends user_message_chunk during LoadSession
	// replay. Without this, user messages are missing from both the replay
	// buffer (page reload shows no user bubbles) and the message reporter
	// (Durable Object has no user messages).
	for _, block := range blocks {
		notif := acpsdk.SessionNotification{
			SessionId: sessionID,
			Update:    acpsdk.UpdateUserMessage(block),
		}
		data, marshalErr := json.Marshal(map[string]interface{}{
			"jsonrpc": "2.0",
			"method":  "session/update",
			"params":  notif,
		})
		if marshalErr != nil {
			slog.Error("Failed to marshal synthetic user_message_chunk", "error", marshalErr)
			continue
		}
		h.broadcastMessage(data)

		// Enqueue to message reporter for Durable Object persistence.
		if h.config.MessageReporter != nil {
			for _, m := range ExtractMessages(notif) {
				if err := h.config.MessageReporter.Enqueue(MessageReportEntry{
					MessageID:    m.MessageID,
					Role:         m.Role,
					Content:      m.Content,
					ToolMetadata: m.ToolMetadata,
				}); err != nil {
					slog.Warn("messagereport: enqueue synthetic user message failed (non-blocking)",
						"messageId", m.MessageID, "error", err)
				}
			}
		}
	}

	// Cancel any pending auto-suspend timer — agent is actively working.
	h.viewerMu.Lock()
	if h.suspendTimer != nil {
		h.suspendTimer.Stop()
		h.suspendTimer = nil
		slog.Info("SessionHost: auto-suspend timer cancelled (prompt started)", "sessionID", h.config.SessionID)
	}
	h.viewerMu.Unlock()

	promptTimeout := h.promptTimeout()
	promptCtx, promptCancel := context.WithTimeout(ctx, promptTimeout)
	promptID, ok := h.beginPrompt(promptCancel)
	if !ok {
		promptCancel()
		h.sendJSONRPCErrorToViewer(viewerID, reqID, -32603, "Prompt already in progress")
		return
	}
	defer func() {
		h.endPrompt(promptID)
		promptCancel() // release context resources
	}()

	// Watchdog: if Prompt() ignores deadline/cancel, force-stop the agent.
	promptDone := make(chan struct{})
	go h.watchPromptTimeout(promptID, promptCtx, promptDone, viewerID, reqID, promptTimeout)
	defer close(promptDone)

	// Update status to prompting
	h.setStatus(HostPrompting, "")
	h.broadcastControl(MsgSessionPrompting, nil)

	slog.Info("ACP: sending Prompt", "sessionID", string(sessionID), "blockCount", len(blocks))
	promptStart := time.Now()
	h.reportLifecycle("info", "ACP Prompt started", map[string]interface{}{
		"acpSessionId": string(sessionID),
		"blockCount":   len(blocks),
		"viewerId":     viewerID,
	})

	// Prompt() is blocking — session/update notifications flow via sessionHostClient.SessionUpdate()
	resp, err := acpConn.Prompt(promptCtx, acpsdk.PromptRequest{
		SessionId: sessionID,
		Prompt:    blocks,
	})

	// If the prompt was force-stopped while Prompt() was blocked, ignore late completion.
	if !h.isPromptActive(promptID) {
		return
	}

	// Update status back to ready
	h.setStatus(HostReady, "")
	h.broadcastControl(MsgSessionPromptDone, nil)

	if err != nil {
		errMsg := fmt.Sprintf("Prompt failed: %v", err)
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(promptCtx.Err(), context.DeadlineExceeded) {
			errMsg = fmt.Sprintf("Prompt timed out after %s", promptTimeout)
		}
		slog.Error("ACP Prompt failed", "error", err)
		h.reportLifecycle("warn", "ACP Prompt failed", map[string]interface{}{
			"error":    errMsg,
			"duration": time.Since(promptStart).String(),
		})
		// Broadcast error to all viewers so all tabs see it
		errResp := h.marshalJSONRPCError(reqID, -32603, errMsg)
		h.broadcastMessage(errResp)

		// Fire prompt completion callback (error path)
		if cb := h.config.OnPromptComplete; cb != nil {
			go cb("error", err)
		}
		return
	}

	slog.Info("ACP: Prompt completed", "stopReason", string(resp.StopReason))
	h.reportLifecycle("info", "ACP Prompt completed", map[string]interface{}{
		"stopReason": string(resp.StopReason),
		"duration":   time.Since(promptStart).String(),
	})

	// Broadcast the prompt response to all viewers
	result, _ := json.Marshal(resp)
	response := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(reqID),
		"result":  json.RawMessage(result),
	}
	data, _ := json.Marshal(response)
	h.broadcastMessage(data)

	// Fire prompt completion callback (success path)
	if cb := h.config.OnPromptComplete; cb != nil {
		go cb(string(resp.StopReason), nil)
	}
}

// CancelPrompt cancels the currently running Prompt() call, if any.
// This is safe to call from any goroutine. If no prompt is in flight,
// it's a no-op. The cancel function is guarded by promptCancelMu
// (separate from promptMu) so we never deadlock with HandlePrompt.
func (h *SessionHost) CancelPrompt() {
	h.promptCancelMu.Lock()
	cancelFn := h.promptCancel
	promptID := h.activePromptID
	h.promptCancelMu.Unlock()

	if cancelFn == nil {
		slog.Info("CancelPrompt: no prompt in flight")
		return
	}

	slog.Info("CancelPrompt: cancelling in-flight prompt")
	h.reportLifecycle("info", "Prompt cancel requested", nil)
	cancelFn()

	grace := h.promptCancelGracePeriod()
	if grace <= 0 {
		return
	}

	go func(id uint64, wait time.Duration) {
		timer := time.NewTimer(wait)
		defer timer.Stop()
		<-timer.C
		h.triggerPromptForceStopIfStuck(id, fmt.Sprintf("Prompt cancel grace elapsed after %s", wait))
	}(promptID, grace)
}

// ForwardToAgent sends a raw message to the agent's stdin.
func (h *SessionHost) ForwardToAgent(message []byte) {
	h.mu.RLock()
	process := h.process
	h.mu.RUnlock()

	if process == nil {
		slog.Warn("No agent process running, dropping message")
		return
	}

	data := append(message, '\n')
	if _, err := process.Stdin().Write(data); err != nil {
		slog.Error("Failed to write to agent stdin", "error", err)
	}
}

// Stop kills the agent process, disconnects all viewers, and marks the session
// as stopped. This is the only way to terminate the agent — browser disconnects
// do NOT call this.
func (h *SessionHost) Stop() {
	h.mu.Lock()
	if h.status == HostStopped {
		h.mu.Unlock()
		return
	}
	h.status = HostStopped
	h.statusErr = ""
	h.stopCurrentAgentLocked()
	h.mu.Unlock()

	// Cancel any pending auto-suspend timer.
	h.viewerMu.Lock()
	if h.suspendTimer != nil {
		h.suspendTimer.Stop()
		h.suspendTimer = nil
	}
	h.viewerMu.Unlock()

	h.cancel()

	h.reportLifecycle("info", "SessionHost stopped", map[string]interface{}{
		"sessionId": h.config.SessionID,
	})

	// Disconnect all viewers
	h.viewerMu.Lock()
	for id, viewer := range h.viewers {
		viewer.once.Do(func() { close(viewer.done) })
		_ = viewer.conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseGoingAway, "session stopped"),
			time.Now().Add(5*time.Second),
		)
		_ = viewer.conn.Close()
		delete(h.viewers, id)
	}
	h.viewerMu.Unlock()
}

// --- Internal: agent lifecycle (extracted from Gateway) ---

// startAgent spawns the agent process and sets up the ACP connection.
// Must hold h.mu when calling.
func (h *SessionHost) startAgent(ctx context.Context, agentType string, cred *agentCredential, settings *agentSettingsPayload, previousAcpSessionID string) error {
	containerID, err := h.config.ContainerResolver()
	if err != nil {
		return fmt.Errorf("failed to discover devcontainer: %w", err)
	}

	info := getAgentCommandInfo(agentType, cred.credentialKind)

	// Read SAM env vars (GH_TOKEN, SAM_WORKSPACE_ID, etc.) from the container's
	// /etc/sam/env file and inject them into the agent process. These are written
	// during bootstrap but aren't available to docker exec without explicit -e flags.
	envVars := ReadContainerEnvFiles(ctx, containerID)

	// If GH_TOKEN is missing or empty from the env files (e.g. token wasn't
	// available at provisioning time), fetch a fresh one from the control plane.
	if h.config.GitTokenFetcher != nil && !hasEnvVar(envVars, "GH_TOKEN") {
		if token, err := h.config.GitTokenFetcher(ctx); err == nil && token != "" {
			envVars = append(envVars, "GH_TOKEN="+token)
		} else if err != nil {
			slog.Debug("Failed to fetch GH_TOKEN for ACP session", "error", err)
		}
	}

	envVars = append(envVars, fmt.Sprintf("%s=%s", info.envVarName, cred.credential))
	if settings != nil && settings.Model != "" {
		modelEnv := getModelEnvVar(agentType)
		if modelEnv != "" {
			envVars = append(envVars, fmt.Sprintf("%s=%s", modelEnv, settings.Model))
			slog.Info("Agent model override", "envVar", modelEnv, "model", settings.Model)
		}
	}

	if settings != nil && settings.PermissionMode != "" {
		h.permissionMode = settings.PermissionMode
	} else {
		h.permissionMode = "default"
	}

	process, err := StartProcess(ProcessConfig{
		ContainerID:   containerID,
		ContainerUser: h.config.ContainerUser,
		AcpCommand:    info.command,
		AcpArgs:       info.args,
		EnvVars:       envVars,
		WorkDir:       h.config.ContainerWorkDir,
	})
	if err != nil {
		return fmt.Errorf("failed to start agent process: %w", err)
	}

	h.process = process

	client := &sessionHostClient{host: h}
	h.acpConn = acpsdk.NewClientSideConnection(client, process.Stdin(), process.Stdout())

	go h.monitorStderr(process)
	go h.monitorProcessExit(ctx, process, agentType, cred, settings)

	// Initialize the ACP protocol handshake
	initTimeout := time.Duration(h.config.InitTimeoutMs) * time.Millisecond
	if initTimeout == 0 {
		initTimeout = 30 * time.Second
	}
	initCtx, initCancel := context.WithTimeout(ctx, initTimeout)
	defer initCancel()

	slog.Info("ACP: sending Initialize request")
	h.reportLifecycle("info", "ACP Initialize started", map[string]interface{}{
		"agentType": agentType,
	})
	initResp, err := h.acpConn.Initialize(initCtx, acpsdk.InitializeRequest{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
		ClientCapabilities: acpsdk.ClientCapabilities{
			Fs: acpsdk.FileSystemCapability{ReadTextFile: true, WriteTextFile: true},
		},
	})
	if err != nil {
		h.reportLifecycle("warn", "ACP Initialize failed", map[string]interface{}{
			"agentType": agentType,
			"error":     err.Error(),
		})
		return fmt.Errorf("ACP initialize failed: %w", err)
	}
	slog.Info("ACP: Initialize succeeded", "loadSession", initResp.AgentCapabilities.LoadSession)
	h.reportLifecycle("info", "ACP Initialize succeeded", map[string]interface{}{
		"agentType":           agentType,
		"supportsLoadSession": initResp.AgentCapabilities.LoadSession,
	})

	// Attempt LoadSession if we have a previous session ID and the agent supports it
	if previousAcpSessionID != "" && initResp.AgentCapabilities.LoadSession {
		slog.Info("ACP: attempting LoadSession with previous session", "previousAcpSessionID", previousAcpSessionID)
		h.reportLifecycle("info", "ACP LoadSession started", map[string]interface{}{
			"agentType":            agentType,
			"previousAcpSessionID": previousAcpSessionID,
		})
		h.reportEvent("info", "agent.load_session", "Restoring previous conversation", map[string]interface{}{
			"previousAcpSessionID": previousAcpSessionID,
		})
		_, loadErr := h.acpConn.LoadSession(initCtx, acpsdk.LoadSessionRequest{
			SessionId:  acpsdk.SessionId(previousAcpSessionID),
			Cwd:        h.config.ContainerWorkDir,
			McpServers: []acpsdk.McpServer{},
		})
		if loadErr == nil {
			h.sessionID = acpsdk.SessionId(previousAcpSessionID)
			slog.Info("ACP: LoadSession succeeded", "sessionID", previousAcpSessionID)
			h.reportLifecycle("info", "ACP LoadSession succeeded", map[string]interface{}{
				"agentType":    agentType,
				"acpSessionId": previousAcpSessionID,
			})
			h.reportEvent("info", "agent.load_session_ok", "Previous conversation restored", map[string]interface{}{
				"acpSessionId": previousAcpSessionID,
			})
			h.persistAcpSessionID(agentType)
			h.applySessionSettings(initCtx, settings)
			return nil
		}
		slog.Warn("ACP: LoadSession failed, falling back to NewSession", "error", loadErr)
		h.reportLifecycle("warn", "ACP LoadSession failed, falling back to NewSession", map[string]interface{}{
			"agentType": agentType,
			"error":     loadErr.Error(),
		})
		h.reportEvent("warn", "agent.load_session_failed", "Could not restore conversation, starting fresh", map[string]interface{}{
			"error": loadErr.Error(),
		})
	} else if previousAcpSessionID != "" {
		slog.Info("ACP: agent does not support LoadSession, using NewSession instead")
		h.reportLifecycle("info", "Agent does not support LoadSession", map[string]interface{}{
			"agentType": agentType,
		})
	}

	slog.Info("ACP: sending NewSession request")
	h.reportLifecycle("info", "ACP NewSession started", map[string]interface{}{
		"agentType": agentType,
	})
	sessResp, err := h.acpConn.NewSession(initCtx, acpsdk.NewSessionRequest{
		Cwd:        h.config.ContainerWorkDir,
		McpServers: []acpsdk.McpServer{},
	})
	if err != nil {
		h.reportLifecycle("warn", "ACP NewSession failed", map[string]interface{}{
			"agentType": agentType,
			"error":     err.Error(),
		})
		return fmt.Errorf("ACP new session failed: %w", err)
	}
	h.sessionID = sessResp.SessionId
	slog.Info("ACP: NewSession succeeded", "sessionID", string(h.sessionID))
	h.reportLifecycle("info", "ACP NewSession succeeded", map[string]interface{}{
		"agentType":    agentType,
		"acpSessionId": string(h.sessionID),
	})
	h.persistAcpSessionID(agentType)
	h.applySessionSettings(initCtx, settings)

	return nil
}

// applySessionSettings calls SetSessionModel and SetSessionMode on the ACP
// connection. Both calls are non-fatal.
func (h *SessionHost) applySessionSettings(ctx context.Context, settings *agentSettingsPayload) {
	if settings == nil || h.acpConn == nil || h.sessionID == "" {
		return
	}

	if settings.Model != "" {
		slog.Info("ACP: setting session model", "model", settings.Model)
		if _, err := h.acpConn.SetSessionModel(ctx, acpsdk.SetSessionModelRequest{
			SessionId: h.sessionID,
			ModelId:   acpsdk.ModelId(settings.Model),
		}); err != nil {
			slog.Warn("ACP SetSessionModel failed (non-fatal)", "model", settings.Model, "error", err)
			h.reportLifecycle("warn", "ACP SetSessionModel failed", map[string]interface{}{
				"model": settings.Model,
				"error": err.Error(),
			})
		} else {
			slog.Info("ACP: session model set", "model", settings.Model)
			h.reportLifecycle("info", "ACP session model applied", map[string]interface{}{
				"model": settings.Model,
			})
		}
	}

	if settings.PermissionMode != "" && settings.PermissionMode != "default" {
		slog.Info("ACP: setting session mode", "mode", settings.PermissionMode)
		if _, err := h.acpConn.SetSessionMode(ctx, acpsdk.SetSessionModeRequest{
			SessionId: h.sessionID,
			ModeId:    acpsdk.SessionModeId(settings.PermissionMode),
		}); err != nil {
			slog.Warn("ACP SetSessionMode failed (non-fatal)", "mode", settings.PermissionMode, "error", err)
			h.reportLifecycle("warn", "ACP SetSessionMode failed", map[string]interface{}{
				"mode":  settings.PermissionMode,
				"error": err.Error(),
			})
		} else {
			slog.Info("ACP: session mode set", "mode", settings.PermissionMode)
			h.reportLifecycle("info", "ACP session mode applied", map[string]interface{}{
				"mode": settings.PermissionMode,
			})
		}
	}
}

// ensureAgentInstalled checks if the ACP adapter binary exists and installs it
// on-demand if missing.
func (h *SessionHost) ensureAgentInstalled(ctx context.Context, info agentCommandInfo) error {
	if info.installCmd == "" {
		return nil
	}

	containerID, err := h.config.ContainerResolver()
	if err != nil {
		return fmt.Errorf("failed to discover devcontainer: %w", err)
	}

	checkArgs := []string{"exec", containerID, "which", info.command}
	checkCmd := exec.CommandContext(ctx, "docker", checkArgs...)
	if err := checkCmd.Run(); err == nil {
		slog.Info("Agent binary is already installed", "command", info.command)
		return nil
	}

	h.broadcastAgentStatus(StatusInstalling, info.command, "")
	return installAgentBinary(ctx, containerID, info)
}

// monitorStderr reads the agent's stderr and collects it for error reporting.
func (h *SessionHost) monitorStderr(process *AgentProcess) {
	scanner := bufio.NewScanner(process.Stderr())
	for scanner.Scan() {
		line := scanner.Text()
		slog.Warn("Agent stderr", "line", line)
		h.stderrMu.Lock()
		if h.stderrBuf.Len() < 4096 {
			if h.stderrBuf.Len() > 0 {
				h.stderrBuf.WriteByte('\n')
			}
			h.stderrBuf.WriteString(line)
		}
		h.stderrMu.Unlock()
	}
}

func (h *SessionHost) getAndClearStderr() string {
	h.stderrMu.Lock()
	defer h.stderrMu.Unlock()
	s := h.stderrBuf.String()
	h.stderrBuf.Reset()
	return s
}

// monitorProcessExit detects agent crashes and attempts restart.
func (h *SessionHost) monitorProcessExit(ctx context.Context, process *AgentProcess, agentType string, cred *agentCredential, settings *agentSettingsPayload) {
	err := process.Wait()

	time.Sleep(100 * time.Millisecond)
	stderrOutput := h.getAndClearStderr()

	uptime := time.Since(process.startTime)
	exitInfo := "exit=0"
	if err != nil {
		exitInfo = fmt.Sprintf("exit=%v", err)
	}
	slog.Info("Agent process exited", "agentType", agentType, "uptime", uptime.Round(time.Millisecond), "exitInfo", exitInfo, "stderrBytes", len(stderrOutput))

	isRapidExit := uptime < 5*time.Second
	if isRapidExit {
		errMsg := fmt.Sprintf("Agent %s crashed on startup (exited in %v, %s)", agentType, uptime.Round(time.Millisecond), exitInfo)
		if stderrOutput != "" {
			errMsg = fmt.Sprintf("%s: %s", errMsg, truncate(stderrOutput, 500))
		}
		slog.Error("Agent rapid exit", "message", errMsg)
		h.reportAgentError(agentType, "agent_crash", errMsg, stderrOutput)
	}

	h.mu.Lock()
	if h.process != process {
		h.mu.Unlock()
		slog.Info("Agent process monitor: process replaced, skipping status/restart")
		return
	}

	if h.status == HostStopped {
		h.mu.Unlock()
		slog.Info("Agent process monitor: session stopped, skipping restart")
		return
	}

	if isRapidExit {
		h.process = nil
		h.acpConn = nil
		h.sessionID = ""
		h.status = HostError
		errMsg := fmt.Sprintf("Agent %s crashed on startup (exited in %v, %s)", agentType, uptime.Round(time.Millisecond), exitInfo)
		if stderrOutput != "" {
			errMsg = fmt.Sprintf("%s: %s", errMsg, truncate(stderrOutput, 500))
		}
		h.statusErr = errMsg
		h.mu.Unlock()
		h.broadcastAgentStatus(StatusError, agentType, errMsg)
		return
	}

	h.restartCount++
	maxRestarts := h.config.MaxRestartAttempts
	if maxRestarts == 0 {
		maxRestarts = 3
	}
	if h.restartCount > maxRestarts {
		slog.Error("Agent exceeded max restart attempts", "maxRestarts", maxRestarts)
		h.process = nil
		h.acpConn = nil
		h.sessionID = ""
		h.status = HostError
		crashMsg := "Agent crashed and could not be restarted"
		if stderrOutput != "" {
			crashMsg = fmt.Sprintf("%s: %s", crashMsg, truncate(stderrOutput, 500))
		}
		h.statusErr = crashMsg
		h.mu.Unlock()
		h.broadcastAgentStatus(StatusError, agentType, crashMsg)
		h.reportAgentError(agentType, "agent_max_restarts", crashMsg, stderrOutput)
		return
	}

	h.process = nil
	h.acpConn = nil
	h.sessionID = ""
	h.status = HostStarting
	h.mu.Unlock()

	slog.Info("Attempting agent restart", "attempt", h.restartCount, "maxRestarts", maxRestarts)
	h.broadcastAgentStatus(StatusRestarting, agentType, "")

	time.Sleep(time.Second)

	h.mu.Lock()
	if h.status == HostStopped {
		h.mu.Unlock()
		return
	}
	if err := h.startAgent(ctx, agentType, cred, settings, ""); err != nil {
		h.status = HostError
		h.statusErr = err.Error()
		h.mu.Unlock()
		slog.Error("Agent restart failed", "error", err)
		h.broadcastAgentStatus(StatusError, agentType, err.Error())
		h.reportAgentError(agentType, "agent_restart_failed", err.Error(), "")
		return
	}
	h.status = HostReady
	h.statusErr = ""
	h.mu.Unlock()

	h.broadcastAgentStatus(StatusReady, agentType, "")
}

// stopCurrentAgentLocked stops the current agent process. Must hold h.mu.
func (h *SessionHost) stopCurrentAgentLocked() {
	if h.process != nil {
		_ = h.process.Stop()
		h.process = nil
	}
	h.acpConn = nil
	h.sessionID = ""
}

// persistAcpSessionID saves the ACP session ID for reconnection support.
func (h *SessionHost) persistAcpSessionID(agentType string) {
	sessionID := string(h.sessionID)
	if sessionID == "" {
		return
	}

	if h.config.SessionManager != nil && h.config.SessionID != "" {
		if err := h.config.SessionManager.UpdateAcpSessionID(
			h.config.WorkspaceID, h.config.SessionID, sessionID, agentType,
		); err != nil {
			slog.Error("Failed to persist ACP session ID to session manager", "error", err)
		} else {
			slog.Info("ACP session ID persisted to session manager", "sessionID", sessionID)
		}
	}

	if h.config.TabStore != nil && h.config.SessionID != "" {
		if err := h.config.TabStore.UpdateTabAcpSessionID(h.config.SessionID, sessionID); err != nil {
			slog.Error("Failed to persist ACP session ID to tab store", "error", err)
		} else {
			slog.Info("ACP session ID persisted to tab store", "sessionID", sessionID)
		}
	}
}

// persistLastPrompt saves the last user message for session discoverability.
// Truncates to 200 characters to keep storage reasonable.
func (h *SessionHost) persistLastPrompt(text string) {
	const maxLen = 200
	if len(text) > maxLen {
		text = text[:maxLen]
	}

	if h.config.SessionLastPromptManager != nil && h.config.WorkspaceID != "" && h.config.SessionID != "" {
		if err := h.config.SessionLastPromptManager.UpdateLastPrompt(
			h.config.WorkspaceID, h.config.SessionID, text,
		); err != nil {
			slog.Error("Failed to persist last prompt to session manager", "error", err)
		}
	}

	if h.config.TabLastPromptStore != nil && h.config.SessionID != "" {
		if err := h.config.TabLastPromptStore.UpdateTabLastPrompt(h.config.SessionID, text); err != nil {
			slog.Error("Failed to persist last prompt to tab store", "error", err)
		}
	}
}

// Suspend stops the agent process and releases in-memory resources while
// preserving the AcpSessionID for later resumption via LoadSession.
// Unlike Stop(), the session is NOT marked as stopped — it enters a
// "suspended" state where the process is freed but context is recoverable.
//
// Returns the preserved AcpSessionID and agent type for the caller to
// use when transitioning the session status.
func (h *SessionHost) Suspend() (acpSessionID string, agentType string) {
	h.mu.Lock()
	if h.status == HostStopped {
		h.mu.Unlock()
		return "", ""
	}

	// Capture the session state we need to preserve before stopping.
	acpSessionID = string(h.sessionID)
	agentType = h.agentType

	// Stop the agent process to free resources.
	h.stopCurrentAgentLocked()

	// Mark the host as stopped so no further operations occur.
	h.status = HostStopped
	h.statusErr = ""
	h.mu.Unlock()

	h.cancel()

	h.reportLifecycle("info", "SessionHost suspended", map[string]interface{}{
		"sessionId":    h.config.SessionID,
		"acpSessionId": acpSessionID,
		"agentType":    agentType,
	})

	// Disconnect all viewers with a specific close reason.
	h.viewerMu.Lock()
	for id, viewer := range h.viewers {
		viewer.once.Do(func() { close(viewer.done) })
		_ = viewer.conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseGoingAway, "session suspended"),
			time.Now().Add(5*time.Second),
		)
		_ = viewer.conn.Close()
		delete(h.viewers, id)
	}
	h.viewerMu.Unlock()

	return acpSessionID, agentType
}

// IsPrompting returns true if a prompt is currently in flight.
// Used by the auto-suspend timer to avoid interrupting active work.
func (h *SessionHost) IsPrompting() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.status == HostPrompting
}

// --- Internal: message broadcasting ---

// appendMessage appends a message to the replay buffer.
func (h *SessionHost) appendMessage(data []byte) {
	// Append to buffer — sequence number assigned under lock to ensure
	// buffer ordering matches sequence ordering under concurrent writes.
	h.bufMu.Lock()
	seq := atomic.AddUint64(&h.seqCounter, 1)
	h.messageBuf = append(h.messageBuf, BufferedMessage{
		Data:      data,
		SeqNum:    seq,
		Timestamp: time.Now(),
	})
	// Evict oldest if over limit
	if len(h.messageBuf) > h.config.MessageBufferSize {
		excess := len(h.messageBuf) - h.config.MessageBufferSize
		h.messageBuf = h.messageBuf[excess:]
	}
	h.bufMu.Unlock()
}

// broadcastMessage appends a message to the buffer and sends it to all viewers.
func (h *SessionHost) broadcastMessage(data []byte) {
	h.broadcastMessageWithPriority(data, false)
}

func (h *SessionHost) broadcastMessageWithPriority(data []byte, priority bool) {
	h.appendMessage(data)
	// Fan out to all viewers
	h.viewerMu.RLock()
	for _, viewer := range h.viewers {
		if priority {
			h.sendToViewerPriority(viewer, data)
		} else {
			h.sendToViewer(viewer, data)
		}
	}
	h.viewerMu.RUnlock()
}

// broadcastAgentStatus broadcasts an agent_status control message to all viewers
// and buffers it for late-join replay.
func (h *SessionHost) broadcastAgentStatus(status AgentStatus, agentType, errMsg string) {
	msg := AgentStatusMessage{
		Type:      MsgAgentStatus,
		Status:    status,
		AgentType: agentType,
		Error:     errMsg,
	}
	data, _ := json.Marshal(msg)
	h.broadcastMessageWithPriority(data, true)
}

// broadcastControl broadcasts a control message to all viewers and buffers it.
func (h *SessionHost) broadcastControl(msgType ControlMessageType, extra map[string]interface{}) {
	data := h.marshalControl(msgType, extra)
	h.broadcastMessageWithPriority(data, true)
}

// replayToViewer sends all buffered messages to a newly attached viewer.
// Uses a blocking send with timeout to avoid silently dropping messages when
// the viewer's send channel fills faster than the write pump can drain it.
func (h *SessionHost) replayToViewer(viewer *Viewer) {
	h.bufMu.RLock()
	messages := make([]BufferedMessage, len(h.messageBuf))
	copy(messages, h.messageBuf)
	h.bufMu.RUnlock()

	dropped := 0
	for _, msg := range messages {
		if !h.sendToViewerWithTimeout(viewer, msg.Data, 5*time.Second) {
			dropped++
			break // viewer gone or persistently blocked — stop replay
		}
	}
	if dropped > 0 {
		slog.Warn("SessionHost: viewer replay aborted", "sessionID", h.config.SessionID, "viewerID", viewer.ID, "delivered", len(messages)-dropped, "total", len(messages))
	}
}

// sendToViewerWithTimeout sends a message with a blocking timeout.
// Returns true if sent, false if the viewer is gone or the timeout expired.
func (h *SessionHost) sendToViewerWithTimeout(viewer *Viewer, data []byte, timeout time.Duration) bool {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case viewer.sendCh <- data:
		return true
	case <-viewer.done:
		return false
	case <-timer.C:
		slog.Warn("SessionHost: viewer replay send timed out", "sessionID", h.config.SessionID, "viewerID", viewer.ID, "timeout", timeout)
		return false
	}
}

// sendToViewer sends a message to a single viewer via its buffered channel.
// If the channel is full, the message is dropped (viewer can reconnect).
func (h *SessionHost) sendToViewer(viewer *Viewer, data []byte) {
	select {
	case viewer.sendCh <- data:
	case <-viewer.done:
	default:
		// Channel full — drop message for this viewer
		slog.Warn("SessionHost: viewer send buffer full, dropping message", "sessionID", h.config.SessionID, "viewerID", viewer.ID)
	}
}

// sendToViewerPriority sends a high-priority message.
// If the channel is full, we evict one queued message and retry once so
// control/status updates are not silently dropped under replay backpressure.
func (h *SessionHost) sendToViewerPriority(viewer *Viewer, data []byte) {
	select {
	case viewer.sendCh <- data:
		return
	case <-viewer.done:
		return
	default:
	}

	// Make room by dropping one queued item for this viewer.
	select {
	case <-viewer.sendCh:
	default:
	}

	select {
	case viewer.sendCh <- data:
	case <-viewer.done:
	default:
		slog.Warn("SessionHost: viewer priority message dropped (buffer saturated)", "sessionID", h.config.SessionID, "viewerID", viewer.ID)
	}
}

// viewerWritePump drains the viewer's send channel and writes to its WebSocket.
// On write failure, it signals done so the Gateway read loop exits immediately
// instead of waiting for a read deadline timeout.
func (h *SessionHost) viewerWritePump(viewer *Viewer) {
	defer func() {
		// Signal done BEFORE closing the connection so the Gateway read loop
		// can detect the failure immediately via the done channel select case,
		// rather than waiting for the read deadline (40s) to expire.
		viewer.once.Do(func() { close(viewer.done) })
		viewer.conn.Close()
	}()

	for {
		select {
		case data, ok := <-viewer.sendCh:
			if !ok {
				return
			}
			viewer.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := viewer.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				slog.Error("SessionHost: viewer write failed", "sessionID", h.config.SessionID, "viewerID", viewer.ID, "error", err)
				return
			}
		case <-viewer.done:
			return
		case <-h.ctx.Done():
			return
		}
	}
}

// SendPongToViewer sends an application-level pong response to a specific viewer.
// This does NOT go through the message buffer — keepalive messages are transient.
func (h *SessionHost) SendPongToViewer(viewerID string) {
	data, _ := json.Marshal(map[string]string{"type": string(MsgPong)})
	h.viewerMu.RLock()
	viewer, ok := h.viewers[viewerID]
	h.viewerMu.RUnlock()
	if ok {
		h.sendToViewerPriority(viewer, data)
	}
}

// sendJSONRPCErrorToViewer sends a JSON-RPC error to a specific viewer.
func (h *SessionHost) sendJSONRPCErrorToViewer(viewerID string, reqID json.RawMessage, code int, message string) {
	data := h.marshalJSONRPCError(reqID, code, message)

	h.viewerMu.RLock()
	viewer, ok := h.viewers[viewerID]
	h.viewerMu.RUnlock()

	if ok {
		h.sendToViewerPriority(viewer, data)
	}
}

// --- Internal: message marshaling ---

func (h *SessionHost) marshalSessionState(status SessionHostStatus, agentType, errMsg string) []byte {
	return h.marshalSessionStateWithReplayCount(status, agentType, errMsg, -1)
}

// marshalSessionStateWithReplayCount marshals a session_state message.
// If replayCountOverride >= 0, it is used as-is; otherwise the actual buffer length is used.
func (h *SessionHost) marshalSessionStateWithReplayCount(status SessionHostStatus, agentType, errMsg string, replayCountOverride int) []byte {
	replayCount := replayCountOverride
	if replayCount < 0 {
		h.bufMu.RLock()
		replayCount = len(h.messageBuf)
		h.bufMu.RUnlock()
	}

	msg := SessionStateMessage{
		Type:        MsgSessionState,
		Status:      string(status),
		AgentType:   agentType,
		Error:       errMsg,
		ReplayCount: replayCount,
	}
	data, _ := json.Marshal(msg)
	return data
}

func (h *SessionHost) marshalControl(msgType ControlMessageType, extra map[string]interface{}) []byte {
	msg := map[string]interface{}{
		"type": string(msgType),
	}
	for k, v := range extra {
		msg[k] = v
	}
	data, _ := json.Marshal(msg)
	return data
}

func (h *SessionHost) marshalJSONRPCError(reqID json.RawMessage, code int, message string) []byte {
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
	return data
}

// --- Internal: helpers ---

func (h *SessionHost) currentSessionState() (SessionHostStatus, string, string) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.status, h.agentType, h.statusErr
}

func (h *SessionHost) promptTimeout() time.Duration {
	if h.config.PromptTimeout > 0 {
		return h.config.PromptTimeout
	}
	return DefaultPromptTimeout
}

func (h *SessionHost) promptCancelGracePeriod() time.Duration {
	if h.config.PromptCancelGracePeriod > 0 {
		return h.config.PromptCancelGracePeriod
	}
	return DefaultPromptCancelGracePeriod
}

func (h *SessionHost) beginPrompt(cancel context.CancelFunc) (uint64, bool) {
	h.promptMu.Lock()
	defer h.promptMu.Unlock()
	if h.promptInFlight {
		return 0, false
	}
	h.promptInFlight = true
	promptID := atomic.AddUint64(&h.promptSeq, 1)

	h.promptCancelMu.Lock()
	h.promptCancel = cancel
	h.activePromptID = promptID
	h.promptCancelMu.Unlock()
	return promptID, true
}

func (h *SessionHost) endPrompt(promptID uint64) {
	h.promptMu.Lock()
	h.promptInFlight = false
	h.promptMu.Unlock()

	h.promptCancelMu.Lock()
	if h.activePromptID == promptID {
		h.activePromptID = 0
		h.promptCancel = nil
	}
	h.promptCancelMu.Unlock()
}

func (h *SessionHost) isPromptActive(promptID uint64) bool {
	h.promptCancelMu.Lock()
	defer h.promptCancelMu.Unlock()
	return h.activePromptID == promptID
}

func (h *SessionHost) watchPromptTimeout(
	promptID uint64,
	promptCtx context.Context,
	done <-chan struct{},
	viewerID string,
	reqID json.RawMessage,
	timeout time.Duration,
) {
	select {
	case <-done:
		return
	case <-promptCtx.Done():
		if !errors.Is(promptCtx.Err(), context.DeadlineExceeded) {
			return
		}
		msg := fmt.Sprintf("Prompt timed out after %s", timeout)
		h.sendJSONRPCErrorToViewer(viewerID, reqID, -32603, msg)
		h.triggerPromptForceStopIfStuck(promptID, msg)
	}
}

func (h *SessionHost) triggerPromptForceStopIfStuck(promptID uint64, reason string) {
	h.promptCancelMu.Lock()
	if h.activePromptID != promptID {
		h.promptCancelMu.Unlock()
		return
	}
	h.activePromptID = 0
	h.promptCancel = nil
	h.promptCancelMu.Unlock()

	h.promptMu.Lock()
	h.promptInFlight = false
	h.promptMu.Unlock()

	h.mu.Lock()
	agentType := h.agentType
	if h.status == HostPrompting {
		h.status = HostError
		h.statusErr = reason
	}
	h.stopCurrentAgentLocked()
	h.mu.Unlock()

	h.reportLifecycle("error", "ACP prompt force-stopped", map[string]interface{}{
		"reason": reason,
	})
	h.broadcastControl(MsgSessionPromptDone, nil)
	h.broadcastAgentStatus(StatusError, agentType, reason)
}

func (h *SessionHost) setStatus(status SessionHostStatus, errMsg string) {
	h.mu.Lock()
	h.status = status
	h.statusErr = errMsg
	h.mu.Unlock()
}

// reportAgentError sends an agent error to boot-log and error reporter.
func (h *SessionHost) reportAgentError(agentType, step, message, detail string) {
	if h.config.BootLog != nil {
		h.config.BootLog.Log(step, "failed", fmt.Sprintf("[%s] %s", agentType, message), detail)
	}
	if h.config.ErrorReporter != nil {
		h.config.ErrorReporter.ReportError(
			fmt.Errorf("%s", message),
			"session-host",
			h.config.WorkspaceID,
			map[string]interface{}{
				"agentType": agentType,
				"step":      step,
				"detail":    detail,
			},
		)
	}
}

func (h *SessionHost) reportLifecycle(level, message string, ctx map[string]interface{}) {
	if h.config.ErrorReporter == nil {
		return
	}
	switch level {
	case "warn":
		h.config.ErrorReporter.ReportWarn(message, "session-host", h.config.WorkspaceID, ctx)
	default:
		h.config.ErrorReporter.ReportInfo(message, "session-host", h.config.WorkspaceID, ctx)
	}
}

func (h *SessionHost) reportEvent(level, eventType, message string, detail map[string]interface{}) {
	if h.config.EventAppender != nil {
		h.config.EventAppender.AppendEvent(h.config.WorkspaceID, level, eventType, message, detail)
	}
}

// fetchAgentKey retrieves the decrypted agent credential from the control plane.
func (h *SessionHost) fetchAgentKey(ctx context.Context, agentType string) (*agentCredential, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/agent-key", h.config.ControlPlaneURL, h.config.WorkspaceID)

	body, err := json.Marshal(map[string]string{"agentType": agentType})
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", url, byteReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+h.config.CallbackToken)

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

	if result.CredentialKind == "" {
		result.CredentialKind = "api-key"
	}

	return &agentCredential{
		credential:     result.APIKey,
		credentialKind: result.CredentialKind,
	}, nil
}

// fetchAgentSettings retrieves user's agent settings from the control plane.
func (h *SessionHost) fetchAgentSettings(ctx context.Context, agentType string) *agentSettingsPayload {
	url := fmt.Sprintf("%s/api/workspaces/%s/agent-settings", h.config.ControlPlaneURL, h.config.WorkspaceID)

	body, err := json.Marshal(map[string]string{"agentType": agentType})
	if err != nil {
		slog.Error("Failed to marshal agent settings request", "error", err)
		return nil
	}

	req, err := http.NewRequestWithContext(ctx, "POST", url, byteReader(body))
	if err != nil {
		slog.Error("Failed to create agent settings request", "error", err)
		return nil
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+h.config.CallbackToken)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		slog.Error("Failed to fetch agent settings", "error", err)
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		slog.Warn("Agent settings returned non-OK status, using defaults", "statusCode", resp.StatusCode)
		return nil
	}

	var result agentSettingsPayload
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		slog.Error("Failed to decode agent settings", "error", err)
		return nil
	}

	slog.Info("Fetched agent settings from control plane", "model", result.Model, "permissionMode", result.PermissionMode)
	return &result
}

// --- sessionHostClient: ACP SDK client interface ---

// sessionHostClient implements the acp-go-sdk Client interface.
// Instead of writing to a single WebSocket, it broadcasts to all viewers.
type sessionHostClient struct {
	host *SessionHost
}

func (c *sessionHostClient) SessionUpdate(_ context.Context, params acpsdk.SessionNotification) error {
	data, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "session/update",
		"params":  params,
	})
	if err != nil {
		return fmt.Errorf("failed to marshal session update: %w", err)
	}
	c.host.broadcastMessage(data)

	// Persist chat messages to the control plane via the message reporter.
	if c.host.config.MessageReporter != nil {
		msgs := ExtractMessages(params)
		for _, m := range msgs {
			if err := c.host.config.MessageReporter.Enqueue(MessageReportEntry{
				MessageID:    m.MessageID,
				Role:         m.Role,
				Content:      m.Content,
				ToolMetadata: m.ToolMetadata,
			}); err != nil {
				slog.Warn("messagereport: enqueue failed (non-blocking)",
					"messageId", m.MessageID, "error", err)
			}
		}
	}

	return nil
}

func (c *sessionHostClient) RequestPermission(_ context.Context, params acpsdk.RequestPermissionRequest) (acpsdk.RequestPermissionResponse, error) {
	data, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "permission/request",
		"params":  params,
	})
	if err != nil {
		return acpsdk.RequestPermissionResponse{}, fmt.Errorf("failed to marshal permission request: %w", err)
	}
	c.host.broadcastMessage(data)

	mode := c.host.permissionMode
	if mode == "" {
		mode = "default"
	}
	slog.Info("Permission request", "mode", mode, "optionsCount", len(params.Options))

	if len(params.Options) > 0 {
		return acpsdk.RequestPermissionResponse{
			Outcome: acpsdk.NewRequestPermissionOutcomeSelected(params.Options[0].OptionId),
		}, nil
	}
	return acpsdk.RequestPermissionResponse{
		Outcome: acpsdk.NewRequestPermissionOutcomeCancelled(),
	}, nil
}

func (c *sessionHostClient) ReadTextFile(ctx context.Context, params acpsdk.ReadTextFileRequest) (acpsdk.ReadTextFileResponse, error) {
	if params.Path == "" {
		return acpsdk.ReadTextFileResponse{}, fmt.Errorf("file path is required")
	}
	if strings.ContainsRune(params.Path, 0) {
		return acpsdk.ReadTextFileResponse{}, fmt.Errorf("file path contains null byte")
	}

	containerID, err := c.host.config.ContainerResolver()
	if err != nil {
		return acpsdk.ReadTextFileResponse{}, fmt.Errorf("failed to resolve container: %w", err)
	}

	timeout := c.host.config.FileExecTimeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	content, stderr, err := execInContainer(execCtx, containerID, c.host.config.ContainerUser, "", "cat", params.Path)
	if err != nil {
		slog.Error("ReadTextFile error", "path", params.Path, "error", err, "stderr", stderr)
		return acpsdk.ReadTextFileResponse{}, fmt.Errorf("failed to read file %q: %v", params.Path, err)
	}

	maxSize := c.host.config.FileMaxSize
	if maxSize == 0 {
		maxSize = 1048576
	}
	if len(content) > maxSize {
		return acpsdk.ReadTextFileResponse{}, fmt.Errorf("file %q exceeds maximum size of %d bytes", params.Path, maxSize)
	}

	content = applyLineLimit(content, params.Line, params.Limit)

	return acpsdk.ReadTextFileResponse{Content: content}, nil
}

func (c *sessionHostClient) WriteTextFile(ctx context.Context, params acpsdk.WriteTextFileRequest) (acpsdk.WriteTextFileResponse, error) {
	if params.Path == "" {
		return acpsdk.WriteTextFileResponse{}, fmt.Errorf("file path is required")
	}
	if strings.ContainsRune(params.Path, 0) {
		return acpsdk.WriteTextFileResponse{}, fmt.Errorf("file path contains null byte")
	}

	maxSize := c.host.config.FileMaxSize
	if maxSize == 0 {
		maxSize = 1048576
	}
	if len(params.Content) > maxSize {
		return acpsdk.WriteTextFileResponse{}, fmt.Errorf("content exceeds maximum size of %d bytes", maxSize)
	}

	containerID, err := c.host.config.ContainerResolver()
	if err != nil {
		return acpsdk.WriteTextFileResponse{}, fmt.Errorf("failed to resolve container: %w", err)
	}

	timeout := c.host.config.FileExecTimeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	dockerArgs := []string{"exec", "-i"}
	if c.host.config.ContainerUser != "" {
		dockerArgs = append(dockerArgs, "-u", c.host.config.ContainerUser)
	}
	dockerArgs = append(dockerArgs, containerID, "tee", params.Path)

	cmd := exec.CommandContext(execCtx, "docker", dockerArgs...)
	cmd.Stdin = strings.NewReader(params.Content)

	var stderrBuf bytes.Buffer
	cmd.Stdout = io.Discard
	cmd.Stderr = &stderrBuf

	if err := cmd.Run(); err != nil {
		stderrStr := strings.TrimSpace(stderrBuf.String())
		slog.Error("WriteTextFile error", "path", params.Path, "error", err, "stderr", stderrStr)
		return acpsdk.WriteTextFileResponse{}, fmt.Errorf("failed to write file %q: %v", params.Path, err)
	}

	return acpsdk.WriteTextFileResponse{}, nil
}

func (c *sessionHostClient) CreateTerminal(_ context.Context, _ acpsdk.CreateTerminalRequest) (acpsdk.CreateTerminalResponse, error) {
	return acpsdk.CreateTerminalResponse{}, fmt.Errorf("CreateTerminal not supported")
}

func (c *sessionHostClient) KillTerminalCommand(_ context.Context, _ acpsdk.KillTerminalCommandRequest) (acpsdk.KillTerminalCommandResponse, error) {
	return acpsdk.KillTerminalCommandResponse{}, fmt.Errorf("KillTerminalCommand not supported")
}

func (c *sessionHostClient) TerminalOutput(_ context.Context, _ acpsdk.TerminalOutputRequest) (acpsdk.TerminalOutputResponse, error) {
	return acpsdk.TerminalOutputResponse{}, fmt.Errorf("TerminalOutput not supported")
}

func (c *sessionHostClient) ReleaseTerminal(_ context.Context, _ acpsdk.ReleaseTerminalRequest) (acpsdk.ReleaseTerminalResponse, error) {
	return acpsdk.ReleaseTerminalResponse{}, fmt.Errorf("ReleaseTerminal not supported")
}

func (c *sessionHostClient) WaitForTerminalExit(_ context.Context, _ acpsdk.WaitForTerminalExitRequest) (acpsdk.WaitForTerminalExitResponse, error) {
	return acpsdk.WaitForTerminalExitResponse{}, fmt.Errorf("WaitForTerminalExit not supported")
}
