package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/eventstore"
)

func TestProvisioningTimingSummaryExcludesUntrustedDetails(t *testing.T) {
	es := newEventStore(t)
	secret := "ghp_canary_secret_do_not_forward"
	for i, phase := range []string{"docker", secret} {
		es.Append(eventstore.EventRecord{ID: phase, Type: "provision." + phase, Level: "info", Message: secret,
			CreatedAt: time.Now().Add(time.Duration(i) * time.Second).UTC().Format(time.RFC3339),
			Detail:    map[string]interface{}{"status": "completed", "durationMs": float64(1234), "error": secret}})
	}
	result := provisioningTimingSummary(es)
	if len(result) != 1 || result[0].Phase != "docker" || result[0].DurationMs != 1234 {
		t.Fatalf("unexpected summary: %+v", result)
	}
	data, _ := json.Marshal(result)
	if strings.Contains(string(data), secret) {
		t.Fatal("secret leaked")
	}
}

func TestLifecycleTimingsBoundedAndAggregated(t *testing.T) {
	ctx, timings := startLifecycleTimings(context.Background(), "home_capture")
	timings.since = time.Now().Add(-2 * time.Second)
	nextLifecyclePhase(ctx, "home_upload")
	timings.observe("git_clone", "started")
	timings.observe("git_clone", "completed")
	for i := 0; i < 100; i++ {
		timings.observe("secret/path", "started")
	}
	summary := timings.summary()
	if len(summary) != 3 || len(timings.starts) != 0 {
		t.Fatalf("unbounded or missing phases: %+v", summary)
	}
	if timings.durations["home_capture"] < 2000 {
		t.Fatal("phase duration missing")
	}
}

func TestLifecycleTimingCallbackIsBoundedAndDoesNotCarryError(t *testing.T) {
	received := make(chan map[string]interface{}, 1)
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workspaces/ws-1/lifecycle-timings" || r.Header.Get("Authorization") != "Bearer scoped" {
			t.Error("wrong callback identity")
		}
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		received <- body
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	defer cp.Close()
	s := &Server{config: &config.Config{ControlPlaneURL: cp.URL}}
	_, timings := startLifecycleTimings(context.Background(), "home_upload")
	s.finishLifecycleTimings(timings, "sleep", "ws-1", "scoped", context.DeadlineExceeded)
	select {
	case body := <-received:
		data, _ := json.Marshal(body)
		if body["outcome"] != "error" || strings.Contains(string(data), "deadline") {
			t.Fatalf("unsafe outcome: %s", data)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("callback not delivered")
	}
}

func TestBootstrapTimingObserverReportsTerminalSpansWithoutDetails(t *testing.T) {
	for _, status := range []string{"completed", "failed"} {
		t.Run(status, func(t *testing.T) {
			_, timings := startLifecycleTimings(context.Background(), "workspace_prepare")
			reporter := bootlog.New("", "ws-1")
			reporter.SetPhaseObserver(timings.observe)
			secret := "ghp_canary_bootstrap_detail"
			reporter.Log("devcontainer_cache", "started", secret, secret)
			timings.starts["devcontainer_cache"] = time.Now().Add(-time.Second)
			reporter.Log("devcontainer_cache", status, secret, secret)
			duration := timings.durations["devcontainer_cache"]
			// A duplicate terminal event must not double count the span.
			reporter.Log("devcontainer_cache", status, secret, secret)
			reporter.Log(secret, "started", secret)
			reporter.Log(secret, status, secret)
			summary := timings.summary()
			if len(summary) != 2 || len(timings.starts) != 0 {
				t.Fatalf("unexpected bootstrap spans: %+v", summary)
			}
			if duration < 1000 || timings.durations["devcontainer_cache"] != duration {
				t.Fatalf("cache span missing or double counted: %d", duration)
			}
			data, err := json.Marshal(summary)
			if err != nil || strings.Contains(string(data), secret) {
				t.Fatalf("bootstrap detail leaked or summary invalid: %s, %v", data, err)
			}
		})
	}
}
