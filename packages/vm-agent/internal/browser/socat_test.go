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
	ports := parseProcNetTCP(testProcNetTCP, 32768)

	// Should find listening ports: 3000 (0x0BB8), 8080 (0x1F90), 22 (0x0016)
	// Should exclude: ESTABLISHED connection (state 01), port 32768 (0x8000, >= ephemeral threshold)
	expected := map[int]bool{
		3000: true,
		8080: true,
		22:   true,
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

	// Should NOT include ESTABLISHED or ephemeral
	if found[80] {
		t.Error("port 80 (ESTABLISHED) should not be included")
	}
	if found[32768] {
		t.Error("port 32768 (ephemeral range) should not be included")
	}
}

func TestParseProcNetTCP_Empty(t *testing.T) {
	ports := parseProcNetTCP("", 32768)
	if len(ports) != 0 {
		t.Errorf("expected 0 ports for empty input, got %d", len(ports))
	}
}

func TestParseProcNetTCP_HeaderOnly(t *testing.T) {
	ports := parseProcNetTCP("  sl  local_address rem_address   st tx_queue rx_queue\n", 32768)
	if len(ports) != 0 {
		t.Errorf("expected 0 ports for header-only input, got %d", len(ports))
	}
}

func TestParseProcNetTCP_NoDuplicates(t *testing.T) {
	data := `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 27894 1 0000000000000000 100 0 0 10 0
   1: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 27895 1 0000000000000000 100 0 0 10 0`

	ports := parseProcNetTCP(data, 32768)
	if len(ports) != 1 {
		t.Errorf("expected 1 unique port, got %d: %v", len(ports), ports)
	}
	if ports[0] != 3000 {
		t.Errorf("expected port 3000, got %d", ports[0])
	}
}
