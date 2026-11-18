package server

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/container"
	"github.com/workspace/vm-agent/internal/persistence"
)

func TestPortProxyRecoversWorkspaceDiscoveryAfterRestart(t *testing.T) {
	docker := filepath.Join(t.TempDir(), "docker")
	script := `#!/bin/sh
case "$1" in
 ps) case "$*" in *label=devcontainer.local_folder=/workspace/restored-repo*) printf 'restored-container\t2026-01-01 00:00:00 +0000 UTC\n';; esac ;;
 inspect) case "$3" in *State.Running*) printf 'true\n';; *) printf '127.0.0.1\n';; esac ;;
 *) exit 1 ;;
esac
`
	if err := os.WriteFile(docker, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SAM_DOCKER_CLI_PATH", docker)
	for _, source := range []string{"runtime", "persisted metadata"} {
		t.Run(source, func(t *testing.T) {
			h := newRelayHarness(t)
			h.server.config.Role = config.RoleWorkspace
			h.server.config.ContainerMode = true
			h.server.config.PortScanEnabled = false // Forwarding must not depend on scanner startup.
			h.server.containerDiscovery = container.NewDiscovery(container.Config{LabelValue: "/workspace"})
			if source == "runtime" {
				h.server.workspaces[relayTestWorkspaceID] = &WorkspaceRuntime{ID: relayTestWorkspaceID, Status: "running", ContainerLabelValue: "/workspace/restored-repo"}
			} else {
				store, err := persistence.Open(filepath.Join(t.TempDir(), "state.db"))
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { store.Close() })
				h.server.store = store
				if err := store.UpsertWorkspaceMetadata(persistence.WorkspaceMetadata{WorkspaceID: relayTestWorkspaceID, ContainerLabelVal: "/workspace/restored-repo"}); err != nil {
					t.Fatal(err)
				}
			}
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "restored-app") }))
			defer backend.Close()
			port := backend.Listener.Addr().(*net.TCPAddr).Port
			// A new server has neither scanner nor discovery state, as after a reboot.
			status, body := doRelayRequest(t, h.apiPortRequest(port, "/", "", true))
			if status != http.StatusOK || body != "restored-app" {
				t.Fatalf("preview did not recover: status=%d body=%s", status, body)
			}
			if h.server.portDiscoveries[relayTestWorkspaceID] == nil {
				t.Fatal("workspace discovery was not cached")
			}
			if len(h.server.portScanners) != 0 {
				t.Fatal("preview unexpectedly started a scanner")
			}
		})
	}
}

func TestWorkspacePortDiscoveryRejectsUnknownAndEvictedRoutes(t *testing.T) {
	for _, state := range []string{"unknown", "evicted", "unreadable"} {
		t.Run(state, func(t *testing.T) {
			store, err := persistence.Open(filepath.Join(t.TempDir(), "state.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			if state == "evicted" {
				if err := store.UpsertWorkspaceMetadata(persistence.WorkspaceMetadata{WorkspaceID: "ws", ContainerLabelVal: "/workspace/evicted", Evicted: true}); err != nil {
					t.Fatal(err)
				}
			}
			if state == "unreadable" {
				store.Close()
			}
			s := &Server{config: &config.Config{ContainerMode: true}, store: store, containerDiscovery: container.NewDiscovery(container.Config{LabelValue: "/workspace/global"})}
			ip, err := s.resolveWorkspaceBridgeIP("ws")
			if err == nil || ip != "" || strings.Contains(err.Error(), "/workspace/global") {
				t.Fatal("missing durable route used global container fallback")
			}
			if len(s.portDiscoveries) != 0 {
				t.Fatal("invalid route was cached")
			}
		})
	}
}

func TestPortScannerDoesNotUseNodeWideDiscoveryForUnknownWorkspace(t *testing.T) {
	s := &Server{
		config:             &config.Config{ContainerMode: true, PortScanEnabled: true},
		containerDiscovery: container.NewDiscovery(container.Config{LabelValue: "/workspace/global"}),
	}
	s.StartPortScanner("unknown")
	if len(s.portScanners) != 0 || len(s.portDiscoveries) != 0 {
		s.stopAllPortScanners()
		t.Fatal("unknown workspace acquired node-wide port discovery")
	}
}

func TestWorkspacePortDiscoveryDoesNotReviveCachedUnavailableWorkspace(t *testing.T) {
	for _, state := range []string{"unknown", "stopped", "evicted", "deleted", "deletion pending"} {
		t.Run(state, func(t *testing.T) {
			store, err := persistence.Open(filepath.Join(t.TempDir(), "state.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			s := &Server{config: &config.Config{ContainerMode: true}, store: store,
				workspaces:      map[string]*WorkspaceRuntime{},
				portDiscoveries: map[string]*container.Discovery{"ws": container.NewDiscovery(container.Config{LabelValue: "/workspace/cached"})},
			}
			switch state {
			case "stopped", "evicted":
				s.workspaces["ws"] = &WorkspaceRuntime{ID: "ws", Status: state, ContainerLabelValue: "/workspace/cached"}
			case "deleted", "deletion pending":
				if err := store.UpsertWorkspaceMetadata(persistence.WorkspaceMetadata{WorkspaceID: "ws", ContainerLabelVal: "/workspace/cached"}); err != nil {
					t.Fatal(err)
				}
				if state == "deleted" {
					if err := store.DeleteWorkspaceMetadata("ws"); err != nil {
						t.Fatal(err)
					}
				} else if err := store.PutWorkspaceDeletion("ws", `{"finalized":false}`); err != nil {
					t.Fatal(err)
				}
			}
			if discovery, err := s.workspacePortDiscovery("ws"); err == nil || discovery != nil {
				t.Fatal("stale discovery bypassed workspace lifecycle state")
			}
		})
	}
}
