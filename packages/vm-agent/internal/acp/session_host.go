package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
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

	// DefaultPromptRetryInitialDelay is the first delay before retrying a
	// transient provider prompt error when no explicit delay is configured.
	DefaultPromptRetryInitialDelay = 15 * time.Second

	// DefaultPromptRetryMaxDelay caps retry backoff for transient provider
	// prompt errors when no explicit cap is configured.
	DefaultPromptRetryMaxDelay = 2 * time.Minute

	// DefaultACPInitTimeout is the safety-net timeout for ACP phase operations
	// when InitTimeoutMs is not configured. Matches the default for ACP_INIT_TIMEOUT_MS.
	DefaultACPInitTimeout = 30 * time.Second

	// DefaultRecoveryWatchdogTimeout bounds crash recovery after an ACP stdio
	// disconnect so a leaked process monitor cannot strand the prompt forever.
	DefaultRecoveryWatchdogTimeout = 2 * time.Minute

	// DefaultRestartDecayWindow is the quiet period after which restartCount is
	// reset before counting a new unexpected agent exit.
	DefaultRestartDecayWindow = 5 * time.Minute

	// defaultControlPlaneHTTPTimeout is the safety-net HTTP client timeout
	// used when no HTTPClient is injected via GatewayConfig. Production code
	// injects a client via config.NewControlPlaneClient(cfg.HTTPCallbackTimeout);
	// this constant is only reached in tests or direct struct construction.
	defaultControlPlaneHTTPTimeout = 30 * time.Second
)

const (
	ampMcpRemotePackage = "mcp-remote@0.1.38"
	ampMcpTokenEnvVar   = "SAM_MCP_TOKEN"
)

// DefaultStderrBufferBytes is the default maximum agent stderr captured for
// crash reports. Override via ACP_STDERR_BUFFER_BYTES.
const DefaultStderrBufferBytes = 4096

// buildAcpMcpServers converts McpServerEntry configs into acpsdk.McpServer
// entries for NewSession/LoadSession requests.
func buildAcpMcpServers(entries []McpServerEntry, agentType string) []acpsdk.McpServer {
	if len(entries) == 0 {
		return []acpsdk.McpServer{}
	}
	servers := make([]acpsdk.McpServer, 0, len(entries))
	for i, e := range entries {
		name := mcpServerName(i, len(entries))
		if agentType == "amp" {
			servers = append(servers, buildAmpMcpServer(name, e))
			continue
		}
		var headers []acpsdk.HttpHeader
		if e.Token != "" {
			headers = append(headers, acpsdk.HttpHeader{
				Name:  "Authorization",
				Value: "Bearer " + e.Token,
			})
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

func mcpServerName(index, total int) string {
	if total > 1 {
		return fmt.Sprintf("sam-mcp-%d", index)
	}
	return "sam-mcp"
}

func buildAmpMcpServer(name string, entry McpServerEntry) acpsdk.McpServer {
	var env []acpsdk.EnvVariable
	args := []string{"-y", ampMcpRemotePackage, entry.URL}
	if entry.Token != "" {
		env = append(env, acpsdk.EnvVariable{
			Name:  ampMcpTokenEnvVar,
			Value: entry.Token,
		})
		// mcp-remote expands ${ENV_VAR} references in --header values internally.
		// The token is passed via env var (not in CLI args) to avoid /proc visibility.
		args = append(args, "--header", "Authorization:Bearer ${"+ampMcpTokenEnvVar+"}")
	}
	args = append(args, "--silent")

	return acpsdk.McpServer{
		Stdio: &acpsdk.McpServerStdio{
			Name:    name,
			Command: "npx",
			Args:    args,
			Env:     env,
		},
	}
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

	// StderrBufferBytes is the maximum agent stderr captured for crash reports.
	// Override via ACP_STDERR_BUFFER_BYTES. Default: 4096 bytes.
	StderrBufferBytes int

	// NotifSerializeTimeout is the maximum time to wait for a previous
	// notification handler to complete before delivering the next notification
	// to the SDK. This serializes session/update processing to prevent the
	// SDK's concurrent goroutine dispatch from reordering streaming tokens.
	// Override via ACP_NOTIF_SERIALIZE_TIMEOUT. Default: 5s.
	NotifSerializeTimeout time.Duration

	// StartProcess is an internal test hook. Production code leaves it nil and
	// uses StartProcess via startAgentProcess.
	StartProcess func(*agentStartup) (agentProcess, error)

	// RuntimeAssetsProvider fetches resolved project/profile/skill runtime assets
	// for standalone sessions. It must not log or persist secret values.
	RuntimeAssetsProvider RuntimeAssetsProvider
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
	process        agentProcess
	acpConn        *acpsdk.ClientSideConnection
	agentType      string
	sessionID      acpsdk.SessionId
	configOptions  []acpsdk.SessionConfigOption
	restartCount   int
	lastCrashTime  time.Time
	permissionMode string
	// agentSupportsLoadSession is captured from ACP Initialize so prompt error
	// handling can decide whether a process crash is recoverable.
	agentSupportsLoadSession bool
	status                   SessionHostStatus
	statusErr                string
	// selectionInProgress is set for the duration of a selectAgent call (from
	// beginAgentSelection until selectAgent returns). It guards the fresh-host
	// window where h.process is still nil during the multi-second
	// credential-fetch/install phase, so two concurrent selections for the same
	// agent cannot double-spawn a process for one session.
	selectionInProgress bool
	// intentionalPromptCancelProcessStop suppresses rapid-exit crash handling
	// when a user cancel intentionally terminates an agent that lacks native
	// session/cancel support.
	intentionalPromptCancelProcessStop bool

	// replaySuppressed is set while an ACP LoadSession is in flight. LoadSession
	// makes the agent replay the entire transcript as session/update
	// notifications; suppressing them here (lock-free, checked in
	// sessionHostClient.SessionUpdate) prevents the replay from being broadcast
	// to viewers, buffered for late-join, or re-persisted with fresh UUIDs.
	// Lock-free atomic so SessionUpdate never blocks on h.mu during a load.
	replaySuppressed atomic.Bool

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
	// promptActivityCancel stops the periodic prompting re-report loop.
	// Protected by promptCancelMu.
	promptActivityCancel context.CancelFunc
	// activePromptID identifies the in-flight prompt associated with promptCancel.
	// Protected by promptCancelMu.
	activePromptID uint64
	// promptCancelRequested records that the current prompt was explicitly
	// cancelled by a viewer or control-plane request.
	// Protected by promptCancelMu.
	promptCancelRequested bool

	// Crash recovery state (guarded by mu). When a prompt fails because the
	// agent process disconnected, finishPromptWithError records this context
	// and lets monitorProcessExit attempt LoadSession recovery.
	crashRecoveryInProgress bool
	crashStderr             string
	crashAgentType          string
	crashSessionID          string
	crashPromptReqID        json.RawMessage
	crashPromptViewerID     string

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
	if config.StderrBufferBytes <= 0 {
		config.StderrBufferBytes = DefaultStderrBufferBytes
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
	// Re-check conditions under lock: no viewers and not prompting/recovering.
	// Hold viewerMu across both checks to prevent races with DetachViewer.
	h.viewerMu.Lock()
	h.suspendTimer = nil // Timer has fired, clear reference.
	if len(h.viewers) > 0 {
		h.viewerMu.Unlock()
		slog.Info("SessionHost: auto-suspend aborted (viewers present)", "sessionID", h.config.SessionID)
		return
	}

	// Check prompting/recovery status while still holding viewerMu to prevent race
	// where a viewer detaches and also tries to start a timer.
	if h.isPromptingOrRecovering() {
		// Re-arm the timer without releasing the lock.
		if h.suspendTimer == nil {
			h.suspendTimer = time.AfterFunc(h.config.IdleSuspendTimeout, func() {
				h.autoSuspend()
			})
		}
		h.viewerMu.Unlock()
		slog.Info("SessionHost: auto-suspend deferred (prompt/recovery in progress)", "sessionID", h.config.SessionID)
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

// CancelPromptFromControlPlane mirrors the viewer WebSocket session/cancel path
// for HTTP control-plane cancellation requests.
func (h *SessionHost) CancelPromptFromControlPlane() {
	if h.AgentType() == "opencode" {
		h.cancelPrompt(false)
		h.StopProcessForPromptCancel()
		return
	}

	h.CancelPrompt()
	cancelMessage, err := h.cancelNotification()
	if err != nil {
		slog.Warn("CancelPromptFromControlPlane: could not build session/cancel notification", "error", err)
	} else {
		h.ForwardToAgent(cancelMessage)
	}
	h.StopProcessForPromptCancel()
}

func (h *SessionHost) cancelNotification() ([]byte, error) {
	sessionID := h.currentSessionIDForCancel()
	if sessionID == "" {
		return nil, fmt.Errorf("missing session ID")
	}

	return json.Marshal(struct {
		JSONRPC string `json:"jsonrpc"`
		Method  string `json:"method"`
		Params  struct {
			SessionID string `json:"sessionId"`
		} `json:"params"`
	}{
		JSONRPC: "2.0",
		Method:  "session/cancel",
		Params: struct {
			SessionID string `json:"sessionId"`
		}{SessionID: sessionID},
	})
}

func (h *SessionHost) currentSessionIDForCancel() string {
	h.mu.RLock()
	acpSessionID := string(h.sessionID)
	h.mu.RUnlock()
	if acpSessionID != "" {
		return acpSessionID
	}
	return h.config.SessionID
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

	process.KillContainerProcesses(sig)
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

	// Report idle to the control plane so the browser status bar clears.
	h.stopPromptActivityRereport()
	h.reportActivity("idle")

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

// applySessionSettings calls SetSessionConfigOption for the model and
// SetSessionMode on the ACP connection. Both calls are non-fatal.
func (h *SessionHost) applySessionSettings(ctx context.Context, settings *agentSettingsPayload) {
	if settings == nil || h.acpConn == nil || h.sessionID == "" {
		return
	}

	if settings.Model != "" {
		h.applySessionModelConfigOption(ctx, settings.Model)
	}

	if settings.PermissionMode != "" && settings.PermissionMode != "default" {
		// Codex (openai-codex) does not support SetSessionMode — skip to avoid
		// a guaranteed error on every session start.
		if h.agentType == "openai-codex" {
			slog.Info("ACP: skipping SetSessionMode for openai-codex (unsupported)", "mode", settings.PermissionMode)
		} else {
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
}

func (h *SessionHost) applySessionModelConfigOption(ctx context.Context, model string) {
	modelConfigID, ok := findModelConfigOptionID(h.configOptions)
	if !ok {
		slog.Warn("ACP session model config option unavailable (non-fatal)", "model", model)
		h.reportLifecycle("warn", "ACP session model config option unavailable", map[string]interface{}{
			"model": model,
		})
		return
	}

	slog.Info("ACP: setting session model config option", "model", model, "configId", string(modelConfigID))
	resp, err := h.acpConn.SetSessionConfigOption(ctx, acpsdk.SetSessionConfigOptionRequest{
		ValueId: &acpsdk.SetSessionConfigOptionValueId{
			SessionId: h.sessionID,
			ConfigId:  modelConfigID,
			Value:     acpsdk.SessionConfigValueId(model),
		},
	})
	if err != nil {
		slog.Warn("ACP SetSessionConfigOption failed (non-fatal)", "model", model, "configId", string(modelConfigID), "error", err)
		h.reportLifecycle("warn", "ACP session model config option failed", map[string]interface{}{
			"model":    model,
			"configId": string(modelConfigID),
			"error":    err.Error(),
		})
		return
	}

	h.configOptions = resp.ConfigOptions
	slog.Info("ACP: session model config option set", "model", model, "configId", string(modelConfigID))
	h.reportLifecycle("info", "ACP session model applied", map[string]interface{}{
		"model":    model,
		"configId": string(modelConfigID),
	})
}

func findModelConfigOptionID(options []acpsdk.SessionConfigOption) (acpsdk.SessionConfigId, bool) {
	for _, option := range options {
		if option.Select == nil || option.Select.Category == nil {
			continue
		}
		if *option.Select.Category == acpsdk.SessionConfigOptionCategoryModel {
			return option.Select.Id, true
		}
	}
	return "", false
}

// ensureAgentInstalled checks if the ACP adapter binary exists and installs it
// on-demand if missing.
func (h *SessionHost) ensureAgentInstalled(ctx context.Context, info agentCommandInfo) error {
	if info.installCmd == "" {
		return nil
	}
	// Standalone / cf-container mode configures a custom ProcessLauncher and has
	// no devcontainer ContainerResolver. Install the ACP adapter locally (same
	// hardcoded install script) instead of via docker exec.
	if h.config.ProcessLauncher != nil {
		h.broadcastAgentStatus(StatusInstalling, info.command, "")
		return installAgentBinaryLocal(ctx, info)
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
func (h *SessionHost) monitorStderr(process agentProcess) {
	scanner := bufio.NewScanner(process.Stderr())
	for scanner.Scan() {
		line := scanner.Text()
		slog.Warn("Agent stderr", "line", line)
		h.stderrMu.Lock()
		if h.stderrBuf.Len() < h.config.StderrBufferBytes {
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

func (h *SessionHost) peekStderr() string {
	h.stderrMu.Lock()
	defer h.stderrMu.Unlock()
	return h.stderrBuf.String()
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
	h.agentSupportsLoadSession = false
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

func (h *SessionHost) isPromptingOrRecovering() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.status == HostPrompting || h.status == HostStarting || h.crashRecoveryInProgress
}

// OnPromptCompleteCallback returns the OnPromptComplete callback, if configured.
// Used by server-initiated prompt flows to report agent start failures back to
// the control plane without going through HandlePrompt.
func (h *SessionHost) OnPromptCompleteCallback() func(string, error) {
	return h.config.OnPromptComplete
}
