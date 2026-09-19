package server

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/deploy"
	"github.com/workspace/vm-agent/internal/persistence"
)

// applyDedupHarness stands up a Server plus a control-plane stub that counts
// deploy-release fetches and blocks until released, so a second invocation can
// be attempted while the first is genuinely still running.
type applyDedupHarness struct {
	server  *Server
	engine  *deploy.Engine
	fetches *atomic.Int64
	release chan struct{}
}

func newApplyDedupHarness(t *testing.T) *applyDedupHarness {
	t.Helper()

	fetches := &atomic.Int64{}
	release := make(chan struct{})
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/deploy-release") || strings.Contains(r.URL.Path, "/deploy-routes") {
			fetches.Add(1)
			select {
			case <-release:
			case <-r.Context().Done():
			}
			w.WriteHeader(http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(ts.Close)

	store, err := persistence.Open(filepath.Join(t.TempDir(), "vm-agent.db"))
	if err != nil {
		t.Fatalf("Open persistence store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	s := &Server{
		config: &config.Config{
			NodeID:                 "node-1",
			ControlPlaneURL:        ts.URL,
			CallbackToken:          "callback-token",
			DeployApplyIdleTimeout: 10 * time.Second,
		},
		store:          store,
		applyWatchdogs: make(map[string]chan struct{}),
		inFlightJobs:   make(map[string]struct{}),
	}

	disk, err := deploy.NewDiskState(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}
	engine := deploy.NewEngine(disk, nil, deploy.EngineConfig{
		EnvironmentID:   "env-1",
		NodeID:          "node-1",
		ControlPlaneURL: ts.URL,
		HTTPClient:      deploy.NewArtifactHTTPClient(deploy.ArtifactHTTPClientConfig{}),
		ApplyProgress:   s.persistApplyProgress,
		ApplyLiveness:   s.signalApplyLiveness,
	})

	return &applyDedupHarness{
		server:  s,
		engine:  engine,
		fetches: fetches,
		release: release,
	}
}

// waitForFetches blocks until the stub has served n fetches, or fails the test.
// Deliberately a real deadline: an earlier version used `select` with a
// `default` branch, which makes the `time.After` case unreachable and turns the
// wait into an unbounded busy loop.
func (h *applyDedupHarness) waitForFetches(t *testing.T, n int64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if h.fetches.Load() >= n {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d control-plane fetches (saw %d)", n, h.fetches.Load())
}

// The incident's upstream cause: the heartbeat re-advertises a pending release
// on every tick until observed.AppliedSeq advances, and that only happens after
// a full successful apply. Any release slower than one heartbeat interval used
// to spawn another concurrent apply per tick — each re-running the whole
// control-plane fetch, which is where the app-route DNS create race lives.
func TestRunDetachedDeploymentApplySkipsDuplicateInFlightJob(t *testing.T) {
	h := newApplyDedupHarness(t)

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		h.server.runDetachedDeploymentApply("env-1", 7, h.engine)
	}()

	h.waitForFetches(t, 1)

	// Second heartbeat tick for the SAME release while the first is still running.
	h.server.runDetachedDeploymentApply("env-1", 7, h.engine)

	if got := h.fetches.Load(); got != 1 {
		t.Fatalf("deploy-release fetches = %d, want 1 (duplicate should be skipped)", got)
	}

	close(h.release)
	wg.Wait()
}

// Discriminating control: a genuinely different release must NOT be skipped, or
// the guard would stall every subsequent deployment.
func TestRunDetachedDeploymentApplyAllowsDifferentSeq(t *testing.T) {
	h := newApplyDedupHarness(t)
	close(h.release) // let fetches return immediately

	h.server.runDetachedDeploymentApply("env-1", 7, h.engine)
	h.server.runDetachedDeploymentApply("env-1", 8, h.engine)

	if got := h.fetches.Load(); got != 2 {
		t.Fatalf("deploy-release fetches = %d, want 2 (distinct seqs must both run)", got)
	}
}

// The claim must be released when an apply finishes, or a retry of the same seq
// after a transient failure would be skipped forever and the node would silently
// stop applying that release.
func TestRunDetachedDeploymentApplyReleasesClaimOnCompletion(t *testing.T) {
	h := newApplyDedupHarness(t)
	close(h.release)

	h.server.runDetachedDeploymentApply("env-1", 7, h.engine)
	h.server.runDetachedDeploymentApply("env-1", 7, h.engine)

	if got := h.fetches.Load(); got != 2 {
		t.Fatalf("deploy-release fetches = %d, want 2 (claim must be released after completion)", got)
	}
}

// Route-config applies are spawned from the same heartbeat loop and need the
// same guard.
func TestRunDetachedDeploymentRouteApplySkipsDuplicateInFlightJob(t *testing.T) {
	h := newApplyDedupHarness(t)

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		h.server.runDetachedDeploymentRouteApply("env-1", 3, h.engine)
	}()

	h.waitForFetches(t, 1)

	h.server.runDetachedDeploymentRouteApply("env-1", 3, h.engine)

	if got := h.fetches.Load(); got != 1 {
		t.Fatalf("route-config fetches = %d, want 1 (duplicate should be skipped)", got)
	}

	close(h.release)
	wg.Wait()
}

// claimJob is reached from many heartbeat goroutines at once; it must hand out
// exactly one claim per id under -race.
func TestClaimJobIsExclusiveUnderConcurrency(t *testing.T) {
	s := &Server{inFlightJobs: make(map[string]struct{})}

	var claimed atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, ok := s.claimJob("job-1"); ok {
				claimed.Add(1)
			}
		}()
	}
	wg.Wait()

	if got := claimed.Load(); got != 1 {
		t.Fatalf("concurrent claims granted = %d, want exactly 1", got)
	}
}

// Releasing twice must not corrupt the set or free a claim someone else holds.
func TestClaimJobReleaseIsIdempotent(t *testing.T) {
	s := &Server{inFlightJobs: make(map[string]struct{})}

	release, ok := s.claimJob("job-1")
	if !ok {
		t.Fatal("first claim was refused")
	}
	release()
	release()

	release2, ok2 := s.claimJob("job-1")
	if !ok2 {
		t.Fatal("claim after release was refused")
	}

	if _, ok3 := s.claimJob("job-1"); ok3 {
		t.Fatal("second concurrent claim granted after re-claim — release() freed a live claim")
	}
	release2()
}

// A nil map (as older test fixtures construct) must not panic.
func TestClaimJobHandlesNilMap(t *testing.T) {
	s := &Server{}
	release, ok := s.claimJob("job-1")
	if !ok {
		t.Fatal("claim on nil map was refused")
	}
	if _, ok2 := s.claimJob("job-1"); ok2 {
		t.Fatal("duplicate claim granted after lazy map init")
	}
	release()
}
