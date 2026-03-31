package browser

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

// mockDocker records calls and returns canned responses.
type mockDocker struct {
	mu       sync.Mutex
	calls    []string
	outputs  map[string]string
	errors   map[string]error
}

func newMockDocker() *mockDocker {
	return &mockDocker{
		outputs: make(map[string]string),
		errors:  make(map[string]error),
	}
}

func (m *mockDocker) Run(ctx context.Context, args ...string) ([]byte, error) {
	key := strings.Join(args, " ")
	m.mu.Lock()
	m.calls = append(m.calls, key)
	m.mu.Unlock()

	if err, ok := m.errors[key]; ok {
		return nil, err
	}
	if out, ok := m.outputs[key]; ok {
		return []byte(out), nil
	}
	// Default: return empty success for inspect calls
	if len(args) > 0 && args[0] == "inspect" {
		return []byte("abc123\n"), nil
	}
	return nil, nil
}

func (m *mockDocker) RunSilent(ctx context.Context, args ...string) error {
	key := strings.Join(args, " ")
	m.mu.Lock()
	m.calls = append(m.calls, key)
	m.mu.Unlock()

	if err, ok := m.errors[key]; ok {
		return err
	}
	return nil
}

func (m *mockDocker) getCalls() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]string, len(m.calls))
	copy(result, m.calls)
	return result
}

func testConfig() *config.Config {
	return &config.Config{
		NekoImage:               "ghcr.io/m1k1o/neko/google-chrome:latest",
		NekoScreenResolution:    "1920x1080",
		NekoMaxFPS:              30,
		NekoWebRTCPort:          8080,
		NekoSocatPollInterval:   5 * time.Second,
		NekoMinRAMMB:            2048,
		NekoEnableAudio:         true,
		NekoTCPFallback:         true,
		NekoPassword:            "neko",
		NekoPasswordAdmin:       "admin",
		NekoShmSize:             "2g",
		NekoBrowserStartTimeout: 60 * time.Second,
		NekoBrowserStopTimeout:  30 * time.Second,
		NekoMemoryLimit:         "4g",
		NekoCPULimit:            "2",
		NekoPidsLimit:           512,
		NekoSocatMinPort:        1024,
		NekoSocatMaxPort:        65535,
		NekoViewportMinWidth:    320,
		NekoViewportMaxWidth:    7680,
		NekoViewportMinHeight:   240,
		NekoViewportMaxHeight:   4320,
		NekoViewportMaxDPR:      4,
		PortScanEphemeralMin:    32768,
	}
}

func TestManagerStartStop(t *testing.T) {
	docker := newMockDocker()
	mgr := NewManager(testConfig(), docker)

	ctx := context.Background()

	// Start sidecar
	state, err := mgr.Start(ctx, "ws-1", "workspace-net", "devcontainer-ws-1", StartOptions{})
	if err != nil {
		t.Fatalf("Start error: %v", err)
	}

	if state.Status != StatusRunning {
		t.Errorf("expected running, got %s", state.Status)
	}
	if state.ContainerName != "neko-ws-1" {
		t.Errorf("expected container name neko-ws-1, got %s", state.ContainerName)
	}

	// GetStatus should return running
	status := mgr.GetStatus("ws-1")
	if status.Status != StatusRunning {
		t.Errorf("GetStatus: expected running, got %s", status.Status)
	}

	// Stop sidecar
	if err := mgr.Stop(ctx, "ws-1"); err != nil {
		t.Fatalf("Stop error: %v", err)
	}

	// GetStatus should return off after stop
	status = mgr.GetStatus("ws-1")
	if status.Status != StatusOff {
		t.Errorf("after stop: expected off, got %s", status.Status)
	}

	// Verify docker rm was called
	calls := docker.getCalls()
	hasRm := false
	for _, c := range calls {
		if strings.Contains(c, "rm -f neko-ws-1") {
			hasRm = true
		}
	}
	if !hasRm {
		t.Error("expected 'docker rm -f neko-ws-1' call")
	}
}

func TestManagerStartIdempotent(t *testing.T) {
	docker := newMockDocker()
	mgr := NewManager(testConfig(), docker)
	ctx := context.Background()

	state1, _ := mgr.Start(ctx, "ws-1", "workspace-net", "devcontainer-ws-1", StartOptions{})
	state2, _ := mgr.Start(ctx, "ws-1", "workspace-net", "devcontainer-ws-1", StartOptions{})

	// Second call should return same state without re-creating
	if state1.ContainerName != state2.ContainerName {
		t.Error("second Start should return existing state")
	}
}

func TestManagerStartError(t *testing.T) {
	docker := newMockDocker()
	// Make docker run fail for the container creation
	mgr := NewManager(testConfig(), docker)

	// We need to match the exact docker run command — use a wildcard approach
	// by making all RunSilent calls fail
	docker.errors["*"] = fmt.Errorf("docker daemon not responding")

	// Actually, the mock doesn't support wildcards. Let's use a different approach.
	// Reset and use a failing mock.
	failDocker := &failingDocker{err: fmt.Errorf("docker daemon not responding")}
	mgr = NewManager(testConfig(), failDocker)

	ctx := context.Background()
	state, err := mgr.Start(ctx, "ws-1", "workspace-net", "devcontainer-ws-1", StartOptions{})

	if err == nil {
		t.Fatal("expected error from Start")
	}
	if state.Status != StatusError {
		t.Errorf("expected error status, got %s", state.Status)
	}
}

func TestManagerStopNonexistent(t *testing.T) {
	docker := newMockDocker()
	mgr := NewManager(testConfig(), docker)

	// Stopping a non-existent workspace should be a no-op
	if err := mgr.Stop(context.Background(), "nonexistent"); err != nil {
		t.Fatalf("Stop non-existent workspace should not error: %v", err)
	}
}

func TestManagerGetPorts(t *testing.T) {
	docker := newMockDocker()
	mgr := NewManager(testConfig(), docker)
	ctx := context.Background()

	mgr.Start(ctx, "ws-1", "workspace-net", "devcontainer-ws-1", StartOptions{})

	// Initially no ports
	ports := mgr.GetPorts("ws-1")
	if len(ports) != 0 {
		t.Errorf("expected 0 initial ports, got %d", len(ports))
	}

	// Non-existent workspace
	ports = mgr.GetPorts("nonexistent")
	if ports != nil {
		t.Errorf("expected nil ports for nonexistent workspace, got %v", ports)
	}
}

func TestManagerCleanup(t *testing.T) {
	docker := newMockDocker()
	mgr := NewManager(testConfig(), docker)
	ctx := context.Background()

	mgr.Start(ctx, "ws-1", "workspace-net", "dc-1", StartOptions{})
	mgr.Start(ctx, "ws-2", "workspace-net", "dc-2", StartOptions{})

	mgr.Cleanup(ctx)

	// Both should be stopped
	if mgr.GetStatus("ws-1").Status != StatusOff {
		t.Error("ws-1 should be off after cleanup")
	}
	if mgr.GetStatus("ws-2").Status != StatusOff {
		t.Error("ws-2 should be off after cleanup")
	}
}

func TestManagerCustomViewport(t *testing.T) {
	docker := newMockDocker()
	mgr := NewManager(testConfig(), docker)
	ctx := context.Background()

	_, err := mgr.Start(ctx, "ws-1", "workspace-net", "dc-1", StartOptions{
		ViewportWidth:  375,
		ViewportHeight: 667,
	})
	if err != nil {
		t.Fatalf("Start error: %v", err)
	}

	// Verify the docker run command included the custom resolution
	calls := docker.getCalls()
	found := false
	for _, c := range calls {
		if strings.Contains(c, "NEKO_SCREEN=375x667@30") {
			found = true
		}
	}
	if !found {
		t.Error("expected docker run with custom resolution 375x667@30")
	}
}

func TestManagerStartGeneratesRandomPasswords(t *testing.T) {
	docker := newMockDocker()
	mgr := NewManager(testConfig(), docker)
	ctx := context.Background()

	state, err := mgr.Start(ctx, "ws-1", "workspace-net", "dc-1", StartOptions{})
	if err != nil {
		t.Fatalf("Start error: %v", err)
	}

	if state.Password == "" {
		t.Error("expected non-empty random password")
	}
	if state.PasswordAdmin == "" {
		t.Error("expected non-empty random admin password")
	}
	if state.Password == state.PasswordAdmin {
		t.Error("password and admin password should be different")
	}
	if len(state.Password) != 64 { // 32 bytes = 64 hex chars
		t.Errorf("expected 64 hex char password, got %d chars", len(state.Password))
	}
}

func TestManagerRecoverOrphanedContainers(t *testing.T) {
	docker := newMockDocker()
	docker.outputs["ps -a --filter name=neko- --format {{.Names}}"] = "neko-old-ws-1\nneko-old-ws-2\n"
	mgr := NewManager(testConfig(), docker)

	mgr.RecoverOrphanedContainers(context.Background())

	calls := docker.getCalls()
	hasRm1 := false
	hasRm2 := false
	for _, c := range calls {
		if c == "rm -f neko-old-ws-1" {
			hasRm1 = true
		}
		if c == "rm -f neko-old-ws-2" {
			hasRm2 = true
		}
	}
	if !hasRm1 {
		t.Error("expected 'docker rm -f neko-old-ws-1'")
	}
	if !hasRm2 {
		t.Error("expected 'docker rm -f neko-old-ws-2'")
	}
}

func TestManagerStartDeferredCleanupOnFailure(t *testing.T) {
	// Use a mock that fails on RunSilent for the initial docker run,
	// then check that a cleanup rm -f is attempted.
	docker := &trackingFailDocker{
		failAfter: 0, // fail on first RunSilent call
		calls:     nil,
	}
	mgr := NewManager(testConfig(), docker)
	ctx := context.Background()

	_, err := mgr.Start(ctx, "ws-1", "workspace-net", "dc-1", StartOptions{})
	if err == nil {
		t.Fatal("expected error from Start")
	}

	// Check that rm -f was called for cleanup
	hasCleanup := false
	for _, c := range docker.calls {
		if strings.Contains(c, "rm -f neko-ws-1") {
			hasCleanup = true
		}
	}
	if !hasCleanup {
		t.Error("expected deferred cleanup 'docker rm -f neko-ws-1' after start failure")
	}
}

// trackingFailDocker fails on the Nth RunSilent call but tracks all calls.
type trackingFailDocker struct {
	mu         sync.Mutex
	failAfter  int
	silentCall int
	calls      []string
}

func (f *trackingFailDocker) Run(ctx context.Context, args ...string) ([]byte, error) {
	key := strings.Join(args, " ")
	f.mu.Lock()
	f.calls = append(f.calls, key)
	f.mu.Unlock()
	if len(args) > 0 && args[0] == "inspect" {
		return []byte("abc123\n"), nil
	}
	return nil, nil
}

func (f *trackingFailDocker) RunSilent(ctx context.Context, args ...string) error {
	key := strings.Join(args, " ")
	f.mu.Lock()
	f.calls = append(f.calls, key)
	n := f.silentCall
	f.silentCall++
	f.mu.Unlock()
	if n == f.failAfter {
		return fmt.Errorf("docker run failed")
	}
	return nil
}

// failingDocker always returns an error from RunSilent.
type failingDocker struct {
	err error
}

func (f *failingDocker) Run(ctx context.Context, args ...string) ([]byte, error) {
	return nil, f.err
}

func (f *failingDocker) RunSilent(ctx context.Context, args ...string) error {
	return f.err
}
