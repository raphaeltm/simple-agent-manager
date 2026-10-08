package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// claudeAdapterUsageUpdate is the session/update claude-agent-acp 0.81.2 (Claude
// Code 2.1.281, SDK 0.3.280) writes for an ordinary Claude Max reading, captured
// from the real adapter driven against a mock Anthropic API that returns the
// subscription anthropic-ratelimit-unified-* headers. In this normal (not yet
// warning) state the top level names only the representative window and carries
// no utilization; the five-hour and weekly percentages exist only in
// unifiedWindows.
const claudeAdapterUsageUpdate = `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sdk-session-1","update":{"sessionUpdate":"usage_update","used":120,"size":200000,"_meta":{"_claude/rateLimit":{"status":"allowed","resetsAt":1791507194,"rateLimitType":"five_hour","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.13,"resetsAt":1791507194},"seven_day":{"utilization":0.31,"resetsAt":1791841994}}},"_claude/model":"claude-sonnet-5"}}}}`

// backfilledClaudeCredentialReference mirrors the shape of production Claude
// credential references created by the 2026-06-14 composable-credentials backfill
// (`cc_credentials:cred-{ownerId}-{ciphertext}:{iv}`, 238 characters). The VM agent
// echoes it verbatim, so it must survive the trip unchanged.
var backfilledClaudeCredentialReference = "cc_credentials:cred-4bw1FXkQ7cK2nY8pR3sT6uV9wZ0aB1cD-" +
	strings.Repeat("KgCluaQx9+Ga5+i+JTSMVBxORYB/j3L90fcFFZrC4rik9mbQ2", 3) +
	"/msAieB+gfJsvMulc0mQ==:MPQAR5bNpdU+BnN0"

// TestClaudeAdapterUsageUpdateReportsFiveHourAndWeeklyWindows enters through the
// production trigger: a real ACP client connection (attachACPConnection via
// startAgentWithSessionMode) decodes the adapter's session/update line, the
// SessionUpdate handler captures it, and the reporter POSTs it to the control
// plane. Before the unifiedWindows parsing this reported one window with no
// utilization and never the weekly window.
func TestClaudeAdapterUsageUpdateReportsFiveHourAndWeeklyWindows(t *testing.T) {
	if len(backfilledClaudeCredentialReference) <= 160 {
		t.Fatalf("fixture reference must exceed the 160-char identifier budget, got %d", len(backfilledClaudeCredentialReference))
	}
	fixedNow := time.UnixMilli(1_791_496_287_022)
	received := make(chan usageReportPayload, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/projects/project-1/acp-sessions/session-1/usage" {
			t.Errorf("unexpected callback path %s", r.URL.Path)
		}
		var payload usageReportPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode usage report: %v", err)
		}
		received <- payload
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	process, agentStdin, agentStdout := newFakeAgentProcess(time.Now(), true)
	t.Cleanup(func() { _ = process.Stop() })
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
			InitTimeoutMs:                  2000,
			NewSessionTimeoutMs:            2000,
		},
		StartProcess: func(*agentStartup) (agentProcess, error) { return process, nil },
	})
	serveClaudeHandshake(t, agentStdin, agentStdout)

	host.mu.Lock()
	err := host.startAgentWithSessionMode(context.Background(), "claude-code", &agentCredential{
		credential:           "sk-ant-oat01-test",
		credentialKind:       "oauth-token",
		credentialSource:     "user",
		credentialReference:  backfilledClaudeCredentialReference,
		credentialGeneration: 1,
		credentialProvider:   "agent",
		providerMode:         "direct",
	}, nil, "", false)
	host.mu.Unlock()
	if err != nil {
		t.Fatalf("startAgentWithSessionMode: %v", err)
	}

	writeAgentLine(agentStdout, claudeAdapterUsageUpdate)

	payload := readUsagePayload(t, received)
	if payload.Source != "claude-acp.usage_update" || payload.AgentType != "claude-code" {
		t.Fatalf("report source/agent = %q/%q", payload.Source, payload.AgentType)
	}
	if payload.CredentialReference != backfilledClaudeCredentialReference || payload.CredentialSource != "user" || payload.CredentialGeneration != 1 {
		t.Fatalf("credential attribution = %s/%q/%d, want the session's backfilled reference unchanged",
			payload.CredentialSource, payload.CredentialReference, payload.CredentialGeneration)
	}
	assertClaudeWindows(t, payload.RateLimits, []wantClaudeWindow{
		{windowType: "claude.five_hour", status: "allowed", utilization: 13, windowMinutes: 300, resetsAt: 1_791_507_194_000},
		{windowType: "claude.seven_day", status: "allowed", utilization: 31, windowMinutes: 10080, resetsAt: 1_791_841_994_000},
	})
	for _, limit := range payload.RateLimits {
		if limit.Provider != "anthropic" || limit.Source != "claude-acp.rate_limit" || limit.ObservedAt != fixedNow.UnixMilli() {
			t.Fatalf("limit %s provider/source/observedAt = %q/%q/%d", limit.WindowType, limit.Provider, limit.Source, limit.ObservedAt)
		}
	}
}

// serveClaudeHandshake answers the ACP handshake the way claude-agent-acp does,
// enough for startAgentWithSessionMode to attach a live connection.
func serveClaudeHandshake(t *testing.T, agentStdin interface{ Read([]byte) (int, error) }, agentStdout interface{ Write([]byte) (int, error) }) {
	t.Helper()
	go func() {
		scanner := bufio.NewScanner(agentStdin)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			var msg struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
			}
			if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil || len(msg.ID) == 0 {
				continue
			}
			switch msg.Method {
			case "initialize":
				writeAgentLine(agentStdout, `{"jsonrpc":"2.0","id":`+string(msg.ID)+
					`,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}}`)
			case "session/new":
				writeAgentLine(agentStdout, `{"jsonrpc":"2.0","id":`+string(msg.ID)+
					`,"result":{"sessionId":"sdk-session-1"}}`)
			default:
				writeAgentLine(agentStdout, `{"jsonrpc":"2.0","id":`+string(msg.ID)+`,"result":{}}`)
			}
		}
	}()
}

type wantClaudeWindow struct {
	windowType    string
	status        string
	utilization   float64 // -1 means no utilization reported
	windowMinutes int64   // 0 means no window length reported
	resetsAt      int64   // 0 means no reset reported
}

func assertClaudeWindows(t *testing.T, got []usageLimitPayload, want []wantClaudeWindow) {
	t.Helper()
	if len(got) != len(want) {
		types := make([]string, 0, len(got))
		for _, limit := range got {
			types = append(types, limit.WindowType)
		}
		t.Fatalf("windows = %v, want %d windows", types, len(want))
	}
	for i, w := range want {
		limit := got[i]
		if limit.WindowType != w.windowType || limit.Status != w.status {
			t.Fatalf("window %d = %s/%s, want %s/%s", i, limit.WindowType, limit.Status, w.windowType, w.status)
		}
		switch {
		case w.utilization < 0 && limit.UtilizationPercent != nil:
			t.Fatalf("%s utilization = %v, want none", w.windowType, *limit.UtilizationPercent)
		case w.utilization >= 0 && (limit.UtilizationPercent == nil || math.Abs(*limit.UtilizationPercent-w.utilization) > 1e-9):
			t.Fatalf("%s utilization = %s, want %v", w.windowType, float64PointerKey(limit.UtilizationPercent), w.utilization)
		}
		if w.windowMinutes == 0 && limit.WindowMinutes != nil || w.windowMinutes != 0 && (limit.WindowMinutes == nil || *limit.WindowMinutes != w.windowMinutes) {
			t.Fatalf("%s windowMinutes = %s, want %d", w.windowType, int64PointerKey(limit.WindowMinutes), w.windowMinutes)
		}
		if w.resetsAt == 0 && limit.ResetsAt != nil || w.resetsAt != 0 && (limit.ResetsAt == nil || *limit.ResetsAt != w.resetsAt) {
			t.Fatalf("%s resetsAt = %s, want %d", w.windowType, int64PointerKey(limit.ResetsAt), w.resetsAt)
		}
	}
}

func TestClaudeRateLimitWindowsFromAdapterPayloads(t *testing.T) {
	cases := []struct {
		name      string
		rateLimit string
		want      []wantClaudeWindow
	}{
		{
			name:      "warning on the representative window keeps its status and the other window stays allowed",
			rateLimit: `{"status":"allowed_warning","resetsAt":1791507194,"rateLimitType":"five_hour","utilization":0.82,"surpassedThreshold":0.75,"isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.82,"resetsAt":1791507194},"seven_day":{"utilization":0.4,"resetsAt":1791841994}}}`,
			want: []wantClaudeWindow{
				{windowType: "claude.five_hour", status: "allowed_warning", utilization: 82, windowMinutes: 300, resetsAt: 1_791_507_194_000},
				{windowType: "claude.seven_day", status: "allowed", utilization: 40, windowMinutes: 10080, resetsAt: 1_791_841_994_000},
			},
		},
		{
			name:      "rejected weekly window: the five-hour window's own state is unknown",
			rateLimit: `{"status":"rejected","resetsAt":1791841994,"rateLimitType":"seven_day","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.5,"resetsAt":1791507194},"seven_day":{"utilization":1,"resetsAt":1791841994}}}`,
			want: []wantClaudeWindow{
				{windowType: "claude.five_hour", status: "unknown", utilization: 50, windowMinutes: 300, resetsAt: 1_791_507_194_000},
				{windowType: "claude.seven_day", status: "rejected", utilization: 100, windowMinutes: 10080, resetsAt: 1_791_841_994_000},
			},
		},
		{
			name:      "a representative window outside unifiedWindows is reported from the top level",
			rateLimit: `{"status":"allowed_warning","resetsAt":1791841994,"rateLimitType":"seven_day_opus","utilization":0.9,"unifiedWindows":{"five_hour":{"utilization":0.2,"resetsAt":1791507194},"seven_day":{"utilization":0.6,"resetsAt":1791841994}}}`,
			want: []wantClaudeWindow{
				{windowType: "claude.five_hour", status: "allowed", utilization: 20, windowMinutes: 300, resetsAt: 1_791_507_194_000},
				{windowType: "claude.seven_day", status: "allowed", utilization: 60, windowMinutes: 10080, resetsAt: 1_791_841_994_000},
				{windowType: "claude.seven_day_opus", status: "allowed_warning", utilization: 90, windowMinutes: 10080, resetsAt: 1_791_841_994_000},
			},
		},
		{
			name:      "older Claude Code without unifiedWindows keeps the single top-level window",
			rateLimit: `{"status":"allowed_warning","rateLimitType":"five_hour","utilization":0.82,"resetsAt":1791507194}`,
			want: []wantClaudeWindow{
				{windowType: "claude.five_hour", status: "allowed_warning", utilization: 82, windowMinutes: 300, resetsAt: 1_791_507_194_000},
			},
		},
		{
			name:      "unifiedWindows without a representative window still reports both windows",
			rateLimit: `{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.05,"resetsAt":1791507194},"seven_day":{"utilization":0.31,"resetsAt":1791841994}}}`,
			want: []wantClaudeWindow{
				{windowType: "claude.five_hour", status: "allowed", utilization: 5, windowMinutes: 300, resetsAt: 1_791_507_194_000},
				{windowType: "claude.seven_day", status: "allowed", utilization: 31, windowMinutes: 10080, resetsAt: 1_791_841_994_000},
			},
		},
		{
			name:      "over-limit fractions clamp to 100 and unsupported or malformed windows are skipped",
			rateLimit: `{"status":"rejected","resetsAt":1791507194,"rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":1.03,"resetsAt":1791507194},"seven_day":"not-an-object","seven_day_overage_included":{"utilization":0.9,"resetsAt":1791841994}}}`,
			want: []wantClaudeWindow{
				{windowType: "claude.five_hour", status: "rejected", utilization: 100, windowMinutes: 300, resetsAt: 1_791_507_194_000},
			},
		},
		{
			name:      "a unified window without utilization or reset falls back to the representative fields",
			rateLimit: `{"status":"allowed_warning","resetsAt":1791507194,"rateLimitType":"five_hour","utilization":0.8,"unifiedWindows":{"five_hour":{},"seven_day":{"utilization":0.31}}}`,
			want: []wantClaudeWindow{
				{windowType: "claude.seven_day", status: "allowed", utilization: 31, windowMinutes: 10080},
				{windowType: "claude.five_hour", status: "allowed_warning", utilization: 80, windowMinutes: 300, resetsAt: 1_791_507_194_000},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			host := NewSessionHost(SessionHostConfig{
				GatewayConfig: GatewayConfig{
					ControlPlaneURL: "https://control.example",
					ProjectID:       "project-1",
					NodeID:          "node-1",
					WorkspaceID:     "workspace-1",
					SessionID:       "session-1",
					CallbackToken:   "callback-token",
					Now:             func() time.Time { return time.UnixMilli(1_791_496_287_022) },
				},
			})
			host.storeCredentialAttribution("claude-code", &agentCredential{
				credentialSource:    "user",
				credentialReference: "cc_credentials:cred-1",
				credentialProvider:  "agent",
				providerMode:        "direct",
			})
			var notification acpsdk.SessionNotification
			raw := `{"sessionId":"sdk-session-1","update":{"sessionUpdate":"usage_update","used":120,"size":200000,"_meta":{"_claude/rateLimit":` + tc.rateLimit + `}}}`
			if err := json.Unmarshal([]byte(raw), &notification); err != nil {
				t.Fatalf("decode adapter notification: %v", err)
			}
			request, ok := host.prepareUsageReport(notification)
			if !ok {
				t.Fatal("prepareUsageReport returned false")
			}
			assertClaudeWindows(t, request.payload.RateLimits, tc.want)
		})
	}
}
