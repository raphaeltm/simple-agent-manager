package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
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
	// DefaultPromptCancelGracePeriod is how long a cancelled prompt may take to
	// settle before it is finished as "cancelled" and the agent is restarted.
	// The watchdog is bound to that one prompt attempt and disarms when it ends.
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

// DefaultMessageBufferSize is the default maximum number of messages buffered
// per session for late-join replay. Override via ACP_MESSAGE_BUFFER_SIZE.
const DefaultMessageBufferSize = 5000

// DefaultViewerSendBuffer is the default channel buffer size per viewer.
// Override via ACP_VIEWER_SEND_BUFFER.
const DefaultViewerSendBuffer = 256

// DefaultUsageReportPendingWindows bounds usage reports queued while the
// serialized usage reporter is busy.
const DefaultUsageReportPendingWindows = 16

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

	// UsageReportPendingLimit bounds usage reports queued while one usage
	// callback is being delivered. Zero uses the package default.
	UsageReportPendingLimit int

	// StartProcess is an internal test hook. Production code leaves it nil and
	// uses StartProcess via startAgentProcess.
	StartProcess func(*agentStartup) (agentProcess, error)

	// BeforeCheckpointProcessStop is an internal deterministic-race test hook.
	// Production code leaves it nil.
	BeforeCheckpointProcessStop func()

	// RuntimeAssetsProvider fetches resolved project/profile/skill runtime assets
	// for standalone sessions. It must not log or persist secret values.
	//
	// Set once at construction and never reassigned, which is what makes the
	// unlocked read in HasRuntimeAssetsProvider safe. If this ever becomes
	// mutable (e.g. a hot-reloadable provider), every reader must take h.mu —
	// note consumePreviousSelectionOnSuccess already mutates two sibling fields
	// of this struct under that lock.
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
	mu                       sync.RWMutex
	process                  agentProcess
	acpConn                  *acpsdk.ClientSideConnection
	agentType                string
	codexC2SelectionMu       sync.Mutex // independent: startup can hold mu
	codexC2Selector          string     // explicit profile selector, guarded by codexC2SelectionMu
	codexC2EffectiveSelector string     // executable selection latched for this host
	codexC2SelectionLatched  bool
	sessionID                acpsdk.SessionId

	// Lock-free mirrors of sessionID/status, read ONLY by code reachable from
	// the ACP SDK's single notification-processing goroutine
	// (HandleExtensionMethod -> matchesHarnessSession / activityForHarnessWork).
	//
	// That goroutine must never block on `mu`: the ACP handshake
	// (startAgent/applySessionSettings) holds `mu` for its whole duration while
	// its in-flight RPC blocks in the SDK's waitNotificationsUpTo, which waits
	// for this very notification worker. Taking mu.RLock() there is a genuine
	// self-deadlock (reproduced: a _claude/sdkMessage notification arriving just
	// before the session/new response turned a 5ms handshake into an 800ms
	// timeout; with SetSessionMode's unbounded ctx it hangs indefinitely).
	//
	// Writers keep these in step with the mu-guarded fields via
	// setSessionIDLocked/setStatusLocked. See .claude/rules/46.
	//
	// This constraint is transitive: NOTHING reachable from
	// HandleExtensionMethod may call a helper that takes mu, however far down the
	// call chain. reportActivity is the trap — it looks like a fire-and-forget
	// reporter but takes mu.RLock to snapshot agentType/restartCount/statusErr.
	// Use nudgeHarnessActivityReport from that goroutine instead.
	mirrorSessionID atomic.Value // string
	mirrorStatus    atomic.Value // SessionHostStatus
	configOptions   []acpsdk.SessionConfigOption
	restartCount    int
	lastCrashTime   time.Time
	permissionMode  string
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
	checkpointRollover                 *checkpointRolloverEpisode

	// replaySuppressed is set while an ACP LoadSession is in flight. LoadSession
	// makes the agent replay the entire transcript as session/update
	// notifications; suppressing them here (lock-free, checked in
	// sessionHostClient.SessionUpdate) prevents the replay from being broadcast
	// to viewers, buffered for late-join, or re-persisted with fresh UUIDs.
	// Lock-free atomic so SessionUpdate never blocks on h.mu during a load.
	replaySuppressed atomic.Bool
	// credentialAttribution stores non-secret server-selected credential identity
	// for usage callbacks. It is lock-free so SessionUpdate never waits on h.mu.
	credentialAttribution atomic.Value
	// renewedCallbackToken holds a workspace callback token delivered after the
	// host was created (SetCallbackToken). Lock-free like the fields above:
	// control-plane reporting runs on the ACP notification goroutine.
	renewedCallbackToken atomic.Value // string

	// Credential injection metadata (set during startAgent, read during stop).
	// These track whether the agent used file-based credential injection so
	// that refreshed tokens can be synced back to the control plane.
	credInjectionMode string // "env" or "auth-file"
	credAuthFilePath  string // relative to home dir, e.g. ".codex/auth.json"
	credKind          string // "api-key" or "oauth-token"

	usageReportMu           sync.Mutex
	usageReportPending      map[string]usageReportPendingEntry
	usageReportOrder        []string
	usageReportNextSeq      uint64
	usageReportRunning      bool
	usageReportDone         chan struct{}
	usageReportCancel       context.CancelFunc
	usageReportFailureCount int
	usageReportLastError    string
	usageReportClosed       bool
	usageReportCloseGrace   bool
	usageReportCallbacks    sync.WaitGroup

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
	// promptAttempt remains attached until the next accepted prompt so late
	// terminal signals from the same runtime are absorbed by its exact-once
	// arbiter instead of reaching the control plane twice.
	promptAttempt *promptAttempt
	// promptCancelMu guards promptCancel independently from promptMu so that
	// CancelPrompt() can read it without waiting for Prompt() to finish.
	promptCancelMu sync.Mutex
	// promptCancel cancels the in-flight Prompt() context. Protected by promptCancelMu.
	promptCancel context.CancelFunc
	// promptActivityCancel stops the periodic prompting re-report loop.
	// Protected by promptCancelMu.
	promptActivityCancel context.CancelFunc
	// cancelGraceTimer replaces the cancel-grace timer in tests so they can own
	// the ordering between a cancel, the next prompt, and the deadline. Set
	// only before the host is used; nil means a real time.Timer.
	cancelGraceTimer func(time.Duration) (<-chan time.Time, func())

	// Harness-owned background work is normalized from optional ACP extension
	// notifications. It is isolated from the prompt lifecycle because it may
	// continue after session/prompt has returned.
	harnessWorkMu         sync.Mutex
	harnessWork           harnessWorkStatus
	harnessTaskIDs        map[string]struct{}
	harnessActivityCancel context.CancelFunc
	// harnessReportMu owns the debounced, single-flight activity reporter
	// triggered by harness lifecycle notifications. The ACP notification
	// goroutine must never call reportActivity inline: reportActivity takes
	// mu.RLock for its agentType/restartCount/statusErr snapshot, which is
	// exactly the block the lock-free mirrors above exist to avoid.
	harnessReportMu       sync.Mutex
	harnessReportTimer    *time.Timer
	harnessReportSequence uint64
	harnessReportRunning  bool
	harnessReportPending  bool
	lastActivityReportMu  sync.Mutex
	lastActivityReport    activityReportSnapshot
	lastActivityReportSet bool
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

	// Durable ACP permission waiters are in-memory by design: Cloudflare owns
	// durable state, while only the live connection generation may consume an answer.
	interactionMu           sync.Mutex
	interactionConfig       AcpInteractionRuntimeConfig
	interactionGeneration   string
	interactionWaiters      map[string]*acpInteractionWaiter
	urlElicitations         map[string]acpUrlElicitation
	interactionReceipts     map[string]acpInteractionReceipt
	interactionReceiptOrder []string
}

func (h *SessionHost) now() time.Time {
	if h.config.Now != nil {
		return h.config.Now()
	}
	return time.Now()
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
		config:              config,
		status:              HostIdle,
		viewers:             make(map[string]*Viewer),
		messageBuf:          make([]BufferedMessage, 0, 256),
		interactionWaiters:  make(map[string]*acpInteractionWaiter),
		urlElicitations:     make(map[string]acpUrlElicitation),
		interactionReceipts: make(map[string]acpInteractionReceipt),
		ctx:                 ctx,
		cancel:              cancel,
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

// HasRuntimeAssetsProvider reports whether this host was wired to fetch resolved
// project/profile/skill runtime assets. Standalone (cf-container) sessions have no
// devcontainer to read /etc/sam/project-env from, so the provider is the only path
// by which project env vars and runtime files reach the agent process — a nil
// provider there means the session silently starts without them.
func (h *SessionHost) HasRuntimeAssetsProvider() bool {
	return h.config.RuntimeAssetsProvider != nil
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
	// check, the goroutine will exit via lifecycleContext().Done().
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

// Stop kills the agent process, disconnects all viewers, and marks the session
// as stopped. This is the only way to terminate the agent — browser disconnects
// do NOT call this.
func (h *SessionHost) Stop() {
	h.cancelInteractionWaiters("session_stopped")
	h.promptMu.Lock()
	attempt := h.promptAttempt
	activePrompt := h.promptInFlight
	h.promptMu.Unlock()
	if activePrompt && attempt != nil {
		attempt.complete(h, "cancelled", context.Canceled)
	}
	h.mu.Lock()
	if h.status == HostStopped {
		h.mu.Unlock()
		return
	}
	h.closeUsageReportIngress()
	h.setStatusLocked(HostStopped)
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
	h.clearHarnessWork()
	if err := h.waitForUsageReportCallbacks(h.activityReportTimeout()); err != nil {
		slog.Warn("usageReport: shutdown callback drain failed", "error", err)
	}
	if err := h.flushUsageReports(h.activityReportTimeout()); err != nil {
		slog.Warn("usageReport: shutdown flush failed", "error", err)
	}
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

// ensureAgentInstalled checks if the ACP adapter binary exists and installs it
// on-demand if missing.
func (h *SessionHost) ensureAgentInstalled(ctx context.Context, info agentCommandInfo) error {
	if info.verifyOnly {
		if h.config.ProcessLauncher != nil {
			if err := exec.CommandContext(ctx, localShellPath, "-c", info.validationCmd).Run(); err != nil {
				return fmt.Errorf("staged Codex release verification failed: %w", err)
			}
			return nil
		}
		containerID, err := h.config.ContainerResolver()
		if err != nil {
			return fmt.Errorf("failed to discover devcontainer: %w", err)
		}
		return h.ensureCodexRuntimeInContainer(ctx, containerID, info)
	}
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

// stopCurrentAgentLocked stops the current agent process. Must hold h.mu.
func (h *SessionHost) stopCurrentAgentLocked() {
	h.cancelInteractionWaiters("connection_closed")
	// Stop the process-scoped harness heartbeat before clearing the ACP
	// connection. A replacement connection will establish fresh state.
	h.clearHarnessWork()
	if h.process != nil {
		_ = h.process.Stop()
		h.process = nil
	}
	h.acpConn = nil
	h.setSessionIDLocked("")
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

// setSessionIDLocked assigns the ACP session ID and its lock-free mirror.
// Callers must hold h.mu for write.
func (h *SessionHost) setSessionIDLocked(id acpsdk.SessionId) {
	h.sessionID = id
	h.mirrorSessionID.Store(string(id))
}

// setStatusLocked assigns the host status and its lock-free mirror.
// Callers must hold h.mu for write.
func (h *SessionHost) setStatusLocked(status SessionHostStatus) {
	h.status = status
	h.mirrorStatus.Store(status)
}

// loadMirroredSessionID reads the session ID WITHOUT taking h.mu. Safe to call
// from the ACP notification-processing goroutine.
func (h *SessionHost) loadMirroredSessionID() string {
	if v, ok := h.mirrorSessionID.Load().(string); ok {
		return v
	}
	return ""
}

// loadMirroredStatus reads the host status WITHOUT taking h.mu. Safe to call
// from the ACP notification-processing goroutine.
func (h *SessionHost) loadMirroredStatus() SessionHostStatus {
	if v, ok := h.mirrorStatus.Load().(SessionHostStatus); ok {
		return v
	}
	return HostIdle
}
