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

func TestHarnessActivityReportsOnlyNormalizedStateAndRereportsActiveWork(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	bodies := make([]string, 0)
	payloads := make([]activityPayload, 0)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload activityPayload
		decoder := json.NewDecoder(r.Body)
		var raw strings.Builder
		tee := &readRecorder{reader: r.Body, recorded: &raw}
		decoder = json.NewDecoder(tee)
		if err := decoder.Decode(&payload); err != nil {
			t.Errorf("decode activity payload: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		bodies = append(bodies, raw.String())
		payloads = append(payloads, payload)
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{
		ProjectID:                "project",
		NodeID:                   "node",
		SessionID:                "sam-session",
		ControlPlaneURL:          server.URL,
		CallbackToken:            "token",
		HTTPClient:               server.Client(),
		ActivityRereportInterval: 10 * time.Millisecond,
	}})
	host.mu.Lock()
	host.agentType = "claude-code"
	host.setSessionIDLocked("sdk-session")
	host.setStatusLocked(HostReady)
	host.mu.Unlock()
	host.resetHarnessWorkForAgent("claude-code")
	client := &sessionHostClient{host: host}

	notifyClaudeLifecycle(t, client, `{
		"sessionId":"sdk-session",
		"message":{"type":"system","subtype":"task_started","session_id":"sdk-session","task_id":"one","description":"SECRET raw description"}}
`)
	waitFor(t, 300*time.Millisecond, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(payloads) >= 2
	})

	mu.Lock()
	gotBodies := append([]string(nil), bodies...)
	gotPayloads := append([]activityPayload(nil), payloads...)
	mu.Unlock()
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
		mu.Lock()
		defer mu.Unlock()
		for _, payload := range payloads {
			if payload.RuntimeWorkState == string(harnessWorkSettling) {
				return true
			}
		}
		return false
	})

	// Settling is a finite lease: unlike active work, it must not heartbeat forever.
	time.Sleep(5 * host.config.ActivityRereportInterval)
	mu.Lock()
	afterSettle := len(payloads)
	mu.Unlock()
	time.Sleep(5 * host.config.ActivityRereportInterval)
	mu.Lock()
	defer mu.Unlock()
	if len(payloads) != afterSettle {
		t.Fatalf("settling work kept heartbeating: before=%d after=%d", afterSettle, len(payloads))
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

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(encoded)
}
