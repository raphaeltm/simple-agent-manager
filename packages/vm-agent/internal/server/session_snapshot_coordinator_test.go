package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/errorreport"
)

func TestHibernateHandlerAcceptsBackgroundCaptureBeforeWorkCompletes(t *testing.T) {
	validator, key := newWorkspaceCreateJWTValidator(t, "node-1")
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	s := &Server{
		config: &config.Config{
			NodeID:                          "node-1",
			SessionSnapshotOperationTimeout: time.Second,
		},
		jwtValidator: validator,
		workspaces: map[string]*WorkspaceRuntime{
			"workspace-1": {ID: "workspace-1", CallbackToken: "workspace-callback-token"},
		},
		sessionSnapshotRunner: func(ctx context.Context, _ *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
			started <- struct{}{}
			select {
			case <-release:
				return map[string]interface{}{"status": "available"}, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		},
	}
	token := signWorkspaceCreateNodeToken(t, key, "node-1", "workspace-1")
	req := httptest.NewRequest(http.MethodPost, "/workspaces/workspace-1/agent-sessions/agent-1/hibernate", bytes.NewBufferString(`{"chatSessionId":"chat-1","runtime":"vm","background":true}`))
	req.SetPathValue("workspaceId", "workspace-1")
	req.SetPathValue("sessionId", "agent-1")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-SAM-Node-Id", "node-1")
	req.Header.Set("X-SAM-Workspace-Id", "workspace-1")
	recorder := httptest.NewRecorder()

	s.handleHibernateAgentSession(recorder, req)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusAccepted, recorder.Body.String())
	}
	var response struct {
		Status   string `json:"status"`
		Accepted bool   `json:"accepted"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Status != "pending" || !response.Accepted {
		t.Fatalf("response = %#v, want accepted pending capture", response)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("accepted background capture did not start")
	}
	close(release)
}

func TestBackgroundSessionSnapshotReturnsImmediatelyAndDeduplicates(t *testing.T) {
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	finished := make(chan struct{}, 1)
	var calls atomic.Int32
	s := &Server{
		config: &config.Config{SessionSnapshotOperationTimeout: time.Second},
		sessionSnapshotRunner: func(ctx context.Context, _ *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
			calls.Add(1)
			started <- struct{}{}
			select {
			case <-release:
				finished <- struct{}{}
				return map[string]interface{}{"status": "available"}, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		},
	}
	input := &sessionSnapshotHandlerInput{chatSessionID: "chat-1"}

	if !s.startBackgroundSessionSnapshot(input) {
		t.Fatal("first background snapshot was not accepted")
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("background snapshot did not start")
	}
	if s.startBackgroundSessionSnapshot(input) {
		t.Fatal("duplicate background snapshot was accepted while capture was active")
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("snapshot calls = %d, want 1", got)
	}

	close(release)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("background snapshot did not finish")
	}
}

func TestFinalSessionSnapshotWaitsForBackgroundCaptureThenRunsFreshCapture(t *testing.T) {
	backgroundStarted := make(chan struct{}, 1)
	releaseBackground := make(chan struct{})
	finalStarted := make(chan struct{}, 1)
	var calls atomic.Int32
	s := &Server{
		config: &config.Config{SessionSnapshotOperationTimeout: time.Second},
		sessionSnapshotRunner: func(ctx context.Context, _ *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
			switch calls.Add(1) {
			case 1:
				backgroundStarted <- struct{}{}
				select {
				case <-releaseBackground:
					return map[string]interface{}{"status": "available"}, nil
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			case 2:
				finalStarted <- struct{}{}
				return map[string]interface{}{"status": "available"}, nil
			default:
				t.Fatalf("unexpected snapshot call %d", calls.Load())
				return nil, nil
			}
		},
	}
	input := &sessionSnapshotHandlerInput{chatSessionID: "chat-1"}
	if !s.startBackgroundSessionSnapshot(input) {
		t.Fatal("background snapshot was not accepted")
	}
	<-backgroundStarted

	finalDone := make(chan error, 1)
	go func() {
		_, err := s.captureSessionSnapshot(context.Background(), input)
		finalDone <- err
	}()
	select {
	case <-finalStarted:
		t.Fatal("final snapshot raced the active background capture")
	case <-time.After(50 * time.Millisecond):
	}

	close(releaseBackground)
	select {
	case <-finalStarted:
	case <-time.After(time.Second):
		t.Fatal("final snapshot did not start after background capture completed")
	}
	if err := <-finalDone; err != nil {
		t.Fatalf("final snapshot failed: %v", err)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("snapshot calls = %d, want 2", got)
	}
}

func TestBackgroundSessionSnapshotReportsGenerationScopedFailure(t *testing.T) {
	reported := make(chan map[string]string, 1)
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workspaces/workspace-1/session-snapshot/failure" {
			t.Fatalf("path = %q, want failure callback", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer callback-token" {
			t.Fatalf("authorization = %q, want callback bearer", got)
		}
		var payload map[string]string
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		reported <- payload
		w.WriteHeader(http.StatusNoContent)
	}))
	defer controlPlane.Close()
	finished := make(chan struct{}, 1)
	s := &Server{
		config: &config.Config{
			ControlPlaneURL:                      controlPlane.URL,
			SessionSnapshotOperationTimeout:      time.Second,
			SessionSnapshotProgressReportTimeout: time.Second,
		},
		sessionSnapshotRunner: func(context.Context, *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
			defer func() { finished <- struct{}{} }()
			return nil, &sessionSnapshotCaptureError{
				generation: "generation-1",
				err:        errors.New("snapshot control plane returned HTTP 400: checksum mismatch"),
			}
		},
	}
	input := &sessionSnapshotHandlerInput{
		workspaceID:   "workspace-1",
		sessionID:     "agent-1",
		chatSessionID: "chat-1",
		callbackToken: "callback-token",
	}

	if !s.startBackgroundSessionSnapshot(input) {
		t.Fatal("background snapshot was not accepted")
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("background snapshot did not finish")
	}
	select {
	case payload := <-reported:
		if payload["chatSessionId"] != "chat-1" || payload["generation"] != "generation-1" {
			t.Fatalf("payload identity = %#v, want chat/generation", payload)
		}
		if payload["error"] != "snapshot control plane returned HTTP 400: checksum mismatch" {
			t.Fatalf("payload error = %q", payload["error"])
		}
	case <-time.After(time.Second):
		t.Fatal("failure callback was not sent")
	}
}

// backgroundSnapshotIncidentProbe runs one background capture that fails with captureErr and
// reports how the control plane was told about it.
type backgroundSnapshotIncidentProbe struct {
	errorPosts    int32
	failureReport bool
}

// runBackgroundSnapshotIncidentProbe drives startBackgroundSessionSnapshot against a stub
// control plane and waits for the capture goroutine to finish reporting.
//
// wantIncident is the CALLER's expectation, not the verdict of the code under test: the wait
// condition must never consult shouldReportBackgroundSnapshotIncident, or the harness would
// decide how long to wait using the very function the assertion is checking.
func runBackgroundSnapshotIncidentProbe(t *testing.T, captureErr error, wantIncident bool) backgroundSnapshotIncidentProbe {
	t.Helper()

	var errorPosts atomic.Int32
	var failureReports atomic.Int32
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/nodes/node-1/errors":
			errorPosts.Add(1)
		case r.Method == http.MethodPost && r.URL.Path == "/api/workspaces/workspace-1/session-snapshot/failure":
			failureReports.Add(1)
		default:
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(controlPlane.Close)

	reporter := errorreport.New(controlPlane.URL, "node-1", "callback-token", errorreport.Config{
		DBPath:        filepath.Join(t.TempDir(), "error-reports.db"),
		FlushInterval: time.Hour,
	})
	reporter.Start()
	t.Cleanup(reporter.Shutdown)

	finished := make(chan struct{}, 1)
	s := &Server{
		config: &config.Config{
			ControlPlaneURL:                      controlPlane.URL,
			SessionSnapshotOperationTimeout:      time.Second,
			SessionSnapshotProgressReportTimeout: time.Second,
		},
		errorReporter: reporter,
		sessionSnapshotRunner: func(context.Context, *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
			defer func() { finished <- struct{}{} }()
			return nil, &sessionSnapshotCaptureError{generation: "generation-1", err: captureErr}
		},
	}
	input := &sessionSnapshotHandlerInput{
		workspaceID:   "workspace-1",
		sessionID:     "agent-1",
		chatSessionID: "chat-1",
		callbackToken: "callback-token",
	}

	if !s.startBackgroundSessionSnapshot(input) {
		t.Fatal("background snapshot was not accepted")
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("background snapshot did not finish")
	}
	// The runner returns before the goroutine reports, so wait for the reporting tail rather
	// than sampling immediately: a "no incident" assertion taken too early passes vacuously.
	if wantIncident {
		waitFor(t, func() bool {
			return failureReports.Load() > 0 && errorPosts.Load() > 0
		}, "control plane did not receive both the failure callback and the incident")
	} else {
		waitFor(t, func() bool { return failureReports.Load() > 0 },
			"control plane did not receive the generation-scoped failure callback")
		// The failure callback and the incident post are independent writes. Give a wrongly
		// un-suppressed incident a settle window to land, so "0 posts" means "none was sent"
		// rather than "we sampled too early".
		time.Sleep(150 * time.Millisecond)
	}

	return backgroundSnapshotIncidentProbe{
		errorPosts:    errorPosts.Load(),
		failureReport: failureReports.Load() > 0,
	}
}

func waitFor(t *testing.T, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal(msg)
}

// TestBackgroundSessionSnapshotIncidentSeverity pins which capture failures are worth an
// operator-visible incident. The teardown-race cases are the production noise this filters
// (224 of 234 vm-agent error incidents over 2026-08-20..26); the material cases are the
// discriminating controls that must keep reporting.
func TestBackgroundSessionSnapshotIncidentSeverity(t *testing.T) {
	tests := []struct {
		name         string
		captureErr   error
		wantIncident bool
	}{
		{
			// Built by resolveContainerForWorkspace, not hand-written, so this case still
			// holds if that error is ever reworded. See .claude/rules/62.
			name:       "stopped workspace teardown race",
			captureErr: wrapAsSnapshotResolveError(stoppedWorkspaceResolveError(t)),
		},
		{
			name:       "workspace runtime already removed",
			captureErr: wrapAsSnapshotResolveError(missingWorkspaceResolveError(t)),
		},
		{
			// Deliberately a literal, unlike the two cases above. This one is matched by
			// isContainerUnavailableError's pre-existing substring check, not by an errors.Is
			// sentinel, so there is no %w chain for a real producer to exercise — and driving
			// the real container resolver would need Docker-level mocking this package does
			// not have. The literal is the production message verbatim; the substring the
			// predicate depends on is pinned independently by TestIsContainerUnavailableError.
			name:       "devcontainer already gone",
			captureErr: errors.New("resolve snapshot devcontainer: failed to resolve container: no running devcontainer found (label: devcontainer.local_folder=/workspace)"),
		},
		{
			// Racing a restart is NOT teardown: the workspace was running a moment ago and
			// goes back to "creating". Evidence only covers "stopped", so this must report.
			name:         "workspace restarting",
			captureErr:   wrapAsSnapshotResolveError(&workspaceNotRunningError{status: "creating"}),
			wantIncident: true,
		},
		{
			name:         "workspace in error state",
			captureErr:   wrapAsSnapshotResolveError(&workspaceNotRunningError{status: "error"}),
			wantIncident: true,
		},
		{
			name:         "material upload failure",
			captureErr:   errors.New("snapshot control plane returned HTTP 400: checksum mismatch"),
			wantIncident: true,
		},
		{
			// completeSnapshot is a real hard-failure point that boxes the error WITH a
			// generation, so this is the shape a genuine capture timeout arrives in. (A WIP
			// bundle timeout does not reach here — it degrades the manifest instead.)
			name:         "capture exceeded its time budget",
			captureErr:   fmt.Errorf(`Post "https://api.example.test/session-snapshot/complete": %w`, context.DeadlineExceeded),
			wantIncident: true,
		},
		{
			// The first cut suppressed context.Canceled too. Production really does emit
			// cancellation-shaped capture failures, and they mean the capture did not finish.
			name:         "capture cancelled mid-flight",
			captureErr:   fmt.Errorf("create auth file parent dir: command failed: %w", context.Canceled),
			wantIncident: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := runBackgroundSnapshotIncidentProbe(t, tt.captureErr, tt.wantIncident)

			if tt.wantIncident && got.errorPosts == 0 {
				t.Fatalf("error posts = 0, want an incident for %q", tt.captureErr)
			}
			if !tt.wantIncident && got.errorPosts != 0 {
				t.Fatalf("error posts = %d, want 0 for expected teardown race %q", got.errorPosts, tt.captureErr)
			}
			// Suppressing the incident must not blind the control plane: the
			// generation-scoped failure callback fires either way.
			if !got.failureReport {
				t.Fatal("generation-scoped snapshot failure callback was not sent")
			}
		})
	}
}

// stoppedWorkspaceResolveError returns the error the real resolver produces for a workspace
// that has already been stopped — the production teardown race.
func stoppedWorkspaceResolveError(t *testing.T) error {
	t.Helper()
	s := &Server{
		config:     &config.Config{},
		workspaces: map[string]*WorkspaceRuntime{"workspace-1": {ID: "workspace-1", Status: "stopped"}},
	}
	_, _, _, err := s.resolveContainerForWorkspace("workspace-1")
	if err == nil {
		t.Fatal("resolveContainerForWorkspace succeeded for a stopped workspace")
	}
	return err
}

// missingWorkspaceResolveError returns the error the real resolver produces once the workspace
// runtime has been removed entirely.
func missingWorkspaceResolveError(t *testing.T) error {
	t.Helper()
	s := &Server{config: &config.Config{}, workspaces: map[string]*WorkspaceRuntime{}}
	_, _, _, err := s.resolveContainerForWorkspace("workspace-1")
	if err == nil {
		t.Fatal("resolveContainerForWorkspace succeeded for a missing workspace")
	}
	return err
}

// wrapAsSnapshotResolveError boxes a resolver failure through the SAME production seam the
// capture path uses, so a change to that wrap (e.g. %w -> %v) breaks these tests instead of
// silently disabling classification in production.
func wrapAsSnapshotResolveError(err error) error {
	return newSnapshotResolveError("generation-1", err)
}

// TestWorkspaceLifecycleErrorsClassifyWithoutTriggeringRecovery pins the split this fix exists
// to create. The shared recovery trigger must NOT match a deliberately stopped workspace — its
// three call sites (websocket.go terminal + multi-terminal create, agent_ws.go SessionHost
// start) all react by running recoverWorkspaceRuntime — while the snapshot classifier must.
// See .claude/rules/67-shared-predicates-that-trigger-actions.md.
func TestWorkspaceLifecycleErrorsClassifyWithoutTriggeringRecovery(t *testing.T) {
	tests := []struct {
		name    string
		err     error
		wantMsg string
	}{
		{
			name:    "stopped workspace",
			err:     stoppedWorkspaceResolveError(t),
			wantMsg: "workspace is not running/recovery (status: stopped)",
		},
		{
			name:    "workspace runtime removed",
			err:     missingWorkspaceResolveError(t),
			wantMsg: "workspace not found",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// The operator-facing message must not drift when switching to sentinels: these
			// strings appear verbatim in HTTP error responses and production logs.
			if got := tt.err.Error(); got != tt.wantMsg {
				t.Fatalf("message = %q, want %q", got, tt.wantMsg)
			}
			if isContainerUnavailableError(tt.err) {
				t.Fatalf("isContainerUnavailableError(%q) = true; recovery must not fire for a stopped/absent workspace", tt.err)
			}
			if !isSnapshotTeardownRaceError(wrapAsSnapshotResolveError(tt.err)) {
				t.Fatalf("isSnapshotTeardownRaceError(%q) = false; snapshot noise must still be classified", tt.err)
			}
		})
	}
}
