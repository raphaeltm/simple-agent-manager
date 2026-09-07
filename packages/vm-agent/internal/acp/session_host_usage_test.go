package acp

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

func TestFetchAgentKeyPropagatesAgentSessionAndCredentialAttribution(t *testing.T) {
	var requestBody struct {
		AgentType      string `json:"agentType"`
		AgentSessionID string `json:"agentSessionId"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workspaces/workspace-1/agent-key" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer callback-token" {
			t.Fatalf("Authorization = %q, want bearer callback token", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&requestBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"apiKey":"sk-test",
			"credentialKind":"api-key",
			"credentialSource":"user",
			"credentialReference":"cc_credentials:cred-1",
			"credentialProvider":"anthropic",
			"providerMode":"direct"
		}`))
	}))
	defer server.Close()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			ControlPlaneURL: server.URL,
			WorkspaceID:     "workspace-1",
			SessionID:       "session-1",
			CallbackToken:   "callback-token",
			HTTPClient:      server.Client(),
		},
	})

	cred, err := host.fetchAgentKey(context.Background(), "claude-code")
	if err != nil {
		t.Fatalf("fetchAgentKey: %v", err)
	}
	if requestBody.AgentType != "claude-code" {
		t.Fatalf("agentType = %q, want claude-code", requestBody.AgentType)
	}
	if requestBody.AgentSessionID != "session-1" {
		t.Fatalf("agentSessionId = %q, want session-1", requestBody.AgentSessionID)
	}
	if cred.credentialReference != "cc_credentials:cred-1" {
		t.Fatalf("credentialReference = %q", cred.credentialReference)
	}
	if cred.credentialSource != "user" {
		t.Fatalf("credentialSource = %q", cred.credentialSource)
	}
	if cred.credentialProvider != "anthropic" {
		t.Fatalf("credentialProvider = %q", cred.credentialProvider)
	}
	if cred.providerMode != "direct" {
		t.Fatalf("providerMode = %q", cred.providerMode)
	}
}

func TestUsageReportFromClaudeRateLimitUsesStoredCredentialAttribution(t *testing.T) {
	fixedNow := time.UnixMilli(1_700_000_000_000)
	var received usageReportPayload
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/projects/project-1/acp-sessions/session-1/usage" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer callback-token" {
			t.Fatalf("Authorization = %q, want bearer callback token", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatalf("decode usage report: %v", err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			ControlPlaneURL:                  server.URL,
			ProjectID:                        "project-1",
			NodeID:                           "node-1",
			WorkspaceID:                      "workspace-1",
			SessionID:                        "session-1",
			CallbackToken:                    "callback-token",
			Now:                              func() time.Time { return fixedNow },
			HTTPClient:                       server.Client(),
			TerminalActivityReportAttempts:   1,
			TerminalActivityReportBackoff:    time.Millisecond,
			ActivityReportTimeout:            time.Second,
			HarnessActivityReportDebounce:    time.Millisecond,
			ClaudeHarnessLifecycleMaxBytes:   4096,
			ClaudeHarnessLifecycleMaxTasks:   16,
			ClaudeHarnessLifecycleMaxIDBytes: 128,
		},
	})
	host.storeCredentialAttribution("claude-code", &agentCredential{
		credentialSource:    "user",
		credentialReference: "cc_credentials:cred-1",
		credentialProvider:  "anthropic",
		providerMode:        "direct",
	})

	request, ok := host.prepareUsageReport(acpsdk.SessionNotification{
		Update: acpsdk.SessionUpdate{
			UsageUpdate: &acpsdk.SessionUsageUpdate{
				SessionUpdate: "usage_update",
				Used:          50,
				Size:          100,
				Meta: map[string]any{
					"_claude/rateLimit": map[string]any{
						"status":        "allowed_warning",
						"rateLimitType": "five_hour",
						"utilization":   0.82,
						"resetsAt":      "2026-09-07T12:00:00Z",
					},
				},
			},
		},
	})
	if !ok {
		t.Fatal("prepareUsageReport returned false")
	}
	if !host.sendUsageReport(request) {
		t.Fatal("sendUsageReport returned false")
	}

	if received.NodeID != "node-1" {
		t.Fatalf("nodeId = %q", received.NodeID)
	}
	if received.AgentType != "claude-code" {
		t.Fatalf("agentType = %q", received.AgentType)
	}
	if received.CredentialReference != "cc_credentials:cred-1" {
		t.Fatalf("credentialReference = %q", received.CredentialReference)
	}
	if received.CredentialSource != "user" {
		t.Fatalf("credentialSource = %q", received.CredentialSource)
	}
	if len(received.RateLimits) != 1 {
		t.Fatalf("rateLimits len = %d, want 1", len(received.RateLimits))
	}
	limit := received.RateLimits[0]
	if limit.WindowType != "claude.five_hour" {
		t.Fatalf("windowType = %q", limit.WindowType)
	}
	if limit.Status != "allowed_warning" {
		t.Fatalf("status = %q", limit.Status)
	}
	if limit.UtilizationPercent == nil || *limit.UtilizationPercent != 82 {
		t.Fatalf("utilizationPercent = %v, want 82", limit.UtilizationPercent)
	}
	if limit.WindowMinutes == nil || *limit.WindowMinutes != 300 {
		t.Fatalf("windowMinutes = %v, want 300", limit.WindowMinutes)
	}
	if limit.ResetsAt == nil || *limit.ResetsAt != time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("resetsAt = %v", limit.ResetsAt)
	}
}

func TestUsageReportFromWireUsageUpdateUsesTypedMeta(t *testing.T) {
	fixedNow := time.UnixMilli(1_700_000_000_000)
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			ControlPlaneURL: "https://control.example",
			ProjectID:       "project-1",
			NodeID:          "node-1",
			WorkspaceID:     "workspace-1",
			SessionID:       "session-1",
			CallbackToken:   "callback-token",
			Now:             func() time.Time { return fixedNow },
		},
	})
	host.storeCredentialAttribution("claude-code", &agentCredential{
		credentialSource:    "user",
		credentialReference: "cc_credentials:cred-1",
		credentialProvider:  "anthropic",
		providerMode:        "direct",
	})

	var notification acpsdk.SessionNotification
	if err := json.Unmarshal([]byte(`{
		"sessionId":"session-1",
		"_meta":{
			"_claude/rateLimit":{
				"status":"rejected",
				"rateLimitType":"five_hour",
				"utilization":1
			}
		},
		"update":{
			"sessionUpdate":"usage_update",
			"used":50,
			"size":100,
			"_meta":{
				"_claude/rateLimit":{
					"status":"allowed_warning",
					"rateLimitType":"seven_day",
					"utilization":0.82,
					"resetsAt":1700100000
				}
			}
		}
	}`), &notification); err != nil {
		t.Fatalf("decode ACP notification: %v", err)
	}

	request, ok := host.prepareUsageReport(notification)
	if !ok {
		t.Fatal("prepareUsageReport returned false")
	}
	if len(request.payload.RateLimits) != 1 {
		t.Fatalf("rateLimits len = %d, want 1", len(request.payload.RateLimits))
	}
	limit := request.payload.RateLimits[0]
	if limit.WindowType != "claude.seven_day" {
		t.Fatalf("windowType = %q, want decoded usage_update metadata", limit.WindowType)
	}
	if limit.Status != "allowed_warning" {
		t.Fatalf("status = %q", limit.Status)
	}
	if limit.ResetsAt == nil || *limit.ResetsAt != 1_700_100_000_000 {
		t.Fatalf("resetsAt = %v, want numeric seconds converted to milliseconds", limit.ResetsAt)
	}
}

func TestUsageReportSkipsContextUsageWithoutRateLimitMetadata(t *testing.T) {
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			ControlPlaneURL: "https://control.example",
			ProjectID:       "project-1",
			NodeID:          "node-1",
			WorkspaceID:     "workspace-1",
			SessionID:       "session-1",
			CallbackToken:   "callback-token",
		},
	})
	host.storeCredentialAttribution("openai-codex", &agentCredential{
		credentialSource:    "user",
		credentialReference: "cc_credentials:cred-1",
		credentialProvider:  "openai",
		providerMode:        "direct",
	})

	_, ok := host.prepareUsageReport(acpsdk.SessionNotification{
		Update: acpsdk.SessionUpdate{
			UsageUpdate: &acpsdk.SessionUsageUpdate{
				SessionUpdate: "usage_update",
				Used:          50,
				Size:          100,
				Meta: map[string]any{
					"quota": map[string]any{
						"_claude/rateLimit": map[string]any{
							"status":        "allowed_warning",
							"rateLimitType": "five_hour",
							"utilization":   0.82,
						},
					},
				},
			},
		},
	})
	if ok {
		t.Fatal("nested _claude/rateLimit must not produce credential-limit telemetry")
	}
}

func TestUsageReportConvertsClaudeNumericResetSecondsToMillis(t *testing.T) {
	fixedNow := time.UnixMilli(1_700_000_000_000)
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			ControlPlaneURL: "https://control.example",
			ProjectID:       "project-1",
			NodeID:          "node-1",
			WorkspaceID:     "workspace-1",
			SessionID:       "session-1",
			CallbackToken:   "callback-token",
			Now:             func() time.Time { return fixedNow },
		},
	})
	host.storeCredentialAttribution("claude-code", &agentCredential{
		credentialSource:    "user",
		credentialReference: "cc_credentials:cred-1",
		credentialProvider:  "anthropic",
		providerMode:        "direct",
	})

	request, ok := host.prepareUsageReport(acpsdk.SessionNotification{
		Update: acpsdk.SessionUpdate{
			UsageUpdate: &acpsdk.SessionUsageUpdate{
				SessionUpdate: "usage_update",
				Used:          50,
				Size:          100,
				Meta: map[string]any{
					"_claude/rateLimit": map[string]any{
						"status":        "allowed_warning",
						"rateLimitType": "seven_day",
						"resetsAt":      float64(1_700_100_000),
					},
				},
			},
		},
	})
	if !ok {
		t.Fatal("prepareUsageReport returned false")
	}
	limit := request.payload.RateLimits[0]
	if limit.ResetsAt == nil || *limit.ResetsAt != 1_700_100_000_000 {
		t.Fatalf("resetsAt = %v, want numeric seconds converted to milliseconds", limit.ResetsAt)
	}
}

func TestUsageReporterPreservesDistinctPendingWindowsAndFlushes(t *testing.T) {
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	received := make(chan string, 3)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload usageReportPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode usage report: %v", err)
		}
		if len(payload.RateLimits) > 0 {
			received <- payload.RateLimits[0].WindowType
		}
		if len(payload.RateLimits) > 0 && payload.RateLimits[0].WindowType == "claude.five_hour" {
			close(firstStarted)
			<-releaseFirst
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			HTTPClient:                     server.Client(),
			TerminalActivityReportAttempts: 1,
			ActivityReportTimeout:          time.Second,
		},
	})
	request := func(window string) usageReportRequest {
		return usageReportRequest{
			url:           server.URL,
			callbackToken: "callback-token",
			payload: usageReportPayload{
				NodeID:              "node-1",
				AgentType:           "claude-code",
				CredentialSource:    "user",
				CredentialReference: "cc_credentials:cred-1",
				Source:              "claude-acp.usage_update",
				RateLimits: []usageLimitPayload{{
					Provider:   "anthropic",
					Source:     "claude-acp.rate_limit",
					WindowType: window,
					Status:     "allowed_warning",
				}},
			},
		}
	}

	host.enqueueUsageReport(request("claude.five_hour"))
	<-firstStarted
	host.enqueueUsageReport(request("claude.seven_day"))
	host.enqueueUsageReport(request("anthropic.requests"))
	close(releaseFirst)

	if err := host.flushUsageReports(time.Second); err != nil {
		t.Fatalf("flushUsageReports: %v", err)
	}
	got := []string{
		readUsageWindow(t, received),
		readUsageWindow(t, received),
		readUsageWindow(t, received),
	}
	want := []string{"claude.five_hour", "claude.seven_day", "anthropic.requests"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("received reports = %#v, want %#v", got, want)
		}
	}
}

func TestUsageReporterCoalescesEquivalentPendingReportsToLatest(t *testing.T) {
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	received := make(chan usageReportPayload, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload usageReportPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode usage report: %v", err)
		}
		received <- payload
		if len(payload.RateLimits) > 0 && payload.RateLimits[0].WindowType == "blocker" {
			close(firstStarted)
			<-releaseFirst
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			HTTPClient:                     server.Client(),
			TerminalActivityReportAttempts: 1,
			ActivityReportTimeout:          time.Second,
		},
	})
	request := func(window string, observedAt int64) usageReportRequest {
		return usageReportRequest{
			url:           server.URL,
			callbackToken: "callback-token",
			payload: usageReportPayload{
				NodeID:              "node-1",
				AgentType:           "claude-code",
				CredentialSource:    "user",
				CredentialReference: "cc_credentials:cred-1",
				Source:              "claude-acp.usage_update",
				ObservedAt:          observedAt,
				RateLimits: []usageLimitPayload{{
					Provider:   "anthropic",
					Source:     "claude-acp.rate_limit",
					WindowType: window,
					Status:     "allowed_warning",
					ObservedAt: observedAt,
				}},
			},
		}
	}

	host.enqueueUsageReport(request("blocker", 1))
	<-firstStarted
	host.enqueueUsageReport(request("claude.five_hour", 2))
	host.enqueueUsageReport(request("claude.five_hour", 3))
	close(releaseFirst)

	if err := host.flushUsageReports(time.Second); err != nil {
		t.Fatalf("flushUsageReports: %v", err)
	}
	first := readUsagePayload(t, received)
	latest := readUsagePayload(t, received)
	if first.RateLimits[0].WindowType != "blocker" {
		t.Fatalf("first window = %q", first.RateLimits[0].WindowType)
	}
	if latest.RateLimits[0].WindowType != "claude.five_hour" || latest.RateLimits[0].ObservedAt != 3 {
		t.Fatalf("coalesced payload = %#v, want latest five-hour observation", latest.RateLimits[0])
	}
	select {
	case extra := <-received:
		t.Fatalf("unexpected extra report: %#v", extra)
	default:
	}
}

func TestSessionUpdateUsageReporterMovesReplacementAfterInterveningTransitionAndRetries(t *testing.T) {
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	received := make(chan usageReportPayload, 4)
	var allowedResetAttempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload usageReportPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode usage report: %v", err)
		}
		received <- payload
		if len(payload.RateLimits) > 0 && payload.RateLimits[0].WindowType == "blocker" {
			close(firstStarted)
			<-releaseFirst
		}
		if len(payload.RateLimits) > 0 &&
			payload.RateLimits[0].WindowType == "claude.five_hour" &&
			payload.RateLimits[0].Status == "allowed" &&
			payload.RateLimits[0].ObservedAt == 3 &&
			allowedResetAttempts.Add(1) == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	var nowMs atomic.Int64
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			ControlPlaneURL:                server.URL,
			ProjectID:                      "project-1",
			NodeID:                         "node-1",
			WorkspaceID:                    "workspace-1",
			SessionID:                      "session-1",
			CallbackToken:                  "callback-token",
			HTTPClient:                     server.Client(),
			TerminalActivityReportAttempts: 2,
			TerminalActivityReportBackoff:  time.Millisecond,
			ActivityReportTimeout:          time.Second,
			Now: func() time.Time {
				return time.UnixMilli(nowMs.Add(1))
			},
		},
	})
	client := usageSessionClientForTest(host)

	host.enqueueUsageReport(usageReportRequestForTest(server.URL, "blocker", "allowed", 0, nil))
	<-firstStarted
	if err := client.SessionUpdate(context.Background(), claudeRateLimitNotification("allowed", "five_hour", 0.5)); err != nil {
		t.Fatalf("SessionUpdate allowed1: %v", err)
	}
	if err := client.SessionUpdate(context.Background(), claudeRateLimitNotification("rejected", "five_hour", 0.5)); err != nil {
		t.Fatalf("SessionUpdate rejected2: %v", err)
	}
	if err := client.SessionUpdate(context.Background(), claudeRateLimitNotification("allowed", "five_hour", 0.5)); err != nil {
		t.Fatalf("SessionUpdate allowed3: %v", err)
	}
	close(releaseFirst)

	if err := host.flushUsageReports(time.Second); err != nil {
		t.Fatalf("flushUsageReports: %v", err)
	}
	got := []usageLimitPayload{
		readUsagePayload(t, received).RateLimits[0],
		readUsagePayload(t, received).RateLimits[0],
		readUsagePayload(t, received).RateLimits[0],
		readUsagePayload(t, received).RateLimits[0],
	}
	if got[0].WindowType != "blocker" {
		t.Fatalf("first window = %q, want blocker", got[0].WindowType)
	}
	if got[1].Status != "rejected" || got[1].ObservedAt != 2 {
		t.Fatalf("second report = %#v, want rejected observation at 2 before reset", got[1])
	}
	if got[2].Status != "allowed" || got[2].ObservedAt != 3 {
		t.Fatalf("third report = %#v, want latest allowed reset at 3", got[2])
	}
	if got[3].Status != "allowed" || got[3].ObservedAt != 3 {
		t.Fatalf("retry report = %#v, want same latest allowed reset at 3", got[3])
	}
	select {
	case extra := <-received:
		t.Fatalf("unexpected extra report: %#v", extra)
	default:
	}
}

func TestUsageReporterKeepsSameStatusThresholdChangesDistinct(t *testing.T) {
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	received := make(chan usageReportPayload, 3)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload usageReportPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode usage report: %v", err)
		}
		received <- payload
		if len(payload.RateLimits) > 0 && payload.RateLimits[0].WindowType == "blocker" {
			close(firstStarted)
			<-releaseFirst
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			HTTPClient:                     server.Client(),
			TerminalActivityReportAttempts: 1,
			ActivityReportTimeout:          time.Second,
		},
	})

	util80 := 80.0
	util95 := 95.0
	host.enqueueUsageReport(usageReportRequestForTest(server.URL, "blocker", "allowed", 0, nil))
	<-firstStarted
	host.enqueueUsageReport(usageReportRequestForTest(server.URL, "claude.five_hour", "allowed_warning", 1, &util80))
	host.enqueueUsageReport(usageReportRequestForTest(server.URL, "claude.five_hour", "allowed_warning", 2, &util95))
	close(releaseFirst)

	if err := host.flushUsageReports(time.Second); err != nil {
		t.Fatalf("flushUsageReports: %v", err)
	}
	_ = readUsagePayload(t, received)
	first := readUsagePayload(t, received).RateLimits[0]
	second := readUsagePayload(t, received).RateLimits[0]
	if first.UtilizationPercent == nil || *first.UtilizationPercent != 80 {
		t.Fatalf("first warning utilization = %v, want 80", first.UtilizationPercent)
	}
	if second.UtilizationPercent == nil || *second.UtilizationPercent != 95 {
		t.Fatalf("second warning utilization = %v, want 95", second.UtilizationPercent)
	}
}

func TestUsageReporterFlushReportsDeliveryFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			HTTPClient:                     server.Client(),
			TerminalActivityReportAttempts: 1,
			ActivityReportTimeout:          time.Second,
		},
	})
	host.enqueueUsageReport(usageReportRequest{
		url:           server.URL,
		callbackToken: "callback-token",
		payload: usageReportPayload{
			NodeID:     "node-1",
			RateLimits: []usageLimitPayload{{WindowType: "claude.five_hour"}},
		},
	})

	if err := host.flushUsageReports(time.Second); err == nil {
		t.Fatal("flushUsageReports returned nil after failed delivery")
	}
}

func TestUsageReporterOverflowMakesDrainFail(t *testing.T) {
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	received := make(chan usageReportPayload, 3)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload usageReportPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode usage report: %v", err)
		}
		received <- payload
		if len(payload.RateLimits) > 0 && payload.RateLimits[0].WindowType == "blocker" {
			close(firstStarted)
			<-releaseFirst
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			HTTPClient:                     server.Client(),
			TerminalActivityReportAttempts: 1,
			ActivityReportTimeout:          time.Second,
		},
		UsageReportPendingLimit: 1,
	})
	host.enqueueUsageReport(usageReportRequestForTest(server.URL, "blocker", "allowed", 0, nil))
	<-firstStarted
	host.enqueueUsageReport(usageReportRequestForTest(server.URL, "claude.five_hour", "allowed_warning", 1, nil))
	host.enqueueUsageReport(usageReportRequestForTest(server.URL, "claude.seven_day", "allowed_warning", 2, nil))
	close(releaseFirst)

	if err := host.flushUsageReports(time.Second); err == nil {
		t.Fatal("flushUsageReports returned nil after queue capacity eviction")
	}
	got := []string{
		readUsagePayload(t, received).RateLimits[0].WindowType,
		readUsagePayload(t, received).RateLimits[0].WindowType,
	}
	want := []string{"blocker", "claude.seven_day"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("received reports = %#v, want %#v", got, want)
		}
	}
	select {
	case extra := <-received:
		t.Fatalf("unexpected extra report after overflow eviction: %#v", extra)
	default:
	}
}

func TestSessionHostStopDrainsUsageReportsBeforeIdleActivity(t *testing.T) {
	server, usageStarted, releaseUsage, events := newLifecycleUsageServer(t, http.StatusNoContent)
	host := newLifecycleUsageHost(server)
	enqueueLifecycleUsageReport(host, server)
	waitUsageStarted(t, usageStarted)

	stopped := make(chan struct{})
	go func() {
		host.Stop()
		close(stopped)
	}()

	assertLifecycleWaitsForUsageDrain(t, stopped, events)
	releaseUsage()
	assertUsagePrecedesIdleActivity(t, stopped, events)
}

func TestSessionHostSuspendDrainsUsageReportsBeforeIdleActivity(t *testing.T) {
	server, usageStarted, releaseUsage, events := newLifecycleUsageServer(t, http.StatusNoContent)
	host := newLifecycleUsageHost(server)
	enqueueLifecycleUsageReport(host, server)
	waitUsageStarted(t, usageStarted)

	suspended := make(chan struct{})
	go func() {
		host.Suspend()
		close(suspended)
	}()

	assertLifecycleWaitsForUsageDrain(t, suspended, events)
	releaseUsage()
	assertUsagePrecedesIdleActivity(t, suspended, events)
}

func TestSessionHostStopLogsUsageDrainFailure(t *testing.T) {
	logs := captureDefaultSlog(t)
	server, usageStarted, releaseUsage, events := newLifecycleUsageServer(t, http.StatusInternalServerError)
	host := newLifecycleUsageHost(server)
	enqueueLifecycleUsageReport(host, server)
	waitUsageStarted(t, usageStarted)
	releaseUsage()

	host.Stop()
	assertLifecycleDeliveredActivity(t, events, "idle")
	if !strings.Contains(logs.String(), "usageReport: shutdown flush failed") {
		t.Fatalf("Stop did not log usage drain failure; logs=%s", logs.String())
	}
}

func TestSessionHostSuspendLogsUsageDrainFailure(t *testing.T) {
	logs := captureDefaultSlog(t)
	server, usageStarted, releaseUsage, events := newLifecycleUsageServer(t, http.StatusInternalServerError)
	host := newLifecycleUsageHost(server)
	enqueueLifecycleUsageReport(host, server)
	waitUsageStarted(t, usageStarted)
	releaseUsage()

	host.Suspend()
	assertLifecycleDeliveredActivity(t, events, "idle")
	if !strings.Contains(logs.String(), "usageReport: suspend flush failed") {
		t.Fatalf("Suspend did not log usage drain failure; logs=%s", logs.String())
	}
}

func TestSessionHostStopAndSuspendCloseUsageIngressBeforeLateACPUsageCallback(t *testing.T) {
	cases := []struct {
		name     string
		shutdown func(*SessionHost)
	}{
		{name: "stop", shutdown: func(host *SessionHost) { host.Stop() }},
		{name: "suspend", shutdown: func(host *SessionHost) { host.Suspend() }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			usageReceived := make(chan usageReportPayload, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/projects/project-1/acp-sessions/session-1/usage":
					var payload usageReportPayload
					if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
						t.Errorf("decode usage report: %v", err)
					}
					usageReceived <- payload
					w.WriteHeader(http.StatusNoContent)
				case "/api/projects/project-1/acp-sessions/session-1/activity":
					w.WriteHeader(http.StatusNoContent)
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			host := newLifecycleUsageHost(server)
			tc.shutdown(host)

			client := &sessionHostClient{
				host: host,
				usageAttribution: credentialAttribution{
					AgentType:           "claude-code",
					CredentialSource:    "user",
					CredentialReference: "cc_credentials:cred-1",
					CredentialProvider:  "anthropic",
					ProviderMode:        "direct",
				},
				hasUsageAttribution: true,
			}
			if err := client.SessionUpdate(context.Background(), claudeRateLimitNotification("allowed_warning", "five_hour", 0.82)); err != nil {
				t.Fatalf("SessionUpdate: %v", err)
			}
			host.usageReportMu.Lock()
			running := host.usageReportRunning
			pending := len(host.usageReportPending)
			host.usageReportMu.Unlock()
			if running || pending != 0 {
				t.Fatalf("late usage callback restarted reporter=%v pending=%d", running, pending)
			}
			select {
			case payload := <-usageReceived:
				t.Fatalf("late usage callback reached control plane: %#v", payload)
			case <-time.After(50 * time.Millisecond):
			}
		})
	}
}

type lifecycleUsageEvent struct {
	kind     string
	activity string
}

func newLifecycleUsageServer(t *testing.T, usageStatus int) (*httptest.Server, <-chan struct{}, func(), <-chan lifecycleUsageEvent) {
	t.Helper()
	usageStarted := make(chan struct{}, 1)
	release := make(chan struct{})
	events := make(chan lifecycleUsageEvent, 8)
	var releaseOnce sync.Once
	releaseUsage := func() {
		releaseOnce.Do(func() { close(release) })
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/projects/project-1/acp-sessions/session-1/usage":
			select {
			case usageStarted <- struct{}{}:
			default:
			}
			<-release
			var payload usageReportPayload
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Errorf("decode usage payload: %v", err)
			}
			events <- lifecycleUsageEvent{kind: "usage"}
			w.WriteHeader(usageStatus)
		case "/api/projects/project-1/acp-sessions/session-1/activity":
			var payload activityPayload
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Errorf("decode activity payload: %v", err)
			}
			events <- lifecycleUsageEvent{kind: "activity", activity: payload.Activity}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(func() {
		releaseUsage()
		server.Close()
	})
	return server, usageStarted, releaseUsage, events
}

func newLifecycleUsageHost(server *httptest.Server) *SessionHost {
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			ControlPlaneURL:                server.URL,
			ProjectID:                      "project-1",
			NodeID:                         "node-1",
			WorkspaceID:                    "workspace-1",
			SessionID:                      "session-1",
			CallbackToken:                  "callback-token",
			HTTPClient:                     server.Client(),
			TerminalActivityReportAttempts: 1,
			TerminalActivityReportBackoff:  time.Millisecond,
			ActivityReportTimeout:          time.Second,
		},
	})
	host.mu.Lock()
	host.agentType = "claude-code"
	host.setSessionIDLocked("acp-session-1")
	host.setStatusLocked(HostReady)
	host.mu.Unlock()
	return host
}

func enqueueLifecycleUsageReport(host *SessionHost, server *httptest.Server) {
	host.enqueueUsageReport(usageReportRequest{
		url:           server.URL + "/api/projects/project-1/acp-sessions/session-1/usage",
		callbackToken: "callback-token",
		payload: usageReportPayload{
			NodeID:              "node-1",
			AgentType:           "claude-code",
			CredentialSource:    "user",
			CredentialReference: "cc_credentials:cred-1",
			Source:              "claude-acp.usage_update",
			RateLimits: []usageLimitPayload{{
				Provider:   "anthropic",
				Source:     "claude-acp.rate_limit",
				WindowType: "claude.five_hour",
				Status:     "allowed_warning",
			}},
		},
	})
}

func waitUsageStarted(t *testing.T, usageStarted <-chan struct{}) {
	t.Helper()
	select {
	case <-usageStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for lifecycle usage request")
	}
}

func assertLifecycleWaitsForUsageDrain(t *testing.T, done <-chan struct{}, events <-chan lifecycleUsageEvent) {
	t.Helper()
	deadline := time.After(75 * time.Millisecond)
	for {
		select {
		case <-done:
			t.Fatal("lifecycle returned before blocked usage report drained")
		case event := <-events:
			if event.kind == "usage" || (event.kind == "activity" && event.activity == "idle") {
				t.Fatalf("lifecycle emitted %s/%s before usage release", event.kind, event.activity)
			}
		case <-deadline:
			return
		}
	}
}

func assertUsagePrecedesIdleActivity(t *testing.T, done <-chan struct{}, events <-chan lifecycleUsageEvent) {
	t.Helper()
	first := readLifecycleEvent(t, events)
	if first.kind != "usage" {
		t.Fatalf("first lifecycle event after release = %#v, want usage before idle activity", first)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("lifecycle did not return after usage release")
	}
	assertLifecycleDeliveredActivity(t, events, "idle")
}

func assertLifecycleDeliveredActivity(t *testing.T, events <-chan lifecycleUsageEvent, activity string) {
	t.Helper()
	deadline := time.After(time.Second)
	for {
		select {
		case event := <-events:
			if event.kind == "activity" && event.activity == activity {
				return
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %q activity", activity)
		}
	}
}

func readLifecycleEvent(t *testing.T, events <-chan lifecycleUsageEvent) lifecycleUsageEvent {
	t.Helper()
	select {
	case event := <-events:
		return event
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for lifecycle event")
		return lifecycleUsageEvent{}
	}
}

func captureDefaultSlog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelWarn})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return &logs
}

func TestSessionUpdateUsesOriginatingACPConnectionCredentialAttribution(t *testing.T) {
	fixedNow := time.UnixMilli(1_700_000_000_000)
	received := make(chan usageReportPayload, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload usageReportPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode usage report: %v", err)
		}
		received <- payload
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			ControlPlaneURL:                server.URL,
			ProjectID:                      "project-1",
			NodeID:                         "node-1",
			WorkspaceID:                    "workspace-1",
			SessionID:                      "session-1",
			CallbackToken:                  "callback-token",
			Now:                            func() time.Time { return fixedNow },
			HTTPClient:                     server.Client(),
			TerminalActivityReportAttempts: 1,
			ActivityReportTimeout:          time.Second,
		},
	})
	host.storeCredentialAttribution("claude-code", &agentCredential{
		credentialSource:    "project",
		credentialReference: "cc_credentials:new",
		credentialProvider:  "anthropic",
		providerMode:        "direct",
	})
	oldAttribution := credentialAttribution{
		AgentType:           "claude-code",
		CredentialSource:    "user",
		CredentialReference: "cc_credentials:old",
		CredentialProvider:  "anthropic",
		ProviderMode:        "direct",
	}
	client := &sessionHostClient{
		host:                host,
		usageAttribution:    oldAttribution,
		hasUsageAttribution: true,
	}

	if err := client.SessionUpdate(context.Background(), acpsdk.SessionNotification{
		Update: acpsdk.SessionUpdate{
			UsageUpdate: &acpsdk.SessionUsageUpdate{
				SessionUpdate: "usage_update",
				Used:          50,
				Size:          100,
				Meta: map[string]any{
					"_claude/rateLimit": map[string]any{
						"status":        "allowed_warning",
						"rateLimitType": "five_hour",
						"utilization":   0.82,
					},
				},
			},
		},
	}); err != nil {
		t.Fatalf("SessionUpdate: %v", err)
	}
	if err := host.flushUsageReports(time.Second); err != nil {
		t.Fatalf("flushUsageReports: %v", err)
	}
	payload := readUsagePayload(t, received)
	if payload.CredentialReference != "cc_credentials:old" || payload.CredentialSource != "user" {
		t.Fatalf("payload credential = %s/%s, want old originating attribution", payload.CredentialSource, payload.CredentialReference)
	}
}

func readUsageWindow(t *testing.T, received <-chan string) string {
	t.Helper()
	select {
	case window := <-received:
		return window
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for usage report")
		return ""
	}
}

func readUsagePayload(t *testing.T, received <-chan usageReportPayload) usageReportPayload {
	t.Helper()
	select {
	case payload := <-received:
		return payload
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for usage report")
		return usageReportPayload{}
	}
}

func usageReportRequestForTest(url, window, status string, observedAt int64, utilization *float64) usageReportRequest {
	return usageReportRequest{
		url:           url,
		callbackToken: "callback-token",
		payload: usageReportPayload{
			NodeID:              "node-1",
			AgentType:           "claude-code",
			CredentialSource:    "user",
			CredentialReference: "cc_credentials:cred-1",
			Source:              "claude-acp.usage_update",
			ObservedAt:          observedAt,
			RateLimits: []usageLimitPayload{{
				Provider:           "anthropic",
				Source:             "claude-acp.rate_limit",
				WindowType:         window,
				Status:             status,
				UtilizationPercent: utilization,
				ObservedAt:         observedAt,
			}},
		},
	}
}

func usageSessionClientForTest(host *SessionHost) *sessionHostClient {
	return &sessionHostClient{
		host: host,
		usageAttribution: credentialAttribution{
			AgentType:           "claude-code",
			CredentialSource:    "user",
			CredentialReference: "cc_credentials:cred-1",
			CredentialProvider:  "anthropic",
			ProviderMode:        "direct",
		},
		hasUsageAttribution: true,
	}
}

func claudeRateLimitNotification(status, window string, utilization float64) acpsdk.SessionNotification {
	return acpsdk.SessionNotification{
		Update: acpsdk.SessionUpdate{
			UsageUpdate: &acpsdk.SessionUsageUpdate{
				SessionUpdate: "usage_update",
				Used:          50,
				Size:          100,
				Meta: map[string]any{
					"_claude/rateLimit": map[string]any{
						"status":        status,
						"rateLimitType": window,
						"utilization":   utilization,
					},
				},
			},
		},
	}
}

func TestSendUsageReportStopsRetryingWhenContextCancelled(t *testing.T) {
	attempted := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-attempted:
		default:
			close(attempted)
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			HTTPClient:                     server.Client(),
			TerminalActivityReportAttempts: 3,
			TerminalActivityReportBackoff:  time.Hour,
			ActivityReportTimeout:          time.Second,
		},
	})
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan bool)
	go func() {
		finished <- host.sendUsageReportWithContext(ctx, usageReportRequest{
			url:           server.URL,
			callbackToken: "callback-token",
			payload: usageReportPayload{
				NodeID:     "node-1",
				RateLimits: []usageLimitPayload{{WindowType: "claude.five_hour"}},
			},
		})
	}()
	<-attempted
	cancel()

	select {
	case ok := <-finished:
		if ok {
			t.Fatal("sendUsageReportWithContext returned true after cancellation")
		}
	case <-time.After(time.Second):
		t.Fatal("sendUsageReportWithContext did not stop after cancellation")
	}
}
