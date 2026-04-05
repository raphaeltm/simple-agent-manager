package browser

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

// Realistic /proc/net/tcp content from a Linux container.
const testProcNetTCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 27894 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 27895 1 0000000000000000 100 0 0 10 0
   2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0
   3: 0187A8C0:0050 0287A8C0:C350 01 00000000:00000000 02:000000D7 00000000  1000        0 28456 2 0000000000000000 20 4 30 10 -1
   4: 00000000:8000 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 28459 1 0000000000000000 100 0 0 10 0`

func TestParseProcNetTCP(t *testing.T) {
	ports := parseProcNetTCP(testProcNetTCP, 32768, 1024, 65535)

	// Should find listening ports: 3000 (0x0BB8), 8080 (0x1F90)
	// Should exclude: 22 (0x0016, below minPort 1024), ESTABLISHED (state 01), 32768 (>= ephemeral)
	expected := map[int]bool{
		3000: true,
		8080: true,
	}

	found := make(map[int]bool)
	for _, p := range ports {
		found[p] = true
	}

	for port := range expected {
		if !found[port] {
			t.Errorf("expected port %d to be detected, but it wasn't", port)
		}
	}

	// Should NOT include well-known port 22 (below minPort 1024)
	if found[22] {
		t.Error("port 22 (below minPort 1024) should not be included")
	}
	// Should NOT include ESTABLISHED
	if found[80] {
		t.Error("port 80 (ESTABLISHED) should not be included")
	}
	// Should NOT include ephemeral
	if found[32768] {
		t.Error("port 32768 (ephemeral range) should not be included")
	}
}

func TestParseProcNetTCP_WellKnownPortsAllowed(t *testing.T) {
	// When minPort is 1, well-known ports should be included
	ports := parseProcNetTCP(testProcNetTCP, 32768, 1, 65535)

	found := make(map[int]bool)
	for _, p := range ports {
		found[p] = true
	}

	if !found[22] {
		t.Error("port 22 should be included when minPort=1")
	}
	if !found[3000] {
		t.Error("port 3000 should be included")
	}
}

func TestParseProcNetTCP_CustomMaxPort(t *testing.T) {
	// Restrict max port to 5000
	ports := parseProcNetTCP(testProcNetTCP, 32768, 1024, 5000)

	found := make(map[int]bool)
	for _, p := range ports {
		found[p] = true
	}

	if !found[3000] {
		t.Error("port 3000 should be included (within range)")
	}
	if found[8080] {
		t.Error("port 8080 should be excluded (above maxPort 5000)")
	}
}

func TestParseProcNetTCP_Empty(t *testing.T) {
	ports := parseProcNetTCP("", 32768, 1024, 65535)
	if len(ports) != 0 {
		t.Errorf("expected 0 ports for empty input, got %d", len(ports))
	}
}

func TestParseProcNetTCP_HeaderOnly(t *testing.T) {
	ports := parseProcNetTCP("  sl  local_address rem_address   st tx_queue rx_queue\n", 32768, 1024, 65535)
	if len(ports) != 0 {
		t.Errorf("expected 0 ports for header-only input, got %d", len(ports))
	}
}

func TestParseProcNetTCP_NoDuplicates(t *testing.T) {
	data := `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 27894 1 0000000000000000 100 0 0 10 0
   1: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 27895 1 0000000000000000 100 0 0 10 0`

	ports := parseProcNetTCP(data, 32768, 1024, 65535)
	if len(ports) != 1 {
		t.Errorf("expected 1 unique port, got %d: %v", len(ports), ports)
	}
	if ports[0] != 3000 {
		t.Errorf("expected port 3000, got %d", ports[0])
	}
}

func TestValidHostnameRe(t *testing.T) {
	tests := []struct {
		hostname string
		valid    bool
	}{
		{"devcontainer-ws-1", true},
		{"my.container_name", true},
		{"abc123", true},
		{"", false},
		{"-invalid", false},
		{"injection; rm -rf /", false},
		{"$(curl evil.com)", false},
	}
	for _, tt := range tests {
		got := validHostnameRe.MatchString(tt.hostname)
		if got != tt.valid {
			t.Errorf("validHostnameRe(%q) = %v, want %v", tt.hostname, got, tt.valid)
		}
	}
}

// socatTestConfig returns a config suitable for socat tests.
func socatTestConfig() *config.Config {
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

func TestSyncForwardersFromPorts_AddsNew(t *testing.T) {
	docker := newMockDocker()
	mgr := NewManager(socatTestConfig(), docker)

	// Pre-populate a running sidecar with no forwarders
	mgr.sidecars["ws-1"] = &SidecarState{
		Status:        StatusRunning,
		ContainerName: "neko-ws-1",
		TargetHost:    "devcontainer-ws-1",
		Forwarders:    nil,
	}

	// Sync with ports 3000 and 8080
	mgr.SyncForwardersFromPorts(context.Background(), "ws-1", []int{3000, 8080})

	state := mgr.sidecars["ws-1"]
	if len(state.Forwarders) != 2 {
		t.Fatalf("expected 2 forwarders, got %d", len(state.Forwarders))
	}

	ports := make(map[int]bool)
	for _, f := range state.Forwarders {
		ports[f.Port] = true
		if !f.Active {
			t.Errorf("forwarder for port %d should be active", f.Port)
		}
	}
	if !ports[3000] || !ports[8080] {
		t.Errorf("expected ports 3000 and 8080, got %v", ports)
	}

	// Verify docker exec commands were issued for socat
	found := 0
	for _, cmd := range docker.getCalls() {
		if strings.Contains(cmd, "socat TCP-LISTEN:3000") || strings.Contains(cmd, "socat TCP-LISTEN:8080") {
			found++
		}
	}
	if found != 2 {
		t.Errorf("expected 2 socat exec commands, found %d in %v", found, docker.getCalls())
	}
}

func TestSyncForwardersFromPorts_RemovesOld(t *testing.T) {
	docker := newMockDocker()
	mgr := NewManager(socatTestConfig(), docker)

	// Pre-populate with existing forwarder on port 3000
	mgr.sidecars["ws-1"] = &SidecarState{
		Status:        StatusRunning,
		ContainerName: "neko-ws-1",
		TargetHost:    "devcontainer-ws-1",
		Forwarders: []PortForwarder{
			{Port: 3000, TargetHost: "devcontainer-ws-1", Active: true},
		},
	}

	// Sync with empty ports — should remove port 3000
	mgr.SyncForwardersFromPorts(context.Background(), "ws-1", []int{})

	state := mgr.sidecars["ws-1"]
	if len(state.Forwarders) != 0 {
		t.Fatalf("expected 0 forwarders after removal, got %d", len(state.Forwarders))
	}

	// Verify pkill command was issued
	found := false
	for _, cmd := range docker.getCalls() {
		if strings.Contains(cmd, "pkill") && strings.Contains(cmd, "3000,") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected pkill command for port 3000, commands: %v", docker.getCalls())
	}
}

func TestSyncForwardersFromPorts_StoppedWorkspaceIsNoop(t *testing.T) {
	docker := newMockDocker()
	mgr := NewManager(socatTestConfig(), docker)

	// No sidecar for ws-1 (workspace not running)
	mgr.SyncForwardersFromPorts(context.Background(), "ws-1", []int{3000})

	if len(docker.getCalls()) != 0 {
		t.Errorf("expected no docker commands for stopped workspace, got %v", docker.getCalls())
	}
}

func TestSyncForwardersFromPorts_NonRunningIsNoop(t *testing.T) {
	docker := newMockDocker()
	mgr := NewManager(socatTestConfig(), docker)

	// Sidecar exists but is in StatusStopping — sync should be a no-op
	mgr.sidecars["ws-1"] = &SidecarState{
		Status:        StatusStopping,
		ContainerName: "neko-ws-1",
		TargetHost:    "devcontainer-ws-1",
	}

	mgr.SyncForwardersFromPorts(context.Background(), "ws-1", []int{3000})

	if len(docker.getCalls()) != 0 {
		t.Errorf("expected no docker commands for non-running sidecar, got %v", docker.getCalls())
	}
	if len(mgr.sidecars["ws-1"].Forwarders) != 0 {
		t.Error("expected no forwarders added to non-running sidecar")
	}
}

func TestAddForwarder_RejectsInvalidHostname(t *testing.T) {
	docker := newMockDocker()
	mgr := NewManager(socatTestConfig(), docker)

	err := mgr.addForwarder(context.Background(), "neko-ws-1", 3000, "injection; rm -rf /")
	if err == nil {
		t.Fatal("expected error for invalid hostname")
	}
	if !strings.Contains(err.Error(), "invalid target host") {
		t.Errorf("expected 'invalid target host' error, got: %v", err)
	}

	// No docker commands should have been issued
	if len(docker.getCalls()) != 0 {
		t.Errorf("expected no docker commands for rejected hostname, got %v", docker.getCalls())
	}
}

func TestAddForwarder_SocatCommand(t *testing.T) {
	docker := newMockDocker()
	mgr := NewManager(socatTestConfig(), docker)

	err := mgr.addForwarder(context.Background(), "neko-ws-1", 3000, "devcontainer-ws-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(docker.getCalls()) != 1 {
		t.Fatalf("expected 1 docker command, got %d", len(docker.getCalls()))
	}
	cmd := docker.getCalls()[0]
	if !strings.Contains(cmd, "exec -d neko-ws-1") {
		t.Errorf("expected exec -d neko-ws-1, got: %s", cmd)
	}
	if !strings.Contains(cmd, "socat TCP-LISTEN:3000,fork,reuseaddr TCP:devcontainer-ws-1:3000") {
		t.Errorf("expected socat command with correct port, got: %s", cmd)
	}
	// Verify no shell wrapper — socat args passed directly to docker exec.
	if strings.Contains(cmd, "sh -c") {
		t.Errorf("socat should be invoked directly without sh -c, got: %s", cmd)
	}
}

func TestRemoveForwarder_PkillCommand(t *testing.T) {
	docker := newMockDocker()
	mgr := NewManager(socatTestConfig(), docker)

	err := mgr.removeForwarder(context.Background(), "neko-ws-1", 3000)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(docker.getCalls()) != 1 {
		t.Fatalf("expected 1 docker command, got %d", len(docker.getCalls()))
	}
	cmd := docker.getCalls()[0]
	// Verify pkill is called directly (no shell wrapper) with comma-anchored port
	expected := "exec neko-ws-1 pkill -f socat TCP-LISTEN:3000,"
	if cmd != expected {
		t.Errorf("expected pkill without shell wrapper:\n  want: %s\n  got:  %s", expected, cmd)
	}
}

func TestAddForwarder_RejectsPrivilegedPorts(t *testing.T) {
	testCases := []struct {
		port    int
		wantErr bool
	}{
		{0, true},
		{22, true},
		{80, true},
		{443, true},
		{1023, true},
		{1024, false},
		{3000, false},
		{8080, false},
		{65535, false},
		{65536, true},
	}

	for _, tc := range testCases {
		docker := newMockDocker()
		mgr := NewManager(socatTestConfig(), docker)
		err := mgr.addForwarder(context.Background(), "neko-ws-1", tc.port, "devcontainer-ws-1")
		if tc.wantErr && err == nil {
			t.Errorf("port %d: expected error for privileged/invalid port", tc.port)
		}
		if !tc.wantErr && err != nil {
			t.Errorf("port %d: unexpected error: %v", tc.port, err)
		}
	}
}

func TestDetectContainerPorts_IPv6Merge(t *testing.T) {
	docker := newMockDocker()
	mgr := NewManager(socatTestConfig(), docker)

	// IPv4 has port 3000
	ipv4Data := `  sl  local_address rem_address   st
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 27894 1 0000000000000000 100 0 0 10 0`
	docker.outputs["exec devcontainer-ws-1 cat /proc/net/tcp"] = ipv4Data

	// IPv6 has port 3000 (duplicate) and port 9090 (new)
	// Note: port 8080 would be excluded by Neko port filter; use 9090 (0x2382) instead
	ipv6Data := `  sl  local_address rem_address   st
   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 27894 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:2382 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 27895 1 0000000000000000 100 0 0 10 0`
	docker.outputs["exec devcontainer-ws-1 cat /proc/net/tcp6"] = ipv6Data

	ports, err := mgr.detectContainerPorts(context.Background(), "devcontainer-ws-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	portSet := make(map[int]bool)
	for _, p := range ports {
		portSet[p] = true
	}

	if !portSet[3000] {
		t.Error("expected port 3000")
	}
	if !portSet[9090] {
		t.Error("expected port 9090")
	}
	if len(ports) != 2 {
		t.Errorf("expected 2 unique ports (deduped), got %d: %v", len(ports), ports)
	}
}
