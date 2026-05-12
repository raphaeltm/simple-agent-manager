package acp

import (
	"bufio"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"syscall"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/gorilla/websocket"
	"github.com/workspace/vm-agent/internal/config"
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
	// DefaultPromptCancelGracePeriod is how long we wait after cancel before
	// force-stopping an unresponsive agent process.
	DefaultPromptCancelGracePeriod = 5 * time.Second

	// DefaultACPInitTimeout is the safety-net timeout for ACP phase operations
	// when InitTimeoutMs is not configured. Matches the default for ACP_INIT_TIMEOUT_MS.
	DefaultACPInitTimeout = 30 * time.Second

	// defaultControlPlaneHTTPTimeout is the safety-net HTTP client timeout
	// used when no HTTPClient is injected via GatewayConfig. Production code
	// injects a client via config.NewControlPlaneClient(cfg.HTTPCallbackTimeout);
	// this constant is only reached in tests or direct struct construction.
	defaultControlPlaneHTTPTimeout = 30 * time.Second
)

// buildAcpMcpServers converts McpServerEntry configs into acpsdk.McpServer
// entries for NewSession/LoadSession requests.
func buildAcpMcpServers(entries []McpServerEntry) []acpsdk.McpServer {
	if len(entries) == 0 {
		return []acpsdk.McpServer{}
	}
	servers := make([]acpsdk.McpServer, 0, len(entries))
	for i, e := range entries {
		var headers []acpsdk.HttpHeader
		if e.Token != "" {
			headers = append(headers, acpsdk.HttpHeader{
				Name:  "Authorization",
				Value: "Bearer " + e.Token,
			})
		}
		name := "sam-mcp"
		if len(entries) > 1 {
			name = fmt.Sprintf("sam-mcp-%d", i)
		}
		servers = append(servers, acpsdk.McpServer{
			Http: &acpsdk.McpServerHttpInline{
				Name: name,
				// Type is set to "http" by McpServer.MarshalJSON regardless of this field.
				Url:     e.URL,
				Headers: headers,
			},
		})
	}
	return servers
}

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

	// NotifSerializeTimeout is the maximum time to wait for a previous
	// notification handler to complete before delivering the next notification
	// to the SDK. This serializes session/update processing to prevent the
	// SDK's concurrent goroutine dispatch from reordering streaming tokens.
	// Override via ACP_NOTIF_SERIALIZE_TIMEOUT. Default: 5s.
	NotifSerializeTimeout time.Duration
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
	// intentionalPromptCancelProcessStop suppresses rapid-exit crash handling
	// when a user cancel intentionally terminates an agent that lacks native
	// session/cancel support.
	intentionalPromptCancelProcessStop bool

	// Credential injection metadata (set during startAgent, read during stop).
	// These track whether the agent used file-based credential injection so
	// that refreshed tokens can be synced back to the control plane.
	credInjectionMode string // "env" or "auth-file"
	credAuthFilePath  string // relative to home dir, e.g. ".codex/auth.json"
	credKind          string // "api-key" or "oauth-token"

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
	// promptCancelRequested records that the current prompt was explicitly
	// cancelled by a viewer or control-plane request.
	// Protected by promptCancelMu.
	promptCancelRequested bool

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

// httpClient returns the configured HTTP client for control-plane calls,
// falling back to a default 30-second timeout client if none was provided.
func (h *SessionHost) httpClient() *http.Client {
	if h.config.HTTPClient != nil {
		return h.config.HTTPClient
	}
	return config.NewControlPlaneClient(defaultControlPlaneHTTPTimeout)
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

	// Register the viewer BEFORE starting the write pump goroutine to
	// close the TOCTOU window between the status check above and the
	// goroutine launch. If the session transitions to stopped after our
	// check, the goroutine will exit via h.ctx.Done().
	h.viewerMu.Lock()
	h.viewers[id] = viewer
	if h.suspendTimer != nil {
		h.suspendTimer.Stop()
		h.suspendTimer = nil
		slog.Info("SessionHost: auto-suspend timer cancelled (viewer attached)", "sessionID", h.config.SessionID)
	}
	h.viewerMu.Unlock()

	// Start the viewer's write pump goroutine after registration.
	go h.viewerWritePump(viewer)

	slog.Info("SessionHost: viewer attached", "sessionID", h.config.SessionID, "viewerID", id, "totalViewers", h.ViewerCount())

	// Send current session state
	h.sendToViewerPriority(viewer, h.marshalSessionState(currentStatus, currentAgentType, currentErr))

	// Replay buffered messages
	h.replayToViewer(viewer)

	// Signal replay complete — use blocking send so we don't evict buffered
	// replay messages (sendToViewerPriority evicts on full channel).
	h.sendToViewerWithTimeout(viewer, h.marshalControl(MsgSessionReplayDone, nil), 5*time.Second)

	// Send a post-replay authoritative state snapshot with replayCount=0.
	// This closes the race where prompt status changes during replay and the
	// initial pre-replay snapshot becomes stale. replayCount MUST be 0 because
	// the replay has already been delivered — a non-zero value would cause the
	// browser to re-enter replay mode, calling prepareForReplay() which wipes
	// all just-replayed messages.
	finalStatus, finalAgentType, finalErr := h.currentSessionState()
	h.sendToViewerWithTimeout(viewer, h.marshalSessionStateWithReplayCount(finalStatus, finalAgentType, finalErr, 0), 5*time.Second)

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

// CancelPrompt cancels the currently running Prompt() call, if any.
// This is safe to call from any goroutine. If no prompt is in flight,
// it's a no-op. The cancel function is guarded by promptCancelMu
// (separate from promptMu) so we never deadlock with HandlePrompt.
func (h *SessionHost) CancelPrompt() {
	h.cancelPrompt(true)
}

func (h *SessionHost) cancelPrompt(startGraceTimer bool) {
	h.promptCancelMu.Lock()
	cancelFn := h.promptCancel
	promptID := h.activePromptID
	if cancelFn != nil {
		h.promptCancelRequested = true
	}
	h.promptCancelMu.Unlock()

	if cancelFn == nil {
		slog.Info("CancelPrompt: no prompt in flight")
		return
	}

	slog.Info("CancelPrompt: cancelling in-flight prompt")
	h.reportLifecycle("info", "Prompt cancel requested", nil)
	cancelFn()

	if !startGraceTimer {
		return
	}

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

// SignalProcess sends a signal to the agent process. This is used for agents
// that don't implement session/cancel (e.g., opencode) — SIGTERM is sent
// directly to the process instead of forwarding the cancel RPC.
func (h *SessionHost) SignalProcess(sig syscall.Signal) {
	h.mu.RLock()
	process := h.process
	h.mu.RUnlock()

	if process == nil {
		slog.Warn("SignalProcess: no agent process running")
		return
	}

	process.killContainerProcesses(sig)
	slog.Info("SignalProcess: sent signal to agent process", "signal", sig, "agentType", h.AgentType())
}

// StopProcessForPromptCancel terminates the current agent process for a user
// prompt cancel without marking the host stopped. The process monitor will
// restart the agent and return the host to ready for follow-up prompts.
func (h *SessionHost) StopProcessForPromptCancel() {
	h.mu.Lock()
	process := h.process
	if process != nil {
		h.intentionalPromptCancelProcessStop = true
	}
	h.mu.Unlock()

	if process == nil {
		slog.Warn("StopProcessForPromptCancel: no agent process running")
		return
	}

	if err := process.Stop(); err != nil {
		slog.Warn("StopProcessForPromptCancel: failed to stop agent process", "error", err)
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
	// Snapshot credential metadata while still holding the lock.
	snap := credSyncSnapshot{
		injectionMode: h.credInjectionMode,
		authFilePath:  h.credAuthFilePath,
		credKind:      h.credKind,
		agentType:     h.agentType,
	}
	h.mu.Unlock()

	// Sync refreshed credentials back to the control plane before cleanup.
	// The agent process is dead but the container is still alive.
	h.syncCredentialOnStop(snap)

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

// phaseTimeout returns a per-phase timeout duration. If phaseMs is > 0, it is
// used; otherwise the fallback timeout is returned.
func phaseTimeout(phaseMs int, fallback time.Duration) time.Duration {
	if phaseMs > 0 {
		return time.Duration(phaseMs) * time.Millisecond
	}
	return fallback
}

// applySessionSettings calls SetSessionModel and SetSessionMode on the ACP
// connection. Both calls are non-fatal.
func (h *SessionHost) applySessionSettings(ctx context.Context, settings *agentSettingsPayload) {
	if settings == nil || h.acpConn == nil || h.sessionID == "" {
		return
	}

	if settings.Model != "" {
		// Skip SetSessionModel for platform AI proxy — OpenCode's model resolver
		// splits on "/" (e.g. "meta/llama-4-scout..." → providerID:"meta") which
		// breaks for Workers AI model IDs regardless of prefix. The model is
		// already set in the OpenCode config file for the openai-compatible provider.
		//
		// Safety: OpencodeProvider is only set to "platform" via the credential
		// injection blocks (gated on APIKeySource=="callback-token" or "user-credential"),
		// which are exclusive to OpenCode + proxy paths. For non-opencode agents,
		// OpencodeProvider remains empty and this branch is not taken.
		if settings.OpencodeProvider == "platform" {
			slog.Info("ACP: skipping SetSessionModel for platform proxy (model set in config)", "model", settings.Model)
		} else {
			slog.Info("ACP: setting session model", "model", settings.Model)
			if _, err := h.acpConn.UnstableSetSessionModel(ctx, acpsdk.UnstableSetSessionModelRequest{
				SessionId: h.sessionID,
				ModelId:   acpsdk.UnstableModelId(settings.Model),
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

	// installAgentBinary handles the "already installed" fast path internally
	// (with and without mutex), so we skip the redundant `which` check here
	// and just broadcast the installing status before delegating.
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

// silentErrorPatterns are stderr substrings that indicate an API-level error
// the agent may have swallowed (returning a normal end_turn instead of an error).
var silentErrorPatterns = []string{
	"AI_APICallError",
	"Unauthorized",
	"401",
	"403",
	"invalid_api_key",
	"authentication_error",
}

// checkStderrForSilentErrors peeks at the accumulated stderr buffer for known
// API error patterns. Some agents (notably OpenCode with Scaleway) silently
// swallow API errors and return {stopReason: "end_turn"} instead of an error.
// When detected, we log a warning and report a lifecycle event so the UI can
// surface the issue. The stderr buffer is NOT cleared — it remains available
// for crash reporting in monitorProcessExit.
func (h *SessionHost) checkStderrForSilentErrors(stopReason acpsdk.StopReason) {
	h.stderrMu.Lock()
	stderr := h.stderrBuf.String()
	h.stderrMu.Unlock()

	if stderr == "" {
		return
	}

	for _, pattern := range silentErrorPatterns {
		if strings.Contains(stderr, pattern) {
			slog.Warn("ACP: possible silent API error detected in stderr after prompt completion",
				"stopReason", string(stopReason),
				"pattern", pattern,
				"stderrSnippet", truncateString(stderr, 512),
				"agentType", h.AgentType(),
			)
			h.reportLifecycle("warn", "Possible silent API error — check agent credentials", map[string]interface{}{
				"stopReason":    string(stopReason),
				"errorPattern":  pattern,
				"stderrSnippet": truncateString(stderr, 256),
			})
			return // report once per prompt, not per pattern
		}
	}
}

// truncateString returns s truncated to maxLen with "..." appended if needed.
func truncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

// stopCurrentAgentLocked stops the current agent process. Must hold h.mu.
func (h *SessionHost) stopCurrentAgentLocked() {
	if h.process != nil {
		_ = h.process.Stop()
		h.process = nil
	}
	h.acpConn = nil
	h.sessionID = ""
	// Clear credential metadata so stale values don't leak across agent switches.
	h.credInjectionMode = ""
	h.credAuthFilePath = ""
	h.credKind = ""
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
			slog.Warn("Failed to persist ACP session ID to session manager", "error", err)
		} else {
			slog.Info("ACP session ID persisted to session manager", "sessionID", sessionID)
		}
	}

	if h.config.TabStore != nil && h.config.SessionID != "" {
		if err := h.config.TabStore.UpdateTabAcpSessionID(h.config.SessionID, sessionID); err != nil {
			slog.Warn("Failed to persist ACP session ID to tab store", "error", err)
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
			slog.Warn("Failed to persist last prompt to session manager", "error", err)
		}
	}

	if h.config.TabLastPromptStore != nil && h.config.SessionID != "" {
		if err := h.config.TabLastPromptStore.UpdateTabLastPrompt(h.config.SessionID, text); err != nil {
			slog.Warn("Failed to persist last prompt to tab store", "error", err)
		}
	}
}

// IsPrompting returns true if a prompt is currently in flight.
// Used by the auto-suspend timer to avoid interrupting active work.
func (h *SessionHost) IsPrompting() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.status == HostPrompting
}

// OnPromptCompleteCallback returns the OnPromptComplete callback, if configured.
// Used by server-initiated prompt flows to report agent start failures back to
// the control plane without going through HandlePrompt.
func (h *SessionHost) OnPromptCompleteCallback() func(string, error) {
	return h.config.OnPromptComplete
}
