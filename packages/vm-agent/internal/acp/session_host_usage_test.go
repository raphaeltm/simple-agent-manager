package acp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

func TestUsageReporterCoalescesPendingReportsAndFlushes(t *testing.T) {
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	done := make(chan struct{})
	var received []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload usageReportPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode usage report: %v", err)
		}
		if len(payload.RateLimits) > 0 {
			received = append(received, payload.RateLimits[0].WindowType)
		}
		if len(received) == 1 {
			close(firstStarted)
			<-releaseFirst
		}
		w.WriteHeader(http.StatusNoContent)
		if len(received) >= 2 {
			close(done)
		}
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
				NodeID: "node-1",
				RateLimits: []usageLimitPayload{{
					WindowType: window,
				}},
			},
		}
	}

	host.enqueueUsageReport(request("first"))
	<-firstStarted
	host.enqueueUsageReport(request("second"))
	host.enqueueUsageReport(request("third"))
	close(releaseFirst)

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for coalesced usage report")
	}
	if !host.flushUsageReports(time.Second) {
		t.Fatal("flushUsageReports returned false")
	}
	if len(received) != 2 || received[0] != "first" || received[1] != "third" {
		t.Fatalf("received reports = %#v, want first and coalesced latest third", received)
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
