package server

import (
	"context"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/container"
	"github.com/workspace/vm-agent/internal/eventstore"
	"github.com/workspace/vm-agent/internal/messagereport"
	"github.com/workspace/vm-agent/internal/persistence"
	"github.com/workspace/vm-agent/internal/ports"
	"github.com/workspace/vm-agent/internal/resourcemon"
)

func TestServerStopIsIdempotentAndClosesOwnedResources(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	store, err := persistence.Open(filepath.Join(dir, "persistence.db"))
	if err != nil {
		t.Fatalf("open persistence store: %v", err)
	}
	evStore, err := eventstore.New(filepath.Join(dir, "events.db"))
	if err != nil {
		t.Fatalf("open event store: %v", err)
	}
	resMon, err := resourcemon.New(filepath.Join(dir, "metrics.db"), time.Hour)
	if err != nil {
		t.Fatalf("open resource monitor: %v", err)
	}

	s := &Server{
		config:            &config.Config{},
		httpServer:        &http.Server{},
		done:              make(chan struct{}),
		sessionHosts:      make(map[string]*acp.SessionHost),
		sessionMcpServers: make(map[string][]acp.McpServerEntry),
		sessionProfileOvr: make(map[string]profileOverrides),
		sessionTaskCtx:    make(map[string]taskCallbackContext),
		messageReporters:  make(map[string]*messagereport.Reporter),
		store:             store,
		eventStore:        evStore,
		resourceMonitor:   resMon,
		workspaces:        make(map[string]*WorkspaceRuntime),
		portScanners:      make(map[string]*ports.Scanner),
		portDiscoveries:   make(map[string]*container.Discovery),
	}

	if err := s.Stop(context.Background()); err != nil {
		t.Fatalf("first Stop returned error: %v", err)
	}

	select {
	case <-s.done:
	default:
		t.Fatal("expected Stop to close done channel")
	}

	if err := s.Stop(context.Background()); err != nil {
		t.Fatalf("second Stop returned error: %v", err)
	}
	if err := evStore.Close(); err != nil {
		t.Fatalf("event store Close should be idempotent after Server.Stop: %v", err)
	}
	if err := resMon.Close(); err != nil {
		t.Fatalf("resource monitor Close should be idempotent after Server.Stop: %v", err)
	}
}

func TestRemoveSessionHostsForWorkspaceReleasesLockAndCleansMetadata(t *testing.T) {
	t.Parallel()

	s := &Server{
		sessionHosts: map[string]*acp.SessionHost{
			"ws-1:sess-1": {},
			"ws-1:sess-2": {},
			"ws-2:sess-1": {},
		},
		sessionMcpServers: map[string][]acp.McpServerEntry{
			"ws-1:sess-1": {{URL: "https://example.com/a"}},
			"ws-2:sess-1": {{URL: "https://example.com/b"}},
		},
		sessionProfileOvr: map[string]profileOverrides{
			"ws-1:sess-1": {Model: "model-a"},
			"ws-2:sess-1": {Model: "model-b"},
		},
		sessionTaskCtx: map[string]taskCallbackContext{
			"ws-1:sess-2": {TaskID: "task-a"},
			"ws-2:sess-1": {TaskID: "task-b"},
		},
	}

	hosts := s.removeSessionHostsForWorkspace("ws-1")
	if len(hosts) != 2 {
		t.Fatalf("expected 2 removed hosts, got %d", len(hosts))
	}

	if !s.sessionHostMu.TryLock() {
		t.Fatal("removeSessionHostsForWorkspace returned while sessionHostMu was still locked")
	}
	defer s.sessionHostMu.Unlock()

	if _, ok := s.sessionHosts["ws-1:sess-1"]; ok {
		t.Fatal("expected ws-1:sess-1 host to be removed")
	}
	if _, ok := s.sessionHosts["ws-1:sess-2"]; ok {
		t.Fatal("expected ws-1:sess-2 host to be removed")
	}
	if _, ok := s.sessionHosts["ws-2:sess-1"]; !ok {
		t.Fatal("expected other workspace host to remain")
	}
	if _, ok := s.sessionMcpServers["ws-1:sess-1"]; ok {
		t.Fatal("expected ws-1 MCP metadata to be removed")
	}
	if _, ok := s.sessionMcpServers["ws-2:sess-1"]; !ok {
		t.Fatal("expected other workspace MCP metadata to remain")
	}
	if _, ok := s.sessionProfileOvr["ws-1:sess-1"]; ok {
		t.Fatal("expected ws-1 profile override to be removed")
	}
	if _, ok := s.sessionTaskCtx["ws-1:sess-2"]; ok {
		t.Fatal("expected ws-1 task context to be removed")
	}
}
