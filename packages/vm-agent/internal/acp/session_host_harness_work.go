package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

const (
	claudeSDKMessageMethod     = "_claude/sdkMessage"
	claudeHarnessWorkSource    = "claude_sdk"
	claudeBackgroundTasksLevel = "background_tasks_changed"
)

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
	defer c.signalProcessed()
	if method != claudeSDKMessageMethod {
		return nil, acpsdk.NewMethodNotFound(method)
	}

	var notification claudeSDKMessageNotification
	if err := json.Unmarshal(params, &notification); err != nil {
		return nil, fmt.Errorf("decode Claude SDK lifecycle notification: %w", err)
	}
	if !c.host.matchesHarnessSession(notification.SessionID, notification.Message.SessionID) {
		return nil, nil
	}
	if c.host.applyClaudeHarnessLifecycle(notification.Message) {
		c.host.reportActivity(c.host.activityForHarnessWork())
	}
	return nil, nil
}

func (h *SessionHost) matchesHarnessSession(outerSessionID, innerSessionID string) bool {
	h.mu.RLock()
	expected := string(h.sessionID)
	h.mu.RUnlock()
	if expected == "" {
		return false
	}
	return outerSessionID == expected && (innerSessionID == "" || innerSessionID == expected)
}

func (h *SessionHost) resetHarnessWorkForAgent(agentType string) {
	h.harnessWorkMu.Lock()
	h.stopHarnessWorkRereportLocked()
	h.harnessTaskIDs = nil
	h.harnessWork = harnessWorkStatus{}
	if agentType == "claude-code" {
		h.harnessWork.State = harnessWorkInactive
		h.harnessWork.Source = claudeHarnessWorkSource
	}
	h.harnessWorkMu.Unlock()
}

func (h *SessionHost) clearHarnessWork() {
	h.harnessWorkMu.Lock()
	h.stopHarnessWorkRereportLocked()
	h.harnessTaskIDs = nil
	if h.harnessWork.Source != "" {
		h.harnessWork.State = harnessWorkInactive
		h.harnessWork.Count = 0
		h.harnessWork.ProgressAt = h.now()
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
		h.harnessTaskIDs[message.TaskID] = struct{}{}
	case message.Type == "system" && message.Subtype == "task_progress":
		if message.TaskID == "" {
			return false
		}
		h.harnessTaskIDs[message.TaskID] = struct{}{}
	case message.Type == "system" && message.Subtype == "task_updated":
		if message.TaskID == "" {
			return false
		}
		if isTerminalClaudeTaskStatus(message.Patch.Status) {
			delete(h.harnessTaskIDs, message.TaskID)
		} else {
			h.harnessTaskIDs[message.TaskID] = struct{}{}
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
	h.harnessWork.ProgressAt = h.now()
	if h.harnessWork.State == harnessWorkActive {
		h.startHarnessWorkRereportLocked()
	} else {
		h.stopHarnessWorkRereportLocked()
	}
	return true
}

func isTerminalClaudeTaskStatus(status string) bool {
	switch status {
	case "completed", "failed", "killed":
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

func (h *SessionHost) activityForHarnessWork() string {
	h.mu.RLock()
	status := h.status
	h.mu.RUnlock()
	switch status {
	case HostPrompting:
		return "prompting"
	case HostError:
		return "error"
	default:
		return "idle"
	}
}
