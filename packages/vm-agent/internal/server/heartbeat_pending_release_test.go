package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/deploy"
	"github.com/workspace/vm-agent/internal/persistence"
)

// pendingReleaseHarness drives the REAL heartbeat path (sendNodeHeartbeat) against a
// control-plane stub, and records which (environmentId, seq) pairs the agent went on to
// fetch a release for.
//
// Entering through sendNodeHeartbeat rather than calling the merge inline is the point:
// the defect was in how the heartbeat RESPONSE is interpreted, so a test that hands the
// merged list straight to runDetachedDeploymentApply could never observe it
// (.claude/rules/62).
type pendingReleaseHarness struct {
	server *Server

	mu      sync.Mutex
	fetched []string
}

// releaseFetches returns the sorted "<environmentId>@<seq>" keys the agent requested.
func (h *pendingReleaseHarness) releaseFetches() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := append([]string(nil), h.fetched...)
	sort.Strings(out)
	return out
}

// waitForQuiescence gives the detached apply goroutines time to reach the control
// plane, then confirms no further fetch arrives. A duplicate spawn races the first, so
// the assertion has to survive the window in which it would appear rather than sampling
// immediately.
func (h *pendingReleaseHarness) waitForQuiescence(t *testing.T, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if len(h.releaseFetches()) >= want {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	// Settle: anything spawned alongside the first has had its chance by now.
	time.Sleep(250 * time.Millisecond)
}

// newPendingReleaseHarness wires a Server whose configured ENVIRONMENT_ID is
// configEnvironmentID (cloud-init always sets one, which is what made the legacy
// field fire on every deployment node).
func newPendingReleaseHarness(t *testing.T, configEnvironmentID string, resp heartbeatResponse) *pendingReleaseHarness {
	t.Helper()

	h := &pendingReleaseHarness{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/heartbeat"):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(resp)
		case strings.Contains(r.URL.Path, "/deploy-release"):
			q, _ := url.ParseQuery(r.URL.RawQuery)
			h.mu.Lock()
			h.fetched = append(h.fetched, q.Get("environmentId")+"@"+q.Get("seq"))
			h.mu.Unlock()
			// 409 ends the apply immediately; the fetch itself is what we count,
			// because the fetch is the expensive, DNS-racing side effect.
			w.WriteHeader(http.StatusConflict)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(ts.Close)

	store, err := persistence.Open(filepath.Join(t.TempDir(), "vm-agent.db"))
	if err != nil {
		t.Fatalf("Open persistence store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	cfg := &config.Config{
		NodeID:                 "node-deploy-1",
		Role:                   config.RoleDeployment,
		EnvironmentID:          configEnvironmentID,
		ControlPlaneURL:        ts.URL,
		CallbackToken:          "callback-token",
		HeartbeatInterval:      time.Minute,
		DeployBaseDir:          t.TempDir(),
		DeployApplyIdleTimeout: 5 * time.Second,
	}
	h.server = &Server{
		config:         cfg,
		callbackToken:  cfg.CallbackToken,
		store:          store,
		workspaces:     make(map[string]*WorkspaceRuntime),
		applyWatchdogs: make(map[string]chan struct{}),
		inFlightJobs:   make(map[string]struct{}),
		deployEngines:  make(map[string]*deploy.Engine),
		deployRetiring: make(map[string]bool),
		errorReporter:  newTestErrorReporter(),
		done:           make(chan struct{}),
	}
	return h
}

// Regression for the production duplicate: a single pending release advertised in BOTH
// deployment.pendingReleases and the legacy top-level pendingReleaseSeq must produce ONE
// apply, not two.
//
// Before the fix the agent appended the legacy copy to the structured list
// unconditionally, so one heartbeat tick spawned two apply goroutines. Production showed
// this as an exact 2:1 ratio of deployment.apply.fetch_started to
// deployment.apply.started, with the pair 4 ms apart.
func TestHeartbeatIgnoresLegacyPendingReleaseSeqWhenStructuredListPresent(t *testing.T) {
	h := newPendingReleaseHarness(t, "env-a", heartbeatResponse{
		Status:            "running",
		HealthStatus:      "healthy",
		PendingReleaseSeq: 7,
		Deployment: deploymentHeartbeatResponse{
			PendingReleases: []deploymentPendingReleaseResponse{{EnvironmentID: "env-a", Seq: 7}},
		},
	})

	h.server.sendNodeHeartbeat()
	h.waitForQuiescence(t, 1)

	// Liveness: the release really was fetched, so a passing test cannot mean the
	// whole apply path went silent.
	if got := h.releaseFetches(); len(got) != 1 || got[0] != "env-a@7" {
		t.Fatalf("release fetches = %v, want exactly [env-a@7]", got)
	}
}

// The mis-attribution case, which claimJob CANNOT dedupe because the job ids differ.
// The node's cloud-init ENVIRONMENT_ID is env-a, but the pending release belongs to
// env-b. Appending the legacy seq under the configured id spawned a second, bogus apply
// that asked env-a's engine to apply env-b's sequence number.
func TestHeartbeatDoesNotMisattributeLegacySeqToConfiguredEnvironment(t *testing.T) {
	h := newPendingReleaseHarness(t, "env-a", heartbeatResponse{
		Status:            "running",
		HealthStatus:      "healthy",
		PendingReleaseSeq: 9,
		Deployment: deploymentHeartbeatResponse{
			PendingReleases: []deploymentPendingReleaseResponse{{EnvironmentID: "env-b", Seq: 9}},
		},
	})

	h.server.sendNodeHeartbeat()
	h.waitForQuiescence(t, 1)

	if got := h.releaseFetches(); len(got) != 1 || got[0] != "env-b@9" {
		t.Fatalf("release fetches = %v, want exactly [env-b@9] (env-a@9 is the mis-attributed duplicate)", got)
	}
}

// Control for the fallback itself: an older control plane that sends ONLY the legacy
// field must still get its release applied, under the configured environment id.
// Without this, dropping the legacy branch entirely would look like the fix.
func TestHeartbeatHonoursLegacyPendingReleaseSeqWhenStructuredListAbsent(t *testing.T) {
	h := newPendingReleaseHarness(t, "env-a", heartbeatResponse{
		Status:            "running",
		HealthStatus:      "healthy",
		PendingReleaseSeq: 4,
		Deployment:        deploymentHeartbeatResponse{},
	})

	h.server.sendNodeHeartbeat()
	h.waitForQuiescence(t, 1)

	if got := h.releaseFetches(); len(got) != 1 || got[0] != "env-a@4" {
		t.Fatalf("release fetches = %v, want exactly [env-a@4] (legacy fallback must still work)", got)
	}
}

func TestHeartbeatIgnoresLegacyPendingReleaseSeqWhenStructuredListExplicitlyEmpty(t *testing.T) {
	h := newPendingReleaseHarness(t, "env-a", heartbeatResponse{
		Status:            "running",
		HealthStatus:      "healthy",
		PendingReleaseSeq: 4,
		Deployment: deploymentHeartbeatResponse{
			PendingReleases: []deploymentPendingReleaseResponse{},
		},
	})

	h.server.sendNodeHeartbeat()
	h.waitForQuiescence(t, 0)

	if got := h.releaseFetches(); len(got) != 0 {
		t.Fatalf("release fetches = %v, want none when structured pendingReleases is explicitly empty", got)
	}
}

// Control: distinct environments each with their own pending release must all run. The
// guard narrows the LEGACY field only; it must not collapse a genuine multi-environment
// advertisement.
func TestHeartbeatAppliesEveryStructuredPendingRelease(t *testing.T) {
	h := newPendingReleaseHarness(t, "env-a", heartbeatResponse{
		Status:       "running",
		HealthStatus: "healthy",
		Deployment: deploymentHeartbeatResponse{
			PendingReleases: []deploymentPendingReleaseResponse{
				{EnvironmentID: "env-a", Seq: 2},
				{EnvironmentID: "env-b", Seq: 5},
			},
		},
	})

	h.server.sendNodeHeartbeat()
	h.waitForQuiescence(t, 2)

	got := h.releaseFetches()
	if len(got) != 2 || got[0] != "env-a@2" || got[1] != "env-b@5" {
		t.Fatalf("release fetches = %v, want [env-a@2 env-b@5]", got)
	}
}
