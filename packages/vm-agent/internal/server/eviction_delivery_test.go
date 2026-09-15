package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/persistence"
	"github.com/workspace/vm-agent/internal/resourcemon"
)

func evictionTargetFixture(s *Server) resourcemon.EvictionTarget {
	runtime := s.workspaces["workspace-1"]
	return resourcemon.EvictionTarget{WorkspaceID: runtime.ID, ContainerID: evictionTestContainerID,
		RuntimeVersion: runtime.UpdatedAt.UTC().Format(time.RFC3339Nano), EvictionGeneration: runtime.EvictionGeneration,
		Reason: resourcemon.EvictionReasonMemoryPressure}
}

func queueEvictionFixture(t *testing.T, s *Server, stopped bool) persistence.EvictionDelivery {
	t.Helper()
	d := s.workspaceEvictionDelivery(resourcemon.EvictionResult{Target: evictionTargetFixture(s), ContainerStopped: stopped,
		SnapshotCaptured: stopped, CompletedAt: time.Now().Add(-time.Minute)})
	if applied, err := s.store.RecordWorkspaceEviction(context.Background(), d); err != nil || !applied {
		t.Fatalf("queue=%v %v", applied, err)
	}
	return d
}

func reopenEvictionTestStore(t *testing.T, path string) *persistence.Store {
	t.Helper()
	store, err := persistence.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetCallbackTokenEncryptionSecret("eviction-test-encryption-key"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func TestEvictionStopOwnsLifecycleUntilDockerCommandCompletes(t *testing.T) {
	s := newEvictionTestServer()
	initializeEvictionTestStore(t, s)
	setupEvictionDocker(t, evictionTestContainerID)
	dir := t.TempDir()
	started, release := filepath.Join(dir, "started"), filepath.Join(dir, "release")
	t.Setenv("SAM_EVICTION_TEST_STOP_STARTED", started)
	t.Setenv("SAM_EVICTION_TEST_STOP_RELEASE", release)
	t.Cleanup(func() { _ = os.WriteFile(release, nil, 0600) })
	done := make(chan error, 1)
	go func() { done <- s.stopEvictedWorkspaceContainer(context.Background(), evictionTargetFixture(s)) }()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Docker stop was not reached")
		}
		time.Sleep(5 * time.Millisecond)
	}
	meta, err := s.store.GetWorkspaceMetadata("workspace-1")
	if err != nil || meta == nil || !meta.Evicted {
		t.Fatalf("Docker ran without durable intent: %#v %v", meta, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	if err := s.workspaceLifecycleLock("workspace-1").Lock(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("restart could claim during Docker stop: %v", err)
	}
	other := s.workspaceLifecycleLock("other-workspace")
	if err := other.Lock(context.Background()); err != nil {
		t.Fatal(err)
	}
	other.Unlock()
	if err := os.WriteFile(release, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestEvictionSnapshotRejectsSuccessorAfterWaitingForSnapshotLock(t *testing.T) {
	s := newEvictionTestServer()
	setupEvictionDocker(t, evictionTestContainerID)
	if _, _, err := s.agentSessions.Create("workspace-1", "session-1", "Agent", ""); err != nil {
		t.Fatal(err)
	}
	var captures atomic.Int32
	s.sessionSnapshotRunner = func(context.Context, *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
		captures.Add(1)
		return nil, nil
	}
	target := evictionTargetFixture(s)
	lock := s.sessionSnapshotLock("chat-session-1")
	if err := lock.Lock(context.Background()); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- s.captureEvictionSessionSnapshot(context.Background(), target) }()
	// A newer lifecycle can claim while the eviction is queued for snapshotting.
	lifecycle := s.workspaceLifecycleLock("workspace-1")
	if err := lifecycle.Lock(context.Background()); err != nil {
		t.Fatal(err)
	}
	s.workspaceMu.Lock()
	s.workspaces["workspace-1"].UpdatedAt = time.Now()
	s.workspaces["workspace-1"].EvictionGeneration = "successor-generation"
	s.workspaceMu.Unlock()
	lifecycle.Unlock()
	lock.Unlock()
	if err := <-done; err == nil {
		t.Fatal("stale eviction captured successor snapshot")
	}
	if captures.Load() != 0 {
		t.Fatal("snapshot runner executed for successor")
	}
}

func TestEvictionDeliverySurvivesRestartAndUsesFrozenIdentityWithFreshToken(t *testing.T) {
	s := newEvictionTestServer()
	path := initializeEvictionTestStore(t, s)
	d := queueEvictionFixture(t, s, true)
	var calls atomic.Int32
	tokens := make(chan string, 2)
	paths := make(chan string, 2)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tokens <- r.Header.Get("Authorization")
		paths <- r.URL.Path
		if calls.Add(1) == 1 {
			http.Error(w, "sensitive-response-canary", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer api.Close()
	s.config.ControlPlaneURL = api.URL
	now := time.Now()
	if err := s.deliverPendingWorkspaceEvictionAt(context.Background(), d.ID, now); err == nil || strings.Contains(err.Error(), "sensitive-response-canary") {
		t.Fatalf("first delivery error=%v", err)
	}
	if err := s.store.Close(); err != nil {
		t.Fatal(err)
	}
	restarted := newEvictionTestServer()
	restarted.store = reopenEvictionTestStore(t, path)
	restarted.config.ControlPlaneURL = api.URL
	restarted.workspaces["workspace-1"].ProjectID = "successor-project"
	restarted.workspaces["workspace-1"].CallbackToken = "rotated-callback-token"
	if err := restarted.deliverPendingWorkspaceEvictionAt(context.Background(), "", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if first, second := <-tokens, <-tokens; first != "Bearer workspace-callback-token" || second != "Bearer rotated-callback-token" {
		t.Fatalf("authorization did not refresh: %q %q", first, second)
	}
	for i := 0; i < 2; i++ {
		if path := <-paths; path != "/api/projects/project-1/workspaces/workspace-1/eviction" {
			t.Fatalf("identity changed: %s", path)
		}
	}
	if pending, err := restarted.store.ClaimEvictionDelivery(context.Background(), "", now.Add(2*time.Hour), time.Second, time.Minute, time.Second); err != nil || pending != nil {
		t.Fatalf("acknowledged row=%#v %v", pending, err)
	}
}

func TestEvictionDeliveryRetainsTransientAndAuthFailuresButRetiresGone(t *testing.T) {
	for _, failure := range []int{http.StatusInternalServerError, http.StatusTooManyRequests, http.StatusUnauthorized, http.StatusForbidden, http.StatusConflict} {
		t.Run(http.StatusText(failure), func(t *testing.T) {
			s := newEvictionTestServer()
			initializeEvictionTestStore(t, s)
			d := queueEvictionFixture(t, s, true)
			var calls atomic.Int32
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if calls.Add(1) == 1 {
					w.WriteHeader(failure)
				} else {
					w.WriteHeader(http.StatusGone)
				}
			}))
			defer api.Close()
			s.config.ControlPlaneURL = api.URL
			now := time.Now()
			if err := s.deliverPendingWorkspaceEvictionAt(context.Background(), d.ID, now); err == nil {
				t.Fatal("failure was not retained")
			}
			if err := s.deliverPendingWorkspaceEvictionAt(context.Background(), d.ID, now.Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
			if calls.Load() != 2 {
				t.Fatal("queued callback was lost")
			}
			if pending, err := s.store.ClaimEvictionDelivery(context.Background(), "", now.Add(2*time.Hour), time.Second, time.Minute, time.Second); err != nil || pending != nil {
				t.Fatalf("terminal row retained: %#v %v", pending, err)
			}
		})
	}
}

func TestEvictionPreparedStopRecoversAfterAgentRestart(t *testing.T) {
	for _, test := range []struct{ name, exit string }{{"crash-after-stop-before-mark", "0"}, {"failed-stop", "1"}} {
		t.Run(test.name, func(t *testing.T) {
			s := newEvictionTestServer()
			path := initializeEvictionTestStore(t, s)
			logPath := setupEvictionDocker(t, evictionTestContainerID)
			t.Setenv("SAM_EVICTION_TEST_STOP_EXIT", test.exit)
			if err := s.stopEvictedWorkspaceContainer(context.Background(), evictionTargetFixture(s)); (err != nil) != (test.exit == "1") {
				t.Fatalf("initial stop: %v", err)
			}
			if s.workspaces["workspace-1"].Status != "running" {
				t.Fatal("failed stop was announced as complete")
			}
			if err := s.store.Close(); err != nil {
				t.Fatal(err)
			}
			restarted := newEvictionTestServer()
			restarted.store = reopenEvictionTestStore(t, path)
			restarted.workspaces = map[string]*WorkspaceRuntime{}
			t.Setenv("SAM_EVICTION_TEST_STOP_EXIT", "0")
			requests := make(chan map[string]interface{}, 1)
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]interface{}
				_ = json.NewDecoder(r.Body).Decode(&body)
				requests <- body
				w.WriteHeader(http.StatusNoContent)
			}))
			defer api.Close()
			restarted.config.ControlPlaneURL = api.URL
			if err := restarted.deliverPendingWorkspaceEvictionAt(context.Background(), "", time.Now().Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
			select {
			case body := <-requests:
				if body["containerStopped"] != true {
					t.Fatalf("unconfirmed stop callback: %v", body)
				}
			default:
				t.Fatal("recovered intent was not delivered")
			}
			calls, err := os.ReadFile(logPath)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Count(string(calls), "stop --time") != 2 || strings.Contains(string(calls), " rm ") {
				t.Fatalf("stop was not safely retried: %s", calls)
			}
		})
	}
}

func TestEvictionPreparedStopReconcilesAlreadyStoppedContainer(t *testing.T) {
	s := newEvictionTestServer()
	initializeEvictionTestStore(t, s)
	logPath := setupEvictionDocker(t, "")
	d := queueEvictionFixture(t, s, false)
	requests := make(chan map[string]interface{}, 1)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		requests <- body
		w.WriteHeader(http.StatusNoContent)
	}))
	defer api.Close()
	s.config.ControlPlaneURL = api.URL
	if err := s.deliverPendingWorkspaceEvictionAt(context.Background(), d.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	select {
	case body := <-requests:
		if body["containerStopped"] != true {
			t.Fatalf("already-stopped container was not finalized: %v", body)
		}
	default:
		t.Fatal("already-stopped container delivery was not sent")
	}
	calls, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(calls); !strings.Contains(got, "ps --all") || strings.Contains(got, "stop --time") {
		t.Fatalf("already-stopped reconciliation called unexpected docker commands: %s", got)
	}
}

func TestEvictionPreparedStopCannotStopLaterGeneration(t *testing.T) {
	s := newEvictionTestServer()
	initializeEvictionTestStore(t, s)
	logPath := setupEvictionDocker(t, evictionTestContainerID)
	d := queueEvictionFixture(t, s, false)
	if applied, err := s.store.CompareAndSwapWorkspaceEvictionGeneration("workspace-1", "", "next-generation"); err != nil || !applied {
		t.Fatalf("restart=%v %v", applied, err)
	}
	if err := s.deliverPendingWorkspaceEvictionAt(context.Background(), d.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	if calls, err := os.ReadFile(logPath); err == nil && len(calls) > 0 {
		t.Fatalf("old intent called Docker: %s", calls)
	}
}

func TestEvictionDeliveryShutdownKeepsClaimedRow(t *testing.T) {
	s := newEvictionTestServer()
	initializeEvictionTestStore(t, s)
	d := queueEvictionFixture(t, s, true)
	entered := make(chan struct{})
	release := make(chan struct{})
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered); <-release }))
	defer api.Close()
	defer close(release)
	s.config.ControlPlaneURL = api.URL
	done := make(chan error, 1)
	go func() { done <- s.deliverPendingWorkspaceEvictionAt(context.Background(), d.ID, time.Now()) }()
	<-entered
	close(s.done)
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("shutdown unexpectedly acknowledged delivery")
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown did not cancel delivery")
	}
	pending, err := s.store.ClaimEvictionDelivery(context.Background(), "", time.Now().Add(time.Hour), time.Second, time.Minute, time.Second)
	if err != nil || pending == nil {
		t.Fatalf("shutdown lost durable callback: %#v %v", pending, err)
	}
}

func TestEvictionOutboxPersistsOnlyAllowlistedResultFields(t *testing.T) {
	s := newEvictionTestServer()
	initializeEvictionTestStore(t, s)
	secret := "gho_" + strings.Repeat("C", 36)
	prompt := "private eviction snapshot prompt canary"
	result := resourcemon.EvictionResult{
		Target: evictionTargetFixture(s), ContainerStopped: true,
		SnapshotError:      errors.New("Authorization: Bearer " + secret),
		ContainerStopError: errors.New(prompt),
	}
	result.Target.Event.Message = prompt
	result.Target.Event.ContainerName = secret
	if applied, err := s.store.RecordWorkspaceEviction(context.Background(), s.workspaceEvictionDelivery(result)); err != nil || !applied {
		t.Fatalf("queue=%v %v", applied, err)
	}
	stored, err := s.store.ClaimEvictionDelivery(context.Background(), "", time.Now().Add(time.Hour), time.Second, time.Minute, time.Second)
	if err != nil || stored == nil {
		t.Fatal("could not read queued eviction")
	}
	encoded, err := json.Marshal(stored)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), secret) || strings.Contains(string(encoded), prompt) || strings.Contains(string(encoded), "workspace-callback-token") {
		t.Fatal("sensitive values reached the durable outbox")
	}
}
