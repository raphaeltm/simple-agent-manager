package acp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
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

	raw := []byte(`{
		"update": {
			"sessionUpdate": "usage_update",
			"used": 50,
			"size": 100,
			"_meta": {
				"_claude/rateLimit": {
					"status": "allowed_warning",
					"rateLimitType": "five_hour",
					"utilization": 0.82,
					"resetsAt": "2026-09-07T12:00:00Z"
				}
			}
		}
	}`)
	request, ok := host.prepareUsageReportFromRaw(raw)
	if !ok {
		t.Fatal("prepareUsageReportFromRaw returned false")
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

	_, ok := host.prepareUsageReportFromRaw([]byte(`{
		"update": {
			"sessionUpdate": "usage_update",
			"used": 50,
			"size": 100,
			"_meta": {
				"quota": { "model_usage": [] }
			}
		}
	}`))
	if ok {
		t.Fatal("context/token usage without _claude/rateLimit must not produce credential-limit telemetry")
	}
}
