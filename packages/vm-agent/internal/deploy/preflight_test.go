package deploy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newPreflightEngine(t *testing.T) *Engine {
	t.Helper()
	disk, err := NewDiskState(t.TempDir())
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}
	return NewEngine(disk, nil, EngineConfig{EnvironmentID: "env", NodeID: "node"})
}

func TestCaddyAdminReachable_FalseWhenNoServer(t *testing.T) {
	// Nothing is listening on the admin port in the test environment, so the
	// reachability probe must report false — this is the signal that detects a
	// caddy service that failed to start.
	e := newPreflightEngine(t)
	if e.caddyAdminReachable(context.Background()) {
		t.Fatal("expected caddy admin API to be unreachable with no running service")
	}
}

func TestCaddyAdminReachable_TrueWhenServerResponds(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	defer srv.Close()

	e := newPreflightEngine(t)
	if !e.reachable(context.Background(), srv.URL) {
		t.Fatal("expected reachable to return true for a responding server")
	}
}

func TestReachable_FalseOn5xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()

	e := newPreflightEngine(t)
	if e.reachable(context.Background(), srv.URL) {
		t.Fatal("expected reachable to return false on 5xx response")
	}
}

func TestLogPreflight_DoesNotPanic(t *testing.T) {
	// LogPreflight is purely observational and must never panic or block beyond
	// its bounded timeouts, even when every dependency is missing.
	e := newPreflightEngine(t)
	e.LogPreflight(context.Background())
}
