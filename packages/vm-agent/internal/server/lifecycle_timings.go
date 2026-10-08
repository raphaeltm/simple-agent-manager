package server

import (
	"context"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/workspace/vm-agent/internal/eventstore"
)

// Fixed protocol vocabulary prevents paths, command lines and errors becoming labels.
var lifecyclePhaseNames = []string{
	"packages", "docker", "docker-model-runner", "firewall", "tls-permissions",
	"nodejs-install", "devcontainer-cli", "image-prepull", "journald-config",
	"docker-restart", "metadata-block", "system_wait", "git_token", "runtime_assets",
	"workspace_prepare", "prepare", "wip_capture", "wip_upload", "home_capture",
	"home_upload", "complete", "metadata", "workspace", "home_restore", "git_restore",
	"agent_restore", "verify",
	"volume_create", "git_clone", "devcontainer_cache", "devcontainer_up", "gh_cli", "git_creds", "git_identity", "sam_env",
}

type lifecycleTiming struct {
	Phase      string `json:"phase"`
	DurationMs int64  `json:"durationMs"`
}

func knownLifecyclePhase(phase string) bool {
	for _, name := range lifecyclePhaseNames {
		if name == phase {
			return true
		}
	}
	return false
}

// One operation owns this recorder on its synchronous execution goroutine.
type lifecycleTimings struct {
	mu        sync.Mutex
	starts    map[string]time.Time
	phase     string
	since     time.Time
	durations map[string]int64
}

type lifecycleTimingsContextKey struct{}

func startLifecycleTimings(ctx context.Context, phase string) (context.Context, *lifecycleTimings) {
	timings := &lifecycleTimings{since: time.Now(), durations: make(map[string]int64), starts: make(map[string]time.Time)}
	timings.next(phase)
	return context.WithValue(ctx, lifecycleTimingsContextKey{}, timings), timings
}

func (t *lifecycleTimings) next(phase string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	if knownLifecyclePhase(t.phase) {
		t.durations[t.phase] += now.Sub(t.since).Milliseconds()
	}
	t.phase, t.since = phase, now
}

func nextLifecyclePhase(ctx context.Context, phase string) {
	if t, ok := ctx.Value(lifecycleTimingsContextKey{}).(*lifecycleTimings); ok {
		t.next(phase)
	}
}

func (t *lifecycleTimings) summary() []lifecycleTiming {
	t.next("")
	t.mu.Lock()
	defer t.mu.Unlock()
	result := make([]lifecycleTiming, 0, len(t.durations))
	for _, phase := range lifecyclePhaseNames {
		if duration, ok := t.durations[phase]; ok {
			result = append(result, lifecycleTiming{phase, duration})
		}
	}
	return result
}

// Telemetry must never extend startup or change its outcome. Exactly one bounded
// best-effort callback per operation; no retries, queue, or per-phase DB writes.
func (s *Server) finishLifecycleTimings(t *lifecycleTimings, operation, workspaceID, token string, operationErr error) {
	phases := t.summary()
	if s.config == nil || s.config.ControlPlaneURL == "" || token == "" {
		return
	}
	outcome := "success"
	if operationErr != nil {
		outcome = "error"
	}
	payload := map[string]interface{}{"operation": operation, "outcome": outcome, "phases": phases}
	timeout := s.sessionSnapshotProgressReportTimeout()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		var response map[string]interface{}
		if err := s.doSnapshotJSON(ctx, http.MethodPost, workspaceID, "/lifecycle-timings", token, payload, &response); err != nil {
			// Do not log callback response bodies: telemetry cannot become an error-data channel.
			slog.Debug("Lifecycle timing summary delivery failed", "operation", operation, "workspaceId", workspaceID)
		}
	}()
}

func provisioningTimingSummary(es *eventstore.Store) []lifecycleTiming {
	if es == nil {
		return nil
	}
	// Each fixed provisioning phase emits at most start and terminal events.
	events, err := es.ListByTypePrefix("provision.", len(lifecyclePhaseNames)*2)
	if err != nil {
		return nil
	}
	durations := make(map[string]int64)
	for _, event := range events {
		phase := strings.TrimPrefix(event.Type, "provision.")
		if !knownLifecyclePhase(phase) {
			continue
		}
		status, _ := event.Detail["status"].(string)
		duration, ok := event.Detail["durationMs"].(float64)
		if (status == "completed" || status == "failed") && ok && duration >= 0 && duration < float64(math.MaxInt64) && !math.IsInf(duration, 0) && !math.IsNaN(duration) {
			durations[phase] = int64(duration)
		}
	}
	result := make([]lifecycleTiming, 0, len(durations))
	for _, phase := range lifecyclePhaseNames {
		if duration, ok := durations[phase]; ok {
			result = append(result, lifecycleTiming{phase, duration})
		}
	}
	return result
}

// Observe explicit bootstrap spans without accepting their free-text messages.
func (t *lifecycleTimings) observe(phase, status string) {
	if !knownLifecyclePhase(phase) {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if status == "started" {
		t.starts[phase] = time.Now()
		return
	}
	if start, ok := t.starts[phase]; ok && (status == "completed" || status == "failed") {
		t.durations[phase] += time.Since(start).Milliseconds()
		delete(t.starts, phase)
	}
}
