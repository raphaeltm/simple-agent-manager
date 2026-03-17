package ports

import (
	"testing"
)

// Realistic /proc/net/tcp content from a Linux container running multiple services.
const realisticProcNetTCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 27894 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 27895 1 0000000000000000 100 0 0 10 0
   2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0
   3: 0100007F:2105 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 28001 1 0000000000000000 100 0 0 10 0
   4: 0187A8C0:0050 0287A8C0:C350 01 00000000:00000000 02:000000D7 00000000  1000        0 28456 2 0000000000000000 20 4 30 10 -1
   5: 00000000:20FB 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 28457 1 0000000000000000 100 0 0 10 0
   6: 00000000:0945 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 28458 1 0000000000000000 100 0 0 10 0
   7: 00000000:8000 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 28459 1 0000000000000000 100 0 0 10 0`

func TestParseProcNetTCP(t *testing.T) {
	entries, err := ParseProcNetTCP(realisticProcNetTCP)
	if err != nil {
		t.Fatalf("ParseProcNetTCP error: %v", err)
	}

	// We should have 8 entries
	if len(entries) != 8 {
		t.Fatalf("expected 8 entries, got %d", len(entries))
	}

	// Verify specific entries
	tests := []struct {
		idx     int
		addr    string
		port    int
		state   int
	}{
		{0, "0.0.0.0", 3000, StateListen},      // 0x0BB8 = 3000
		{1, "127.0.0.1", 8080, StateListen},     // 0x1F90 = 8080, 0100007F = 127.0.0.1
		{2, "0.0.0.0", 22, StateListen},          // 0x0016 = 22
		{3, "127.0.0.1", 8453, StateListen},      // 0x2105 = 8453
		{4, "192.168.135.1", 80, 1},              // ESTABLISHED (state 01)
		{5, "0.0.0.0", 8443, StateListen},        // 0x20FB = 8443
		{6, "0.0.0.0", 2373, StateListen},        // 0x0945 = 2373
		{7, "0.0.0.0", 32768, StateListen},       // 0x8000 = 32768 (ephemeral)
	}

	for _, tt := range tests {
		e := entries[tt.idx]
		if e.LocalAddress != tt.addr {
			t.Errorf("entry[%d] address: got %q, want %q", tt.idx, e.LocalAddress, tt.addr)
		}
		if e.LocalPort != tt.port {
			t.Errorf("entry[%d] port: got %d, want %d", tt.idx, e.LocalPort, tt.port)
		}
		if e.State != tt.state {
			t.Errorf("entry[%d] state: got %d, want %d", tt.idx, e.State, tt.state)
		}
	}
}

func TestParseProcNetTCP_Empty(t *testing.T) {
	entries, err := ParseProcNetTCP("")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("expected 0 entries, got %d", len(entries))
	}
}

func TestParseProcNetTCP_HeaderOnly(t *testing.T) {
	entries, err := ParseProcNetTCP("  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("expected 0 entries, got %d", len(entries))
	}
}

func TestFilterListening(t *testing.T) {
	entries, err := ParseProcNetTCP(realisticProcNetTCP)
	if err != nil {
		t.Fatalf("ParseProcNetTCP error: %v", err)
	}

	excludePorts := map[int]bool{
		22:   true,
		2375: true,
		2376: true,
		8443: true,
	}
	ephemeralMin := 32768

	filtered := FilterListening(entries, excludePorts, ephemeralMin)

	// Should include: 3000, 8080, 8453, 2373
	// Should exclude: 22 (excluded), 8443 (excluded), 32768 (ephemeral), 80 (ESTABLISHED)
	if len(filtered) != 4 {
		t.Fatalf("expected 4 filtered entries, got %d", len(filtered))
	}

	expectedPorts := map[int]bool{3000: true, 8080: true, 8453: true, 2373: true}
	for _, e := range filtered {
		if !expectedPorts[e.LocalPort] {
			t.Errorf("unexpected port in filtered results: %d", e.LocalPort)
		}
	}
}

func TestFilterListening_NoExclusions(t *testing.T) {
	entries, err := ParseProcNetTCP(realisticProcNetTCP)
	if err != nil {
		t.Fatalf("ParseProcNetTCP error: %v", err)
	}

	filtered := FilterListening(entries, nil, 0)

	// Should include all LISTEN entries: 3000, 8080, 22, 8453, 8443, 2373, 32768
	if len(filtered) != 7 {
		t.Fatalf("expected 7 entries, got %d", len(filtered))
	}
}

func TestHexToIPv4(t *testing.T) {
	tests := []struct {
		hex  string
		want string
	}{
		{"00000000", "0.0.0.0"},
		{"0100007F", "127.0.0.1"},
		{"0187A8C0", "192.168.135.1"},
	}

	for _, tt := range tests {
		got, err := hexToIPv4(tt.hex)
		if err != nil {
			t.Errorf("hexToIPv4(%q): unexpected error: %v", tt.hex, err)
			continue
		}
		if got != tt.want {
			t.Errorf("hexToIPv4(%q) = %q, want %q", tt.hex, got, tt.want)
		}
	}
}

func TestHexToIPv6(t *testing.T) {
	tests := []struct {
		hex  string
		want string
	}{
		// :: (all zeros)
		{"00000000000000000000000000000000", "::"},
		// ::1 (loopback) — stored as 00000000 00000000 00000000 01000000 in /proc/net/tcp6
		{"00000000000000000000000001000000", "::1"},
	}

	for _, tt := range tests {
		got, err := hexToIPv6(tt.hex)
		if err != nil {
			t.Errorf("hexToIPv6(%q): unexpected error: %v", tt.hex, err)
			continue
		}
		if got != tt.want {
			t.Errorf("hexToIPv6(%q) = %q, want %q", tt.hex, got, tt.want)
		}
	}
}

// Realistic /proc/net/tcp6 content — Node.js servers default to IPv6 dual-stack.
const realisticProcNetTCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 30001 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 30002 1 0000000000000000 100 0 0 10 0`

func TestParseProcNetTCP6(t *testing.T) {
	entries, err := ParseProcNetTCP(realisticProcNetTCP6)
	if err != nil {
		t.Fatalf("ParseProcNetTCP error for tcp6 content: %v", err)
	}

	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}

	// Entry 0: :: listening on port 3000
	if entries[0].LocalAddress != "::" {
		t.Errorf("entry[0] address: got %q, want %q", entries[0].LocalAddress, "::")
	}
	if entries[0].LocalPort != 3000 {
		t.Errorf("entry[0] port: got %d, want %d", entries[0].LocalPort, 3000)
	}
	if entries[0].State != StateListen {
		t.Errorf("entry[0] state: got %d, want %d", entries[0].State, StateListen)
	}

	// Entry 1: ::1 listening on port 8080
	if entries[1].LocalAddress != "::1" {
		t.Errorf("entry[1] address: got %q, want %q", entries[1].LocalAddress, "::1")
	}
	if entries[1].LocalPort != 8080 {
		t.Errorf("entry[1] port: got %d, want %d", entries[1].LocalPort, 8080)
	}
}

func TestParseSSOutput(t *testing.T) {
	// Realistic ss -tlnH output from a devcontainer with multiple services
	ssOutput := `LISTEN 0      511          0.0.0.0:3003       0.0.0.0:*
LISTEN 0      128          0.0.0.0:22         0.0.0.0:*
LISTEN 0      511             [::]:3003          [::]:*
LISTEN 0      128             [::]:22            [::]:*
LISTEN 0      128                *:8080             *:*`

	entries, err := ParseSSOutput(ssOutput)
	if err != nil {
		t.Fatalf("ParseSSOutput error: %v", err)
	}

	if len(entries) != 5 {
		t.Fatalf("expected 5 entries, got %d", len(entries))
	}

	tests := []struct {
		idx  int
		addr string
		port int
	}{
		{0, "0.0.0.0", 3003},
		{1, "0.0.0.0", 22},
		{2, "::", 3003},
		{3, "::", 22},
		{4, "0.0.0.0", 8080}, // *:port → 0.0.0.0
	}

	for _, tt := range tests {
		e := entries[tt.idx]
		if e.LocalAddress != tt.addr {
			t.Errorf("entry[%d] address: got %q, want %q", tt.idx, e.LocalAddress, tt.addr)
		}
		if e.LocalPort != tt.port {
			t.Errorf("entry[%d] port: got %d, want %d", tt.idx, e.LocalPort, tt.port)
		}
		if e.State != StateListen {
			t.Errorf("entry[%d] state: got %d, want %d", tt.idx, e.State, StateListen)
		}
	}
}

func TestParseSSOutput_Empty(t *testing.T) {
	entries, err := ParseSSOutput("")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("expected 0 entries, got %d", len(entries))
	}
}

func TestParseSSOutput_WithFilter(t *testing.T) {
	ssOutput := `LISTEN 0      511          0.0.0.0:3003       0.0.0.0:*
LISTEN 0      128          0.0.0.0:22         0.0.0.0:*
LISTEN 0      128          0.0.0.0:8443       0.0.0.0:*`

	entries, err := ParseSSOutput(ssOutput)
	if err != nil {
		t.Fatalf("ParseSSOutput error: %v", err)
	}

	excludePorts := map[int]bool{22: true, 8443: true}
	filtered := FilterListening(entries, excludePorts, DefaultEphemeralMin)

	if len(filtered) != 1 {
		t.Fatalf("expected 1 filtered entry, got %d", len(filtered))
	}
	if filtered[0].LocalPort != 3003 {
		t.Errorf("expected port 3003, got %d", filtered[0].LocalPort)
	}
}

func TestParseProcNetTCP_CombinedIPv4AndIPv6(t *testing.T) {
	// Simulate what readProcNetTCP produces: IPv4 content + IPv6 content (without header).
	combined := realisticProcNetTCP + "\n" +
		"   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 30001 1 0000000000000000 100 0 0 10 0\n"

	entries, err := ParseProcNetTCP(combined)
	if err != nil {
		t.Fatalf("ParseProcNetTCP error: %v", err)
	}

	// 8 IPv4 entries + 1 IPv6 entry
	if len(entries) != 9 {
		t.Fatalf("expected 9 entries, got %d", len(entries))
	}

	// Last entry should be the IPv6 one
	last := entries[8]
	if last.LocalAddress != "::" {
		t.Errorf("last entry address: got %q, want %q", last.LocalAddress, "::")
	}
	if last.LocalPort != 3000 {
		t.Errorf("last entry port: got %d, want %d", last.LocalPort, 3000)
	}
}
