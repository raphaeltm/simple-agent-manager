package server

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/ports"
)

func TestStartPortScannerSkipsWhenContainerModeDisabled(t *testing.T) {
	s := &Server{
		config: &config.Config{
			PortScanEnabled: true,
			ContainerMode:   false,
		},
		portScanners:    make(map[string]*ports.Scanner),
		workspaceEvents: map[string][]EventRecord{},
	}

	s.StartPortScanner("ws-test")

	s.portScannerMu.RLock()
	_, exists := s.portScanners["ws-test"]
	s.portScannerMu.RUnlock()

	if exists {
		t.Fatal("expected no scanner when ContainerMode is disabled")
	}
}

func TestStartPortScannerSkipsWhenDisabled(t *testing.T) {
	s := &Server{
		config: &config.Config{
			PortScanEnabled: false,
			ContainerMode:   true,
		},
		portScanners:    make(map[string]*ports.Scanner),
		workspaceEvents: map[string][]EventRecord{},
	}

	s.StartPortScanner("ws-test")

	s.portScannerMu.RLock()
	_, exists := s.portScanners["ws-test"]
	s.portScannerMu.RUnlock()

	if exists {
		t.Fatal("expected no scanner when PortScanEnabled is false")
	}
}

func TestStopPortScannerRemovesFromMap(t *testing.T) {
	scanner := ports.NewScanner(ports.ScannerConfig{
		Enabled:  true,
		Interval: time.Hour, // Long interval — won't tick during test
	})
	scanner.Start()

	s := &Server{
		config:          &config.Config{},
		portScanners:    map[string]*ports.Scanner{"ws-test": scanner},
		workspaceEvents: map[string][]EventRecord{},
	}

	s.stopPortScanner("ws-test")

	s.portScannerMu.RLock()
	_, exists := s.portScanners["ws-test"]
	s.portScannerMu.RUnlock()

	if exists {
		t.Fatal("expected scanner to be removed after stopPortScanner")
	}
}

func TestStopPortScannerIdempotent(t *testing.T) {
	s := &Server{
		config:          &config.Config{},
		portScanners:    make(map[string]*ports.Scanner),
		workspaceEvents: map[string][]EventRecord{},
	}

	// Should not panic when no scanner exists
	s.stopPortScanner("ws-nonexistent")
}

// TestProvisionSuccessStartsPortScanner is a structural regression test verifying
// that startWorkspaceProvision calls StartPortScanner after successful provisioning,
// and that stop/delete handlers call stopPortScanner.
//
// Root cause: dynamically created workspaces (POST /workspaces) never had their
// port scanners started because StartPortScanner was only called in
// OnBootstrapComplete for the boot-time workspace.
func TestProvisionSuccessStartsPortScanner(t *testing.T) {
	data, err := os.ReadFile("workspaces.go")
	if err != nil {
		t.Fatalf("read workspaces.go: %v", err)
	}
	content := string(data)

	// The fix: startWorkspaceProvision must call StartPortScanner after success
	if !strings.Contains(content, "StartPortScanner(runtime.ID)") {
		t.Fatal("startWorkspaceProvision must call StartPortScanner after successful provisioning")
	}

	// The fix: stop and delete handlers must call stopPortScanner
	count := strings.Count(content, "stopPortScanner(workspaceID)")
	if count < 2 {
		t.Fatalf("expected stopPortScanner in both stop and delete handlers, found %d occurrences", count)
	}
}

func TestStopAllPortScannersEmptiesMap(t *testing.T) {
	scanner := ports.NewScanner(ports.ScannerConfig{
		Enabled:  true,
		Interval: time.Hour,
	})
	scanner.Start()

	s := &Server{
		config:          &config.Config{},
		portScanners:    map[string]*ports.Scanner{"ws-1": scanner},
		workspaceEvents: map[string][]EventRecord{},
	}

	s.stopAllPortScanners()

	s.portScannerMu.RLock()
	count := len(s.portScanners)
	s.portScannerMu.RUnlock()

	if count != 0 {
		t.Fatalf("expected 0 scanners after stopAll, got %d", count)
	}
}
