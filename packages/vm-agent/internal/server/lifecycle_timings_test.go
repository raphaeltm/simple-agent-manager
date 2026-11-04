package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

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

func TestLifecycleTimingCallbackIsBoundedAndProvisioningCarriesNoError(t *testing.T) {
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
	_, timings := startLifecycleTimings(context.Background(), "devcontainer_up")
	s.finishLifecycleTimings(timings, "workspace", "ws-1", "chat-1", "scoped", context.DeadlineExceeded)
	select {
	case body := <-received:
		data, _ := json.Marshal(body)
		if body["outcome"] != "error" || strings.Contains(string(data), "deadline") {
			t.Fatalf("unsafe outcome: %s", data)
		}
		for _, key := range []string{"failedPhase", "errorTail", "chatSessionId"} {
			if _, ok := body[key]; ok {
				t.Fatalf("provisioning summary carried trace field %q: %s", key, data)
			}
		}
	case <-time.After(5 * time.Second):
		t.Fatal("callback not delivered")
	}
}

func TestSleepTracePayloadNamesFailedPhaseAndKeepsRedactedErrorTail(t *testing.T) {
	ctx, timings := startLifecycleTimings(context.Background(), "prepare")
	nextLifecyclePhase(ctx, "wip_capture")
	nextLifecyclePhase(ctx, "home_capture")
	secret := "ghp_" + strings.Repeat("A", 36)
	err := fmt.Errorf("archive container snapshot root %q: exit status 2: %s tar: /home/node/.cache: Cannot open: Permission denied token=%s",
		"home", strings.Repeat("noise ", 600), secret)

	payload := lifecycleTimingPayload(timings, "sleep", "chat-1", err)

	if payload["failedPhase"] != "home_capture" || payload["chatSessionId"] != "chat-1" || payload["outcome"] != "error" {
		t.Fatalf("trace identity/phase wrong: %+v", payload)
	}
	tail, _ := payload["errorTail"].(string)
	if len(tail) > lifecycleErrorTailBytes || !strings.Contains(tail, "Permission denied") {
		t.Fatalf("error tail lost the failure reason or exceeded its bound (%d bytes): %q", len(tail), tail)
	}
	if strings.Contains(tail, secret) {
		t.Fatal("error tail leaked a secret")
	}
	phases, _ := payload["phases"].([]lifecycleTiming)
	if len(phases) != 3 {
		t.Fatalf("phase timings lost: %+v", phases)
	}
}

func TestSuccessfulWakeTraceCarriesNoErrorFields(t *testing.T) {
	_, timings := startLifecycleTimings(context.Background(), "metadata")
	payload := lifecycleTimingPayload(timings, "wake", "chat-1", nil)
	if payload["outcome"] != "success" || payload["chatSessionId"] != "chat-1" {
		t.Fatalf("unexpected payload: %+v", payload)
	}
	if _, ok := payload["errorTail"]; ok {
		t.Fatal("success carried an error tail")
	}
	if _, ok := payload["failedPhase"]; ok {
		t.Fatal("success carried a failed phase")
	}
}

// Rollout compatibility (rule 54): an older control plane reads only operation/outcome/phases
// and drops unknown keys, so those keys must keep their exact shape.
func TestTracePayloadKeepsTheOriginalSummaryShapeForOlderControlPlanes(t *testing.T) {
	_, timings := startLifecycleTimings(context.Background(), "wip_upload")
	payload := lifecycleTimingPayload(timings, "sleep", "chat-1", errors.New("upload failed: 503"))
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Operation string `json:"operation"`
		Outcome   string `json:"outcome"`
		Phases    []struct {
			Phase      string `json:"phase"`
			DurationMs int64  `json:"durationMs"`
		} `json:"phases"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Operation != "sleep" || decoded.Outcome != "error" || len(decoded.Phases) != 1 || decoded.Phases[0].Phase != "wip_upload" {
		t.Fatalf("original summary shape changed: %s", data)
	}
}

func TestTailBufferKeepsTheEndOfCommandOutput(t *testing.T) {
	buffer := newTailBuffer(16)
	_, _ = buffer.Write([]byte(strings.Repeat("x", 100)))
	_, _ = buffer.Write([]byte("final: failure"))
	if got := buffer.String(); !strings.HasSuffix(got, "final: failure") || len(got) > 16 || !buffer.truncated {
		t.Fatalf("tail buffer = %q (truncated %v)", got, buffer.truncated)
	}
	multibyte := newTailBuffer(5)
	_, _ = multibyte.Write([]byte("ééé"))
	if got := multibyte.String(); !utf8.ValidString(got) || !strings.HasSuffix(got, "é") {
		t.Fatalf("tail buffer split a rune: %q", got)
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
