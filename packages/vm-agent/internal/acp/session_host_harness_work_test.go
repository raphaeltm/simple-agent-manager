package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

func TestHarnessLifecycleSessionMetaIsClaudeOnlyAndFiltered(t *testing.T) {
	t.Parallel()

	if got := harnessLifecycleSessionMeta("openai-codex"); got != nil {
		t.Fatalf("Codex metadata = %#v, want nil", got)
	}

	meta := harnessLifecycleSessionMeta("claude-code")
	claudeCode, ok := meta["claudeCode"].(map[string]any)
	if !ok {
		t.Fatalf("claudeCode metadata = %#v, want object", meta["claudeCode"])
	}
	filters, ok := claudeCode["emitRawSDKMessages"].([]map[string]string)
	if !ok {
		t.Fatalf("emitRawSDKMessages = %#v, want filters", claudeCode["emitRawSDKMessages"])
	}
	want := []map[string]string{
		{"type": "system", "subtype": "background_tasks_changed"},
		{"type": "system", "subtype": "task_started"},
		{"type": "system", "subtype": "task_progress"},
		{"type": "system", "subtype": "task_updated"},
		{"type": "system", "subtype": "task_notification"},
		{"type": "result", "origin": "task-notification"},
	}
	if got, wantJSON := mustJSON(t, filters), mustJSON(t, want); got != wantJSON {
		t.Fatalf("filters = %s, want %s", got, wantJSON)
	}
}

func TestClaudeHarnessLifecycleNormalizesLevelProgressAndSettlement(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{})
	host.agentType = "claude-code"
	host.setSessionIDLocked("sdk-session")
	host.resetHarnessWorkForAgent("claude-code")
	client := &sessionHostClient{host: host}

	notifyClaudeLifecycle(t, client, `{
		"sessionId":"sdk-session",
		"message":{"type":"system","subtype":"background_tasks_changed","session_id":"sdk-session","tasks":[
			{"task_id":"one","task_type":"shell","description":"SECRET command"},
			{"task_id":"two","task_type":"agent","description":"SECRET prompt"}
		]}}
`)
	active := host.harnessWorkSnapshot()
	if active.State != harnessWorkActive || active.Count != 2 || active.Source != claudeHarnessWorkSource {
		t.Fatalf("active snapshot = %#v", active)
	}
	if active.ProgressAt.IsZero() {
		t.Fatal("active progress timestamp was not recorded")
	}

	notifyClaudeLifecycle(t, client, `{
		"sessionId":"sdk-session",
		"message":{"type":"system","subtype":"task_progress","session_id":"sdk-session","task_id":"one","description":"SECRET output"}}
`)
	progressed := host.harnessWorkSnapshot()
	if progressed.State != harnessWorkActive || progressed.Count != 2 || progressed.ProgressAt.Before(active.ProgressAt) {
		t.Fatalf("progressed snapshot = %#v, previous = %#v", progressed, active)
	}

	// The authoritative level replaces the edge-derived set.
	notifyClaudeLifecycle(t, client, `{
		"sessionId":"sdk-session",
		"message":{"type":"system","subtype":"background_tasks_changed","session_id":"sdk-session","tasks":[]}}
`)
	settling := host.harnessWorkSnapshot()
	if settling.State != harnessWorkSettling || settling.Count != 0 {
		t.Fatalf("settling snapshot = %#v", settling)
	}

	notifyClaudeLifecycle(t, client, `{
		"sessionId":"sdk-session",
		"message":{"type":"result","subtype":"success","session_id":"sdk-session","origin":{"kind":"task-notification"},"result":"SECRET summary"}}
`)
	inactive := host.harnessWorkSnapshot()
	if inactive.State != harnessWorkInactive || inactive.Count != 0 {
		t.Fatalf("inactive snapshot = %#v", inactive)
	}
}

func TestClaudeHarnessLifecycleRejectsWrongSessionAndMalformedPayload(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{})
	host.setSessionIDLocked("sdk-session")
	host.resetHarnessWorkForAgent("claude-code")
	client := &sessionHostClient{host: host}

	if _, err := client.HandleExtensionMethod(context.Background(), claudeSDKMessageMethod, json.RawMessage(`{"sessionId":"other","message":{"type":"system","subtype":"task_started","task_id":"one"}}`)); err != nil {
		t.Fatalf("wrong-session notification returned error: %v", err)
	}
	if got := host.harnessWorkSnapshot(); got.State != harnessWorkInactive || got.Count != 0 {
		t.Fatalf("wrong-session notification mutated state: %#v", got)
	}

	if _, err := client.HandleExtensionMethod(context.Background(), claudeSDKMessageMethod, json.RawMessage(`{"sessionId":`)); err == nil {
		t.Fatal("malformed Claude lifecycle payload returned nil error")
	}
}

func TestClaudeHarnessLifecycleRejectsOversizedPayloadsAndIdentifiers(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{})
	host.setSessionIDLocked("sdk-session")
	host.resetHarnessWorkForAgent("claude-code")
	client := &sessionHostClient{host: host}

	oversized := json.RawMessage(`{"sessionId":"sdk-session","padding":"` +
		strings.Repeat("x", maxClaudeLifecycleBytes) + `"}`)
	if _, err := client.HandleExtensionMethod(context.Background(), claudeSDKMessageMethod, oversized); err == nil {
		t.Fatal("oversized Claude lifecycle payload returned nil error")
	}
	longID := strings.Repeat("x", maxClaudeLifecycleIDBytes+1)
	payload := json.RawMessage(`{"sessionId":"sdk-session","message":{"type":"system","subtype":"task_started","task_id":"` + longID + `"}}`)
	if _, err := client.HandleExtensionMethod(context.Background(), claudeSDKMessageMethod, payload); err == nil {
		t.Fatal("oversized Claude lifecycle task identifier returned nil error")
	}
	if got := host.harnessWorkSnapshot(); got.State != harnessWorkInactive || got.Count != 0 {
		t.Fatalf("rejected lifecycle payload mutated state: %#v", got)
	}
}

func TestClaudeHarnessLifecycleBoundsCumulativeEdgeTaskIDs(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{})
	host.resetHarnessWorkForAgent("claude-code")
	for index := 0; index < maxClaudeLifecycleTasks+25; index++ {
		host.applyClaudeHarnessLifecycle(claudeSDKLifecycleMessage{
			Type:    "system",
			Subtype: "task_started",
			TaskID:  fmt.Sprintf("task-%03d", index),
		})
	}

	if got := host.harnessWorkSnapshot(); got.Count != maxClaudeLifecycleTasks {
		t.Fatalf("cumulative task count = %d, want bounded %d", got.Count, maxClaudeLifecycleTasks)
	}
	host.harnessWorkMu.Lock()
	defer host.harnessWorkMu.Unlock()
	if len(host.harnessTaskIDs) != maxClaudeLifecycleTasks {
		t.Fatalf("retained task IDs = %d, want %d", len(host.harnessTaskIDs), maxClaudeLifecycleTasks)
	}
}

func TestACPToolCallLifecycleTracksCodexAndOpencodeWork(t *testing.T) {
	t.Parallel()

	for _, agentType := range []string{"openai-codex", "opencode"} {
		agentType := agentType
		t.Run(agentType, func(t *testing.T) {
			t.Parallel()

			host, client := newHarnessWorkTestClient(t, SessionHostConfig{}, agentType, "acp-session", HostPrompting)

			notifyACPToolCall(t, client, "acp-session", "tool-1", "Read file", acpsdk.ToolCallStatusPending, nil)
			active := host.harnessWorkSnapshot()
			if active.State != harnessWorkActive || active.Count != 1 || active.Source != acpToolCallWorkSource {
				t.Fatalf("active snapshot = %#v", active)
			}
			if active.ProgressAt.IsZero() {
				t.Fatal("active progress timestamp was not recorded")
			}

			notifyACPToolCallUpdate(t, client, "acp-session", "tool-1", toolStatus(acpsdk.ToolCallStatusInProgress))
			progressed := host.harnessWorkSnapshot()
			if progressed.State != harnessWorkActive || progressed.Count != 1 || !progressed.ProgressAt.After(active.ProgressAt) {
				t.Fatalf("progressed snapshot = %#v, previous = %#v", progressed, active)
			}

			// Content-only updates for a known tool still represent real ACP tool
			// progress and must keep the renewable lease alive.
			notifyACPToolCallUpdate(t, client, "acp-session", "tool-1", nil)
			contentOnly := host.harnessWorkSnapshot()
			if contentOnly.State != harnessWorkActive || contentOnly.Count != 1 || !contentOnly.ProgressAt.After(progressed.ProgressAt) {
				t.Fatalf("content-only snapshot = %#v, previous = %#v", contentOnly, progressed)
			}

			notifyACPToolCallUpdate(t, client, "acp-session", "tool-1", toolStatus(acpsdk.ToolCallStatusCompleted))
			inactive := host.harnessWorkSnapshot()
			if inactive.State != harnessWorkInactive || inactive.Count != 0 || inactive.Source != acpToolCallWorkSource {
				t.Fatalf("inactive snapshot = %#v", inactive)
			}
		})
	}
}

func TestACPToolCallCancelledStatusEndsWork(t *testing.T) {
	t.Parallel()

	host, client := newHarnessWorkTestClient(t, SessionHostConfig{}, "openai-codex", "acp-session", HostPrompting)

	notifyACPToolCall(t, client, "acp-session", "tool-1", "Run command", acpsdk.ToolCallStatusInProgress, nil)
	if got := host.harnessWorkSnapshot(); got.State != harnessWorkActive || got.Count != 1 {
		t.Fatalf("active snapshot = %#v", got)
	}

	// `cancelled` is terminal in the ACP protocol but has no constant in the
	// pinned SDK. Treating it as non-terminal would leak the tool call in the one
	// case where the agent explicitly told us the work is over.
	notifyACPToolCallUpdate(t, client, "acp-session", "tool-1", toolStatus(acpToolCallStatusCancelled))
	released := host.harnessWorkSnapshot()
	if released.State != harnessWorkInactive || released.Count != 0 {
		t.Fatalf("cancelled tool call did not release work: %#v", released)
	}

	// A repeat terminal update moved nothing, so it is not progress and must not
	// renew the lease by advancing the progress clock.
	notifyACPToolCallUpdate(t, client, "acp-session", "tool-1", toolStatus(acpToolCallStatusCancelled))
	if got := host.harnessWorkSnapshot(); !got.ProgressAt.Equal(released.ProgressAt) {
		t.Fatalf("no-op terminal update renewed the lease: %#v -> %#v", released, got)
	}

	// A terminal update for an ID we never tracked must not disturb live work.
	notifyACPToolCall(t, client, "acp-session", "tool-live", "Read file", acpsdk.ToolCallStatusInProgress, nil)
	live := host.harnessWorkSnapshot()
	notifyACPToolCallUpdate(t, client, "acp-session", "tool-unknown", toolStatus(acpsdk.ToolCallStatusCompleted))
	if got := host.harnessWorkSnapshot(); got.State != harnessWorkActive || got.Count != 1 || !got.ProgressAt.Equal(live.ProgressAt) {
		t.Fatalf("unknown terminal ID disturbed live work: %#v -> %#v", live, got)
	}
}

// A late terminal update is positive evidence that the settling lease can be
// released now rather than waited out.
func TestACPToolCallLateTerminalUpdateReleasesSettlingLease(t *testing.T) {
	t.Parallel()

	host, client := newHarnessWorkTestClient(t, SessionHostConfig{}, "openai-codex", "acp-session", HostPrompting)

	notifyACPToolCall(t, client, "acp-session", "tool-orphan", "Run command", acpsdk.ToolCallStatusInProgress, nil)
	endPromptTurn(t, host, "end_turn", nil)
	settled := host.harnessWorkSnapshot()
	if settled.State != harnessWorkSettling {
		t.Fatalf("expected settling before the late update: %#v", settled)
	}

	notifyACPToolCallUpdate(t, client, "acp-session", "tool-orphan", toolStatus(acpsdk.ToolCallStatusCompleted))
	if got := host.harnessWorkSnapshot(); got.State != harnessWorkInactive || got.Count != 0 || !got.ProgressAt.After(settled.ProgressAt) {
		t.Fatalf("late terminal update did not release the settling lease: %#v -> %#v", settled, got)
	}
}

// The ACP peer is not required to report a terminal status for every tool call:
// codex-acp's `turn/completed` does not flush pending item state, and an
// interrupt drops the pending `tool_call_update`. The turn boundary must
// therefore reconcile, or the orphan pins the session for the rest of the
// process's life (see reconcileHarnessWorkAtPromptTurnEnd).
func TestACPToolCallOrphanedAtPromptTurnEndSettlesAndDoesNotLeakAcrossTurns(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name       string
		stopReason string
		err        error
	}{
		{name: "natural completion", stopReason: "end_turn"},
		{name: "user cancellation", stopReason: "cancelled", err: context.Canceled},
		{name: "prompt error", stopReason: "error", err: errors.New("peer disconnected")},
	} {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			host, client := newHarnessWorkTestClient(t, SessionHostConfig{}, "openai-codex", "acp-session", HostPrompting)

			// Turn 1: a tool call starts and never reports a terminal status.
			notifyACPToolCall(t, client, "acp-session", "tool-orphan", "Run command", acpsdk.ToolCallStatusInProgress, nil)
			active := host.harnessWorkSnapshot()
			if active.State != harnessWorkActive || active.Count != 1 {
				t.Fatalf("active snapshot = %#v", active)
			}

			endPromptTurn(t, host, tc.stopReason, tc.err)

			settled := host.harnessWorkSnapshot()
			if settled.State != harnessWorkSettling || settled.Count != 0 {
				t.Fatalf("orphaned tool call was not reconciled at turn end: %#v", settled)
			}
			if !settled.ProgressAt.After(active.ProgressAt) {
				t.Fatalf("reconciliation did not advance the progress clock: %#v -> %#v", active, settled)
			}

			// Turn 2: an unrelated tool call must be tracked on its own, and
			// completing it must return the session to inactive. Before
			// reconciliation the orphan kept Count at 1 here, so the session never
			// went inactive AND every one of these edges re-stamped the shared
			// progress clock, sliding the control plane's absolute ceiling forward
			// indefinitely.
			host.setStatus(HostPrompting, "")
			notifyACPToolCall(t, client, "acp-session", "tool-2", "Read file", acpsdk.ToolCallStatusPending, nil)
			if got := host.harnessWorkSnapshot(); got.State != harnessWorkActive || got.Count != 1 {
				t.Fatalf("second-turn snapshot = %#v", got)
			}
			notifyACPToolCallUpdate(t, client, "acp-session", "tool-2", toolStatus(acpsdk.ToolCallStatusCompleted))
			if got := host.harnessWorkSnapshot(); got.State != harnessWorkInactive || got.Count != 0 {
				t.Fatalf("orphan from the previous turn still pins work: %#v", got)
			}
		})
	}
}

// Discriminating control for the reconciliation above: Claude's background tasks
// are genuinely allowed to outlive a prompt turn (that is the entire reason the
// `claude_sdk` adapter exists), so the same turn-end hook must leave them alone.
// This fails if reconcileHarnessWorkAtPromptTurnEnd is generalised to all sources.
func TestClaudeBackgroundWorkSurvivesPromptTurnEnd(t *testing.T) {
	t.Parallel()

	host, client := newHarnessWorkTestClient(t, SessionHostConfig{}, "claude-code", "sdk-session", HostPrompting)

	notifyClaudeLifecycle(t, client, `{
		"sessionId":"sdk-session",
		"message":{"type":"system","subtype":"task_started","session_id":"sdk-session","task_id":"one"}}
`)
	if got := host.harnessWorkSnapshot(); got.State != harnessWorkActive || got.Count != 1 {
		t.Fatalf("claude active snapshot = %#v", got)
	}

	endPromptTurn(t, host, "end_turn", nil)

	if got := host.harnessWorkSnapshot(); got.State != harnessWorkActive || got.Count != 1 || got.Source != claudeHarnessWorkSource {
		t.Fatalf("claude background work was reconciled away at turn end: %#v", got)
	}
}

// The settling lease must be finite: reconciliation stops the re-report loop, so
// `runtimeWorkUpdatedAt` stops advancing and the control-plane lease expires.
func TestACPToolCallSettlingLeaseStopsRereporting(t *testing.T) {
	t.Parallel()

	reports := newActivityReportCapture(t)
	host, client := newHarnessWorkTestClient(t, SessionHostConfig{GatewayConfig: GatewayConfig{
		ProjectID:                "project",
		NodeID:                   "node",
		SessionID:                "sam-session",
		ControlPlaneURL:          reports.server.URL,
		CallbackToken:            "token",
		HTTPClient:               reports.server.Client(),
		ActivityRereportInterval: 10 * time.Millisecond,
	}}, "openai-codex", "acp-session", HostPrompting)

	notifyACPToolCall(t, client, "acp-session", "tool-orphan", "Run command", acpsdk.ToolCallStatusInProgress, nil)
	waitFor(t, 300*time.Millisecond, func() bool { return reports.count() >= 2 })

	endPromptTurn(t, host, "end_turn", nil)
	waitFor(t, 300*time.Millisecond, func() bool { return reports.count() >= 3 })

	// Liveness first: the settling downgrade itself reached the control plane.
	_, payloads := reports.snapshot()
	last := payloads[len(payloads)-1]
	if last.RuntimeWorkState != string(harnessWorkSettling) || last.RuntimeWorkCount == nil || *last.RuntimeWorkCount != 0 {
		t.Fatalf("settling downgrade was not reported: %#v", last)
	}

	settledCount := reports.count()
	time.Sleep(60 * time.Millisecond)
	if got := reports.count(); got != settledCount {
		t.Fatalf("re-report loop kept renewing the lease after turn end: %d -> %d", settledCount, got)
	}
}

func TestACPToolCallLifecycleRejectsWrongSessionAndReplay(t *testing.T) {
	t.Parallel()

	host, client := newHarnessWorkTestClient(t, SessionHostConfig{}, "openai-codex", "acp-session", HostPrompting)

	notifyACPToolCall(t, client, "other-session", "tool-1", "Read file", "", nil)
	if got := host.harnessWorkSnapshot(); got.State != harnessWorkInactive || got.Count != 0 {
		t.Fatalf("wrong-session update mutated state: %#v", got)
	}

	host.replaySuppressed.Store(true)
	notifyACPToolCall(t, client, "acp-session", "tool-1", "Read file", "", nil)
	if got := host.harnessWorkSnapshot(); got.State != harnessWorkInactive || got.Count != 0 {
		t.Fatalf("replay-suppressed update mutated state: %#v", got)
	}
}

func TestACPToolCallsDoNotOverrideClaudeLifecycleSource(t *testing.T) {
	t.Parallel()

	host, client := newHarnessWorkTestClient(t, SessionHostConfig{}, "claude-code", "sdk-session", HostPrompting)

	notifyACPToolCall(t, client, "sdk-session", "tool-1", "Read file", "", nil)
	if got := host.harnessWorkSnapshot(); got.Source != claudeHarnessWorkSource || got.State != harnessWorkInactive || got.Count != 0 {
		t.Fatalf("Claude source was overwritten by ACP tool call: %#v", got)
	}

	notifyClaudeLifecycle(t, client, `{
		"sessionId":"sdk-session",
		"message":{"type":"system","subtype":"task_started","session_id":"sdk-session","task_id":"one"}}
`)
	if got := host.harnessWorkSnapshot(); got.Source != claudeHarnessWorkSource || got.State != harnessWorkActive || got.Count != 1 {
		t.Fatalf("Claude lifecycle stopped working after ACP tool call: %#v", got)
	}
}

func TestACPToolCallActivityReportsOnlyNormalizedState(t *testing.T) {
	t.Parallel()

	reports := newActivityReportCapture(t)

	_, client := newHarnessWorkTestClient(t, SessionHostConfig{GatewayConfig: GatewayConfig{
		ProjectID:                "project",
		NodeID:                   "node",
		SessionID:                "sam-session",
		ControlPlaneURL:          reports.server.URL,
		CallbackToken:            "token",
		HTTPClient:               reports.server.Client(),
		ActivityRereportInterval: 10 * time.Millisecond,
	}}, "openai-codex", "acp-session", HostReady)

	notifyACPToolCall(t, client, "acp-session", "tool-secret-id", "SECRET command", "", map[string]any{"prompt": "SECRET prompt"})
	waitFor(t, 300*time.Millisecond, func() bool {
		return reports.count() >= 1
	})

	gotBodies, gotPayloads := reports.snapshot()
	for _, body := range gotBodies {
		if strings.Contains(body, "SECRET") || strings.Contains(body, "tool-secret-id") {
			t.Fatalf("activity report leaked raw ACP tool-call payload: %s", body)
		}
	}
	for _, payload := range gotPayloads {
		if payload.RuntimeWorkState != string(harnessWorkActive) || payload.RuntimeWorkCount == nil || *payload.RuntimeWorkCount != 1 || payload.RuntimeWorkSource != acpToolCallWorkSource {
			t.Fatalf("normalized ACP tool-call payload = %#v", payload)
		}
	}
}

func TestHarnessActivityReportsOnlyNormalizedStateAndRereportsActiveWork(t *testing.T) {
	t.Parallel()

	reports := newActivityReportCapture(t)

	host, client := newHarnessWorkTestClient(t, SessionHostConfig{GatewayConfig: GatewayConfig{
		ProjectID:                "project",
		NodeID:                   "node",
		SessionID:                "sam-session",
		ControlPlaneURL:          reports.server.URL,
		CallbackToken:            "token",
		HTTPClient:               reports.server.Client(),
		ActivityRereportInterval: 10 * time.Millisecond,
	}}, "claude-code", "sdk-session", HostReady)

	notifyClaudeLifecycle(t, client, `{
		"sessionId":"sdk-session",
		"message":{"type":"system","subtype":"task_started","session_id":"sdk-session","task_id":"one","description":"SECRET raw description"}}
`)
	waitFor(t, 300*time.Millisecond, func() bool {
		return reports.count() >= 2
	})

	gotBodies, gotPayloads := reports.snapshot()
	for _, body := range gotBodies {
		if strings.Contains(body, "SECRET") || strings.Contains(body, "task_id") || strings.Contains(body, "description") {
			t.Fatalf("activity report leaked raw lifecycle payload: %s", body)
		}
	}
	for _, payload := range gotPayloads {
		if payload.RuntimeWorkState != string(harnessWorkActive) || payload.RuntimeWorkCount == nil || *payload.RuntimeWorkCount != 1 || payload.RuntimeWorkSource != claudeHarnessWorkSource {
			t.Fatalf("normalized payload = %#v", payload)
		}
	}

	notifyClaudeLifecycle(t, client, `{
		"sessionId":"sdk-session",
		"message":{"type":"system","subtype":"task_notification","session_id":"sdk-session","task_id":"one","status":"completed","summary":"SECRET result"}}
`)
	waitFor(t, 300*time.Millisecond, func() bool {
		_, payloads := reports.snapshot()
		for _, payload := range payloads {
			if payload.RuntimeWorkState == string(harnessWorkSettling) {
				return true
			}
		}
		return false
	})

	// Settling is a finite lease: unlike active work, it must not heartbeat forever.
	time.Sleep(5 * host.config.ActivityRereportInterval)
	afterSettle := reports.count()
	time.Sleep(5 * host.config.ActivityRereportInterval)
	if got := reports.count(); got != afterSettle {
		t.Fatalf("settling work kept heartbeating: before=%d after=%d", afterSettle, got)
	}
}

func TestHarnessActivityStopsWhenCrashRestartFailsBeforeAttach(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	reports := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		reports++
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	process := newExitedAgentProcess(t, "claude-code")
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{
		ProjectID:                "project",
		NodeID:                   "node",
		SessionID:                "sam-session",
		ControlPlaneURL:          server.URL,
		CallbackToken:            "token",
		HTTPClient:               server.Client(),
		ActivityRereportInterval: 10 * time.Millisecond,
		ContainerResolver:        func() (string, error) { return "", errors.New("container unavailable") },
	}})
	defer host.Stop()
	host.mu.Lock()
	host.process = process
	host.agentType = "claude-code"
	host.setSessionIDLocked("sdk-session")
	host.setStatusLocked(HostReady)
	host.mu.Unlock()
	host.resetHarnessWorkForAgent("claude-code")
	client := &sessionHostClient{host: host}
	notifyClaudeLifecycle(t, client, `{
		"sessionId":"sdk-session",
		"message":{"type":"system","subtype":"task_started","session_id":"sdk-session","task_id":"one"}}
`)
	waitFor(t, 300*time.Millisecond, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return reports >= 2
	})

	host.monitorProcessExit(context.Background(), process, "claude-code", nil, nil)
	if got := host.harnessWorkSnapshot(); got.State != harnessWorkInactive || got.Count != 0 {
		t.Fatalf("harness work after failed restart = %#v, want inactive", got)
	}
	host.harnessWorkMu.Lock()
	if host.harnessActivityCancel != nil {
		host.harnessWorkMu.Unlock()
		t.Fatal("harness rereport ticker survived failed restart")
	}
	host.harnessWorkMu.Unlock()

	// Let the final error activity request settle, then prove no ticker keeps
	// renewing the old active lease.
	time.Sleep(5 * host.config.ActivityRereportInterval)
	mu.Lock()
	afterFailure := reports
	mu.Unlock()
	time.Sleep(5 * host.config.ActivityRereportInterval)
	mu.Lock()
	defer mu.Unlock()
	if reports != afterFailure {
		t.Fatalf("failed-restart harness work kept heartbeating: before=%d after=%d", afterFailure, reports)
	}
}

type readRecorder struct {
	reader   interface{ Read([]byte) (int, error) }
	recorded *strings.Builder
}

func (r *readRecorder) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	_, _ = r.recorded.Write(p[:n])
	return n, err
}

func notifyClaudeLifecycle(t *testing.T, client *sessionHostClient, payload string) {
	t.Helper()
	if _, err := client.HandleExtensionMethod(context.Background(), claudeSDKMessageMethod, json.RawMessage(payload)); err != nil {
		t.Fatalf("HandleExtensionMethod: %v", err)
	}
}

func newHarnessWorkTestClient(t *testing.T, config SessionHostConfig, agentType string, sessionID string, status SessionHostStatus) (*SessionHost, *sessionHostClient) {
	t.Helper()

	host := NewSessionHost(config)
	t.Cleanup(host.Stop)
	host.mu.Lock()
	host.agentType = agentType
	host.setSessionIDLocked(acpsdk.SessionId(sessionID))
	host.setStatusLocked(status)
	host.mu.Unlock()
	host.resetHarnessWorkForAgent(agentType)
	return host, &sessionHostClient{host: host}
}

func notifyACPToolCall(t *testing.T, client *sessionHostClient, sessionID string, toolCallID string, title string, status acpsdk.ToolCallStatus, rawInput map[string]any) {
	t.Helper()

	if err := client.SessionUpdate(context.Background(), acpsdk.SessionNotification{
		SessionId: acpsdk.SessionId(sessionID),
		Update: acpsdk.SessionUpdate{
			ToolCall: &acpsdk.SessionUpdateToolCall{
				ToolCallId: acpsdk.ToolCallId(toolCallID),
				Title:      title,
				Status:     status,
				RawInput:   rawInput,
			},
		},
	}); err != nil {
		t.Fatalf("SessionUpdate tool_call: %v", err)
	}
}

func notifyACPToolCallUpdate(t *testing.T, client *sessionHostClient, sessionID string, toolCallID string, status *acpsdk.ToolCallStatus) {
	t.Helper()

	if err := client.SessionUpdate(context.Background(), acpsdk.SessionNotification{
		SessionId: acpsdk.SessionId(sessionID),
		Update: acpsdk.SessionUpdate{
			ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
				ToolCallId: acpsdk.ToolCallId(toolCallID),
				Status:     status,
			},
		},
	}); err != nil {
		t.Fatalf("SessionUpdate tool_call_update: %v", err)
	}
}

func toolStatus(status acpsdk.ToolCallStatus) *acpsdk.ToolCallStatus {
	return &status
}

// endPromptTurn drives the real turn-end sequence rather than calling
// markPromptDone directly: production reaches it only through
// promptAttempt.completeWith, which is the single terminal owner shared by
// finishPrompt, finishPromptCancelled, and finishPromptAttemptWithError.
func endPromptTurn(t *testing.T, host *SessionHost, stopReason string, promptErr error) {
	t.Helper()

	_, cancel := context.WithCancel(context.Background())
	attempt, started := host.beginPrompt(cancel, nil)
	if !started {
		t.Fatal("beginPrompt did not start an attempt")
	}
	if !attempt.completeWith(host, stopReason, promptErr, host.markPromptDone) {
		t.Fatal("completeWith did not claim the prompt terminal")
	}
}

type activityReportCapture struct {
	server   *httptest.Server
	mu       sync.Mutex
	bodies   []string
	payloads []activityPayload
}

func newActivityReportCapture(t *testing.T) *activityReportCapture {
	t.Helper()

	capture := &activityReportCapture{}
	capture.server = httptest.NewServer(http.HandlerFunc(capture.handle))
	t.Cleanup(capture.server.Close)
	return capture
}

func (capture *activityReportCapture) handle(w http.ResponseWriter, r *http.Request) {
	var payload activityPayload
	var raw strings.Builder
	decoder := json.NewDecoder(&readRecorder{reader: r.Body, recorded: &raw})
	if err := decoder.Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	capture.mu.Lock()
	capture.bodies = append(capture.bodies, raw.String())
	capture.payloads = append(capture.payloads, payload)
	capture.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (capture *activityReportCapture) count() int {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	return len(capture.payloads)
}

func (capture *activityReportCapture) snapshot() ([]string, []activityPayload) {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	return append([]string(nil), capture.bodies...), append([]activityPayload(nil), capture.payloads...)
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(encoded)
}
