package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/workspace/vm-agent/internal/config"
)

const (
	claudeSDKMessageMethod     = "_claude/sdkMessage"
	claudeHarnessWorkSource    = "claude_sdk"
	acpToolCallWorkSource      = "acp_tool_call"
	claudeBackgroundTasksLevel = "background_tasks_changed"

	// Fallback bounds used when SessionHostConfig leaves them unset (zero).
	// Operators override via CLAUDE_HARNESS_LIFECYCLE_MAX_BYTES /
	// _MAX_TASKS / _MAX_ID_BYTES; see internal/config.
	maxClaudeLifecycleBytes   = 64 * 1024
	maxClaudeLifecycleTasks   = 256
	maxClaudeLifecycleIDBytes = 256
)

// harnessLifecycleLimits resolves the configured bounds, falling back to the
// package defaults so a zero-valued config cannot disable bounding.
func (h *SessionHost) harnessLifecycleLimits() (maxBytes int, maxTasks int, maxIDBytes int) {
	maxBytes, maxTasks, maxIDBytes = maxClaudeLifecycleBytes, maxClaudeLifecycleTasks, maxClaudeLifecycleIDBytes
	if h == nil {
		return
	}
	if h.config.ClaudeHarnessLifecycleMaxBytes > 0 {
		maxBytes = h.config.ClaudeHarnessLifecycleMaxBytes
	}
	if h.config.ClaudeHarnessLifecycleMaxTasks > 0 {
		maxTasks = h.config.ClaudeHarnessLifecycleMaxTasks
	}
	if h.config.ClaudeHarnessLifecycleMaxIDBytes > 0 {
		maxIDBytes = h.config.ClaudeHarnessLifecycleMaxIDBytes
	}
	return
}

type harnessWorkState string

const (
	harnessWorkInactive harnessWorkState = "inactive"
	harnessWorkActive   harnessWorkState = "active"
	harnessWorkSettling harnessWorkState = "settling"
)

type harnessWorkStatus struct {
	State      harnessWorkState
	Count      int
	Source     string
	ProgressAt time.Time
}

// harnessLifecycleSessionMeta opts into only the Claude SDK lifecycle messages
// needed to determine whether harness-owned background work is live. The raw
// messages are consumed locally by the VM Agent and never leave the VM.
func harnessLifecycleSessionMeta(agentType string) map[string]any {
	if agentType != "claude-code" {
		return nil
	}
	return map[string]any{
		"claudeCode": map[string]any{
			"emitRawSDKMessages": []map[string]string{
				{"type": "system", "subtype": claudeBackgroundTasksLevel},
				{"type": "system", "subtype": "task_started"},
				{"type": "system", "subtype": "task_progress"},
				{"type": "system", "subtype": "task_updated"},
				{"type": "system", "subtype": "task_notification"},
				{"type": "result", "origin": "task-notification"},
			},
		},
	}
}

type claudeSDKMessageNotification struct {
	SessionID string                    `json:"sessionId"`
	Message   claudeSDKLifecycleMessage `json:"message"`
}

// claudeSDKLifecycleMessage intentionally models only non-sensitive lifecycle
// fields. Descriptions, prompts, output paths, summaries, and result text are
// never retained, logged, or forwarded to the control plane.
type claudeSDKLifecycleMessage struct {
	Type      string `json:"type"`
	Subtype   string `json:"subtype"`
	SessionID string `json:"session_id"`
	TaskID    string `json:"task_id"`
	Tasks     []struct {
		TaskID string `json:"task_id"`
	} `json:"tasks"`
	Patch struct {
		Status string `json:"status"`
	} `json:"patch"`
	Origin struct {
		Kind string `json:"kind"`
	} `json:"origin"`
}

// HandleExtensionMethod implements acpsdk.ExtensionMethodHandler. Unknown
// extension methods follow ACP's method-not-found contract; notifications do
// not receive an error response from the peer.
func (c *sessionHostClient) HandleExtensionMethod(_ context.Context, method string, params json.RawMessage) (any, error) {
	if method != claudeSDKMessageMethod {
		return nil, acpsdk.NewMethodNotFound(method)
	}
	maxBytes, maxTasks, maxIDBytes := c.host.harnessLifecycleLimits()
	if len(params) > maxBytes {
		return nil, fmt.Errorf("Claude SDK lifecycle notification exceeds %d bytes", maxBytes)
	}

	var notification claudeSDKMessageNotification
	if err := json.Unmarshal(params, &notification); err != nil {
		return nil, fmt.Errorf("decode Claude SDK lifecycle notification: %w", err)
	}
	if !validClaudeLifecycleShape(notification, maxTasks, maxIDBytes) {
		return nil, fmt.Errorf("Claude SDK lifecycle notification exceeds bounded identifier/task limits")
	}
	if !c.host.matchesHarnessSession(notification.SessionID, notification.Message.SessionID) {
		return nil, nil
	}
	if c.host.applyClaudeHarnessLifecycle(notification.Message) {
		c.host.nudgeHarnessActivityReport()
	}
	return nil, nil
}

func validClaudeLifecycleShape(notification claudeSDKMessageNotification, maxTasks int, maxIDBytes int) bool {
	if len(notification.SessionID) > maxIDBytes ||
		len(notification.Message.SessionID) > maxIDBytes ||
		len(notification.Message.TaskID) > maxIDBytes ||
		len(notification.Message.Tasks) > maxTasks {
		return false
	}
	for _, task := range notification.Message.Tasks {
		if len(task.TaskID) > maxIDBytes {
			return false
		}
	}
	return true
}

// matchesHarnessSession runs on the ACP SDK's single notification-processing
// goroutine, so it MUST NOT take h.mu: the handshake holds that lock while its
// in-flight RPC waits on this very goroutine (see the mirror-field comment on
// SessionHost). It reads the lock-free mirror instead.
func (h *SessionHost) matchesHarnessSession(outerSessionID, innerSessionID string) bool {
	expected := h.loadMirroredSessionID()
	if expected == "" {
		return false
	}
	return outerSessionID == expected && (innerSessionID == "" || innerSessionID == expected)
}

func (h *SessionHost) resetHarnessWorkForAgent(agentType string) {
	h.stopHarnessActivityReportCoalescer()
	h.harnessWorkMu.Lock()
	h.stopHarnessWorkRereportLocked()
	progressAt := h.nextHarnessWorkProgressAtLocked()
	h.harnessTaskIDs = nil
	h.harnessWork = harnessWorkStatus{}
	if source := harnessWorkSourceForAgent(agentType); source != "" {
		h.harnessWork.State = harnessWorkInactive
		h.harnessWork.Source = source
		h.harnessWork.ProgressAt = progressAt
	}
	h.harnessWorkMu.Unlock()
}

func harnessWorkSourceForAgent(agentType string) string {
	switch agentType {
	case "claude-code":
		return claudeHarnessWorkSource
	case "openai-codex", "opencode":
		return acpToolCallWorkSource
	default:
		return ""
	}
}

func (h *SessionHost) clearHarnessWork() {
	h.stopHarnessActivityReportCoalescer()
	h.harnessWorkMu.Lock()
	h.stopHarnessWorkRereportLocked()
	h.harnessTaskIDs = nil
	if h.harnessWork.Source != "" {
		h.harnessWork.State = harnessWorkInactive
		h.harnessWork.Count = 0
		h.harnessWork.ProgressAt = h.nextHarnessWorkProgressAtLocked()
	}
	h.harnessWorkMu.Unlock()
}

func (h *SessionHost) harnessWorkSnapshot() harnessWorkStatus {
	h.harnessWorkMu.Lock()
	defer h.harnessWorkMu.Unlock()
	return h.harnessWork
}

func (h *SessionHost) applyClaudeHarnessLifecycle(message claudeSDKLifecycleMessage) bool {
	h.harnessWorkMu.Lock()
	defer h.harnessWorkMu.Unlock()

	if h.harnessWork.Source != claudeHarnessWorkSource {
		return false
	}
	if h.harnessTaskIDs == nil {
		h.harnessTaskIDs = make(map[string]struct{})
	}

	recognized := true
	switch {
	case message.Type == "system" && message.Subtype == claudeBackgroundTasksLevel:
		replacement := make(map[string]struct{}, len(message.Tasks))
		for _, task := range message.Tasks {
			if task.TaskID != "" {
				replacement[task.TaskID] = struct{}{}
			}
		}
		h.harnessTaskIDs = replacement
	case message.Type == "system" && message.Subtype == "task_started":
		if message.TaskID == "" {
			return false
		}
		if !h.addHarnessTaskLocked(message.TaskID) {
			return false
		}
	case message.Type == "system" && message.Subtype == "task_progress":
		if message.TaskID == "" {
			return false
		}
		if !h.addHarnessTaskLocked(message.TaskID) {
			return false
		}
	case message.Type == "system" && message.Subtype == "task_updated":
		if message.TaskID == "" {
			return false
		}
		if isTerminalClaudeTaskStatus(message.Patch.Status) {
			delete(h.harnessTaskIDs, message.TaskID)
		} else if !h.addHarnessTaskLocked(message.TaskID) {
			return false
		}
	case message.Type == "system" && message.Subtype == "task_notification":
		if message.TaskID == "" {
			return false
		}
		delete(h.harnessTaskIDs, message.TaskID)
	case message.Type == "result" && message.Origin.Kind == "task-notification":
		if len(h.harnessTaskIDs) == 0 {
			h.harnessWork.State = harnessWorkInactive
		}
	default:
		recognized = false
	}
	if !recognized {
		return false
	}

	h.harnessWork.Count = len(h.harnessTaskIDs)
	if h.harnessWork.Count > 0 {
		h.harnessWork.State = harnessWorkActive
	} else if message.Type != "result" {
		// The task bookend can be followed by an autonomous completion turn.
		// Report one finite settling lease, but do not heartbeat it indefinitely.
		h.harnessWork.State = harnessWorkSettling
	}
	h.harnessWork.ProgressAt = h.nextHarnessWorkProgressAtLocked()
	if h.harnessWork.State == harnessWorkActive {
		h.startHarnessWorkRereportLocked()
	} else {
		h.stopHarnessWorkRereportLocked()
	}
	return true
}

func (h *SessionHost) applyACPToolCallLifecycle(notification acpsdk.SessionNotification) bool {
	if !h.matchesHarnessSession(string(notification.SessionId), "") {
		return false
	}

	update := notification.Update
	switch {
	case update.ToolCall != nil:
		return h.applyACPToolCallStatus(string(update.ToolCall.ToolCallId), &update.ToolCall.Status)
	case update.ToolCallUpdate != nil:
		// Status is a patch field. Absent means "unchanged", which for lease
		// purposes is treated the same as a non-terminal update.
		return h.applyACPToolCallStatus(
			string(update.ToolCallUpdate.ToolCallId),
			update.ToolCallUpdate.Status,
		)
	default:
		return false
	}
}

func (h *SessionHost) applyACPToolCallStatus(toolCallID string, status *acpsdk.ToolCallStatus) bool {
	if toolCallID == "" {
		return false
	}

	h.harnessWorkMu.Lock()
	defer h.harnessWorkMu.Unlock()

	if h.harnessWork.Source != acpToolCallWorkSource {
		return false
	}
	if h.harnessTaskIDs == nil {
		h.harnessTaskIDs = make(map[string]struct{})
	}

	statusTerminal := status != nil && isTerminalACPToolCallStatus(*status)
	if statusTerminal {
		delete(h.harnessTaskIDs, toolCallID)
	} else if !h.addHarnessTaskLocked(toolCallID) {
		return false
	}

	count := len(h.harnessTaskIDs)
	state := harnessWorkInactive
	if count > 0 {
		state = harnessWorkActive
	}

	// A terminal update that moved nothing is not progress and must not renew the
	// lease: a duplicate, or one arriving for a tool call turn-end reconciliation
	// already dropped, or one for an ID we never tracked while other work is live.
	// Non-terminal updates always fall through — repeated `in_progress` and
	// content-only edges are genuine lifecycle progress from the ACP peer.
	//
	// Note this deliberately DOES report when a late terminal update arrives while
	// the state is `settling`: that is positive evidence the settling lease can be
	// released now rather than waiting it out.
	if statusTerminal && state == h.harnessWork.State && count == h.harnessWork.Count {
		return false
	}

	h.harnessWork.State = state
	h.harnessWork.Count = count
	h.harnessWork.ProgressAt = h.nextHarnessWorkProgressAtLocked()
	if state == harnessWorkActive {
		h.startHarnessWorkRereportLocked()
	} else {
		h.stopHarnessWorkRereportLocked()
	}
	return true
}

// reconcileHarnessWorkAtPromptTurnEnd releases ACP tool-call work when the
// prompt turn ends, reporting one finite settling lease in its place.
//
// ACP has no cross-turn background-work primitive: `session/update` reports tool
// calls incrementally per `toolCallId`, and the `session/prompt` response is the
// authoritative turn boundary. Anything still tracked at that point never
// reported a terminal status — a routine occurrence rather than an anomaly,
// because codex-acp's `turn/completed` handler does not flush pending item state
// and an interrupt drops the pending `tool_call_update` entirely.
//
// Those orphans must not be mistaken for live work. Without this reconciliation
// the tracked set only ever grows, `State` stays `active` for the rest of the
// process's life, and — because `ProgressAt` is one session-wide clock that
// EVERY later tool call re-stamps — the absolute ceiling in the control plane's
// `getFreshHarnessWorkLeaseExpiry` keeps sliding forward, so the safety net that
// is meant to release the session never fires.
//
// Claude's adapter already has the equivalent self-healing primitive: the
// `background_tasks_changed` bookend wholesale-replaces the set with the
// harness's authoritative task list (see applyClaudeHarnessLifecycle). ACP has
// no such message, so the turn boundary is the reconciliation point.
//
// Downgrading to `settling` rather than clearing outright leaves one finite
// lease (`HARNESS_BACKGROUND_WORK_LEASE_MS`) for a tool that genuinely was still
// running, instead of making the session sleep-eligible the instant the turn
// ends. Stopping the re-report loop is what keeps that lease finite.
func (h *SessionHost) reconcileHarnessWorkAtPromptTurnEnd() {
	h.harnessWorkMu.Lock()
	defer h.harnessWorkMu.Unlock()

	if h.harnessWork.Source != acpToolCallWorkSource || len(h.harnessTaskIDs) == 0 {
		return
	}
	h.stopHarnessWorkRereportLocked()
	h.harnessTaskIDs = nil
	h.harnessWork.State = harnessWorkSettling
	h.harnessWork.Count = 0
	h.harnessWork.ProgressAt = h.nextHarnessWorkProgressAtLocked()
}

// addHarnessTaskLocked bounds cumulative edge messages as well as the
// authoritative tasks array. Existing IDs still count as progress at the cap;
// a new ID is ignored until an authoritative replacement or terminal edge
// frees capacity.
func (h *SessionHost) addHarnessTaskLocked(taskID string) bool {
	if _, exists := h.harnessTaskIDs[taskID]; exists {
		return true
	}
	_, maxTasks, _ := h.harnessLifecycleLimits()
	if len(h.harnessTaskIDs) >= maxTasks {
		return false
	}
	h.harnessTaskIDs[taskID] = struct{}{}
	return true
}

// nextHarnessWorkProgressAtLocked returns a process-local, strictly monotonic
// lifecycle version that remains representable as Unix milliseconds. Activity
// reports are sent concurrently and may arrive out of order; ProjectData uses
// this value to reject an older runtime-work snapshot while accepting same-
// version heartbeat rereports that refresh the finite lease.
func (h *SessionHost) nextHarnessWorkProgressAtLocked() time.Time {
	now := h.now()
	if !h.harnessWork.ProgressAt.IsZero() && !now.After(h.harnessWork.ProgressAt) {
		return h.harnessWork.ProgressAt.Add(time.Millisecond)
	}
	if !h.harnessWork.ProgressAt.IsZero() && now.UnixMilli() <= h.harnessWork.ProgressAt.UnixMilli() {
		return time.UnixMilli(h.harnessWork.ProgressAt.UnixMilli() + 1)
	}
	return now
}

func isTerminalClaudeTaskStatus(status string) bool {
	switch status {
	case "completed", "failed", "killed":
		return true
	default:
		return false
	}
}

// acpToolCallStatusCancelled is a terminal tool-call status in the ACP protocol
// that the pinned SDK (coder/acp-go-sdk v0.13.5) predates, so it has no
// generated constant. `ToolCallStatus` is a plain string with no runtime enum
// validation, so a peer sending it unmarshals fine — and treating it as
// non-terminal would leak the tool call in the exact case where the agent DID
// tell us the work is over.
const acpToolCallStatusCancelled acpsdk.ToolCallStatus = "cancelled"

func isTerminalACPToolCallStatus(status acpsdk.ToolCallStatus) bool {
	switch status {
	case acpsdk.ToolCallStatusCompleted, acpsdk.ToolCallStatusFailed, acpToolCallStatusCancelled:
		return true
	default:
		return false
	}
}

func (h *SessionHost) startHarnessWorkRereportLocked() {
	if h.harnessActivityCancel != nil || h.config.ActivityRereportInterval <= 0 {
		return
	}
	ctx, cancel := context.WithCancel(h.ctx)
	h.harnessActivityCancel = cancel
	interval := h.config.ActivityRereportInterval
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				h.reportActivity(h.activityForHarnessWork())
			}
		}
	}()
}

func (h *SessionHost) stopHarnessWorkRereportLocked() {
	if h.harnessActivityCancel != nil {
		h.harnessActivityCancel()
		h.harnessActivityCancel = nil
	}
}

// nudgeHarnessActivityReport records that a harness lifecycle change landed and
// schedules one debounced activity report.
//
// It MUST be used instead of calling reportActivity inline from
// HandleExtensionMethod. reportActivity takes h.mu.RLock to snapshot
// agentType/restartCount/statusErr, and the ACP notification goroutine must
// never block on h.mu: the handshake (startSelectedAgent -> applySessionSettings
// -> SetSessionMode/SetSessionConfigOption) holds h.mu for write while its RPC
// blocks in the SDK's waitNotificationsUpTo, which is waiting for this very
// notification worker. Because setSessionIDLocked populates the session mirror
// *before* applySessionSettings runs, a harness re-announcement arriving in that
// window passes matchesHarnessSession and would deadlock until the settings
// timeout fires — stalling the handshake and every later notification
// (including session/update, i.e. the live stream) behind it.
//
// The debounced single-flight also coalesces bursts: applyClaudeHarnessLifecycle
// returns true for any recognized message, including repeat task_progress that
// mutates nothing, and ACP tool-call streams can emit dozens of edges in one
// turn. The timer reads the current status mirror only after the stream has been
// quiet for the debounce window, so a pre-turn-end edge cannot post stale
// prompting after markPromptDone's authoritative idle report.
func (h *SessionHost) nudgeHarnessActivityReport() {
	select {
	case <-h.ctx.Done():
		return
	default:
	}

	h.harnessReportMu.Lock()
	defer h.harnessReportMu.Unlock()
	h.harnessReportPending = true
	if h.harnessReportRunning {
		return
	}
	h.scheduleHarnessActivityReportLocked(h.harnessActivityReportDebounce())
}

func (h *SessionHost) harnessActivityReportDebounce() time.Duration {
	if h.config.HarnessActivityReportDebounce > 0 {
		return h.config.HarnessActivityReportDebounce
	}
	return config.DefaultACPHarnessActivityReportDebounce
}

func (h *SessionHost) scheduleHarnessActivityReportLocked(delay time.Duration) {
	h.harnessReportSequence++
	sequence := h.harnessReportSequence
	if h.harnessReportTimer != nil {
		h.harnessReportTimer.Stop()
	}
	h.harnessReportTimer = time.AfterFunc(delay, func() {
		h.flushHarnessActivityReport(sequence)
	})
}

func (h *SessionHost) flushHarnessActivityReport(sequence uint64) {
	h.harnessReportMu.Lock()
	if sequence != h.harnessReportSequence {
		h.harnessReportMu.Unlock()
		return
	}
	h.harnessReportTimer = nil
	if !h.harnessReportPending {
		h.harnessReportMu.Unlock()
		return
	}
	h.harnessReportPending = false
	h.harnessReportRunning = true
	h.harnessReportMu.Unlock()

	h.reportCoalescedHarnessActivity()

	h.harnessReportMu.Lock()
	h.harnessReportRunning = false
	if h.harnessReportPending {
		h.scheduleHarnessActivityReportLocked(h.harnessActivityReportDebounce())
	}
	h.harnessReportMu.Unlock()
}

func (h *SessionHost) stopHarnessActivityReportCoalescer() {
	h.harnessReportMu.Lock()
	h.harnessReportSequence++
	h.harnessReportPending = false
	if h.harnessReportTimer != nil {
		h.harnessReportTimer.Stop()
		h.harnessReportTimer = nil
	}
	h.harnessReportMu.Unlock()
}

// activityForHarnessWork is reachable from the ACP notification goroutine, so it
// reads the lock-free status mirror rather than taking h.mu. See
// matchesHarnessSession for why.
func (h *SessionHost) activityForHarnessWork() string {
	switch h.loadMirroredStatus() {
	case HostPrompting:
		return "prompting"
	case HostError:
		return "error"
	default:
		return "idle"
	}
}
