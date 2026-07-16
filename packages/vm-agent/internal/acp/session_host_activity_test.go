package acp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

func TestPromptActivityRereportStopsBeforeIdle(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	activities := make([]string, 0)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload activityPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode activity payload: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		activities = append(activities, payload.Activity)
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			ProjectID:                "proj-1",
			NodeID:                   "node-1",
			SessionID:                "acp-1",
			ControlPlaneURL:          server.URL,
			CallbackToken:            "token",
			ActivityRereportInterval: 10 * time.Millisecond,
			HTTPClient:               server.Client(),
		},
	})

	host.markPromptStarted(acpsdk.SessionId("sdk-1"), 1, "viewer-1")
	waitFor(t, 250*time.Millisecond, func() bool {
		return countActivity(&mu, &activities, "prompting") >= 2
	})

	host.markPromptDone()
	waitFor(t, 250*time.Millisecond, func() bool {
		return countActivity(&mu, &activities, "idle") >= 1
	})

	promptingAfterDone := countActivity(&mu, &activities, "prompting")
	time.Sleep(40 * time.Millisecond)
	if got := countActivity(&mu, &activities, "prompting"); got != promptingAfterDone {
		t.Fatalf("prompting re-report fired after markPromptDone: before=%d after=%d activities=%v", promptingAfterDone, got, snapshotActivities(&mu, &activities))
	}
}

func TestTerminalActivityReportRetriesMoreThanPrompting(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	attemptsByActivity := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload activityPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode activity payload: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		attemptsByActivity[payload.Activity]++
		attempt := attemptsByActivity[payload.Activity]
		mu.Unlock()
		if payload.Activity == "idle" && attempt < 4 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if payload.Activity == "prompting" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			ProjectID:                      "proj-1",
			NodeID:                         "node-1",
			SessionID:                      "acp-1",
			ControlPlaneURL:                server.URL,
			CallbackToken:                  "token",
			TerminalActivityReportAttempts: 4,
			TerminalActivityReportBackoff:  time.Millisecond,
			HTTPClient:                     server.Client(),
		},
	})

	host.reportActivity("idle")
	waitFor(t, 250*time.Millisecond, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return attemptsByActivity["idle"] == 4
	})

	promptingAttempts, _ := host.activityReportRetryPolicy("prompting")
	if promptingAttempts != 2 {
		t.Fatalf("prompting attempts = %d, want cheap retry budget of 2", promptingAttempts)
	}
}

func waitFor(t *testing.T, timeout time.Duration, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if ready() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("condition not met within %s", timeout)
}

func countActivity(mu *sync.Mutex, activities *[]string, activity string) int {
	mu.Lock()
	defer mu.Unlock()
	count := 0
	for _, got := range *activities {
		if got == activity {
			count++
		}
	}
	return count
}

func snapshotActivities(mu *sync.Mutex, activities *[]string) []string {
	mu.Lock()
	defer mu.Unlock()
	out := make([]string, len(*activities))
	copy(out, *activities)
	return out
}

func TestErrorActivityIncludesRedactedStatusError(t *testing.T) {
	t.Parallel()

	payloads := make(chan activityPayload, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload activityPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode activity payload: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		payloads <- payload
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			ProjectID:       "proj-1",
			NodeID:          "node-1",
			SessionID:       "acp-1",
			ControlPlaneURL: server.URL,
			CallbackToken:   "token",
			HTTPClient:      server.Client(),
		},
	})
	host.mu.Lock()
	host.agentType = "openai-codex"
	host.status = HostError
	host.statusErr = "ACP NewSession failed: api_key=sk-testsecret1234567890"
	host.mu.Unlock()

	host.reportActivity("error")

	select {
	case payload := <-payloads:
		if payload.Activity != "error" {
			t.Fatalf("activity = %q, want error", payload.Activity)
		}
		if payload.StatusError == nil || *payload.StatusError == "" {
			t.Fatal("expected redacted statusError on error activity")
		}
		if strings.Contains(*payload.StatusError, "sk-testsecret") {
			t.Fatalf("statusError leaked secret: %q", *payload.StatusError)
		}
		if !strings.Contains(*payload.StatusError, "[REDACTED]") {
			t.Fatalf("statusError = %q, want redaction marker", *payload.StatusError)
		}
		if payload.PromptStartedAt != nil {
			t.Fatalf("PromptStartedAt = %v, want nil for error activity", *payload.PromptStartedAt)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("timed out waiting for error activity report")
	}
}
