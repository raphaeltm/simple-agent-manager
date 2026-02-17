package sysinfo

import (
	"fmt"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestParseLoadAvg(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want1   float64
		want5   float64
		want15  float64
		wantCPU bool // just check > 0
	}{
		{
			name:   "typical loadavg",
			input:  "1.23 0.45 0.67 2/345 12345\n",
			want1:  1.23,
			want5:  0.45,
			want15: 0.67,
		},
		{
			name:   "high load",
			input:  "12.50 8.30 4.10 5/600 99999",
			want1:  12.50,
			want5:  8.30,
			want15: 4.10,
		},
		{
			name:  "empty input",
			input: "",
			want1: 0, want5: 0, want15: 0,
		},
		{
			name:  "single field",
			input: "2.5",
			want1: 2.5, want5: 0, want15: 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info := ParseLoadAvg(tt.input)
			if info.LoadAvg1 != tt.want1 {
				t.Errorf("LoadAvg1 = %f, want %f", info.LoadAvg1, tt.want1)
			}
			if info.LoadAvg5 != tt.want5 {
				t.Errorf("LoadAvg5 = %f, want %f", info.LoadAvg5, tt.want5)
			}
			if info.LoadAvg15 != tt.want15 {
				t.Errorf("LoadAvg15 = %f, want %f", info.LoadAvg15, tt.want15)
			}
			if info.NumCPU <= 0 {
				t.Errorf("NumCPU = %d, want > 0", info.NumCPU)
			}
		})
	}
}

func TestParseMemInfo(t *testing.T) {
	tests := []struct {
		name          string
		input         string
		wantTotal     uint64
		wantUsed      uint64
		wantAvailable uint64
		wantPercent   float64
	}{
		{
			name: "typical meminfo with MemAvailable",
			input: `MemTotal:        8000000 kB
MemFree:         2000000 kB
MemAvailable:    5000000 kB
Buffers:          500000 kB
Cached:          1500000 kB
SwapTotal:       4000000 kB
SwapFree:        4000000 kB
`,
			wantTotal:     8000000 * 1024,
			wantUsed:      3000000 * 1024,
			wantAvailable: 5000000 * 1024,
			wantPercent:   37.5,
		},
		{
			name: "meminfo without MemAvailable (fallback to Free+Buffers+Cached)",
			input: `MemTotal:        4000000 kB
MemFree:         1000000 kB
Buffers:          200000 kB
Cached:           800000 kB
`,
			wantTotal:     4000000 * 1024,
			wantUsed:      2000000 * 1024,
			wantAvailable: 2000000 * 1024,
			wantPercent:   50.0,
		},
		{
			name:  "empty input",
			input: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info := ParseMemInfo(tt.input)
			if info.TotalBytes != tt.wantTotal {
				t.Errorf("TotalBytes = %d, want %d", info.TotalBytes, tt.wantTotal)
			}
			if info.UsedBytes != tt.wantUsed {
				t.Errorf("UsedBytes = %d, want %d", info.UsedBytes, tt.wantUsed)
			}
			if info.AvailableBytes != tt.wantAvailable {
				t.Errorf("AvailableBytes = %d, want %d", info.AvailableBytes, tt.wantAvailable)
			}
			if info.UsedPercent != tt.wantPercent {
				t.Errorf("UsedPercent = %f, want %f", info.UsedPercent, tt.wantPercent)
			}
		})
	}
}

func TestParseNetDev(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		wantIface string
		wantRx    uint64
		wantTx    uint64
	}{
		{
			name: "typical /proc/net/dev",
			input: `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:   12345      67    0    0    0     0          0         0    12345      67    0    0    0     0       0          0
  eth0: 9876543   54321    0    0    0     0          0         0  1234567   12345    0    0    0     0       0          0
`,
			wantIface: "eth0",
			wantRx:    9876543,
			wantTx:    1234567,
		},
		{
			name: "ens3 interface (Hetzner VMs use this)",
			input: `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0
  ens3: 5000000    1000    0    0    0     0          0         0  2000000     500    0    0    0     0       0          0
`,
			wantIface: "ens3",
			wantRx:    5000000,
			wantTx:    2000000,
		},
		{
			name:  "empty input",
			input: "",
		},
		{
			name: "only loopback",
			input: `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0
`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info := ParseNetDev(tt.input)
			if info.Interface != tt.wantIface {
				t.Errorf("Interface = %q, want %q", info.Interface, tt.wantIface)
			}
			if info.RxBytes != tt.wantRx {
				t.Errorf("RxBytes = %d, want %d", info.RxBytes, tt.wantRx)
			}
			if info.TxBytes != tt.wantTx {
				t.Errorf("TxBytes = %d, want %d", info.TxBytes, tt.wantTx)
			}
		})
	}
}

func TestParseUptime(t *testing.T) {
	tests := []struct {
		name        string
		input       string
		wantSeconds float64
		wantHuman   string
	}{
		{
			name:        "2 days 5 hours 32 minutes",
			input:       "192720.50 380000.00\n",
			wantSeconds: 192720.50,
			wantHuman:   "2d 5h 32m",
		},
		{
			name:        "5 hours 10 minutes",
			input:       "18600.00 37000.00",
			wantSeconds: 18600.00,
			wantHuman:   "5h 10m",
		},
		{
			name:        "just minutes",
			input:       "300.00 600.00",
			wantSeconds: 300.00,
			wantHuman:   "5m",
		},
		{
			name:  "empty input",
			input: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info := ParseUptime(tt.input)
			if info.Seconds != tt.wantSeconds {
				t.Errorf("Seconds = %f, want %f", info.Seconds, tt.wantSeconds)
			}
			if info.HumanFormat != tt.wantHuman {
				t.Errorf("HumanFormat = %q, want %q", info.HumanFormat, tt.wantHuman)
			}
		})
	}
}

func TestStatFSToDiskInfo(t *testing.T) {
	stat := &syscall.Statfs_t{
		Bsize:  4096,
		Blocks: 10000,
		Bfree:  6000,
		Bavail: 5500,
	}

	info := StatFSToDiskInfo(stat, "/")

	wantTotal := uint64(10000 * 4096)
	wantUsed := wantTotal - uint64(6000*4096)
	wantAvail := uint64(5500 * 4096)

	if info.TotalBytes != wantTotal {
		t.Errorf("TotalBytes = %d, want %d", info.TotalBytes, wantTotal)
	}
	if info.UsedBytes != wantUsed {
		t.Errorf("UsedBytes = %d, want %d", info.UsedBytes, wantUsed)
	}
	if info.AvailableBytes != wantAvail {
		t.Errorf("AvailableBytes = %d, want %d", info.AvailableBytes, wantAvail)
	}
	if info.MountPath != "/" {
		t.Errorf("MountPath = %q, want %q", info.MountPath, "/")
	}
	// 40% used
	if info.UsedPercent != 40.0 {
		t.Errorf("UsedPercent = %f, want 40.0", info.UsedPercent)
	}
}

func TestFormatUptime(t *testing.T) {
	tests := []struct {
		seconds float64
		want    string
	}{
		{0, "0m"},
		{59, "0m"},
		{60, "1m"},
		{3661, "1h 1m"},
		{86400, "1d 0h 0m"},
		{192720.5, "2d 5h 32m"},
	}

	for _, tt := range tests {
		t.Run(fmt.Sprintf("%.0f", tt.seconds), func(t *testing.T) {
			got := formatUptime(tt.seconds)
			if got != tt.want {
				t.Errorf("formatUptime(%f) = %q, want %q", tt.seconds, got, tt.want)
			}
		})
	}
}

func TestParsePercentString(t *testing.T) {
	tests := []struct {
		input string
		want  float64
	}{
		{"52.3%", 52.3},
		{"0.00%", 0},
		{"100%", 100},
		{"", 0},
		{"  1.5%  ", 1.5},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := parsePercentString(tt.input)
			if got != tt.want {
				t.Errorf("parsePercentString(%q) = %f, want %f", tt.input, got, tt.want)
			}
		})
	}
}

func TestCollectorCacheTTL(t *testing.T) {
	callCount := 0
	c := NewCollector(CollectorConfig{
		CacheTTL: 50 * time.Millisecond,
	})
	c.readFile = func(path string) (string, error) {
		callCount++
		switch path {
		case "/proc/loadavg":
			return "1.0 0.5 0.3 1/100 1234", nil
		case "/proc/meminfo":
			return "MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\n", nil
		default:
			return "", fmt.Errorf("not found: %s", path)
		}
	}
	c.statFS = func(path string) (*syscall.Statfs_t, error) {
		return &syscall.Statfs_t{Bsize: 4096, Blocks: 10000, Bfree: 5000, Bavail: 4500}, nil
	}

	// First call should read files
	_, err := c.CollectQuick()
	if err != nil {
		t.Fatalf("CollectQuick() error = %v", err)
	}
	firstCount := callCount

	// Immediate second call should use cache
	_, err = c.CollectQuick()
	if err != nil {
		t.Fatalf("CollectQuick() error = %v", err)
	}
	if callCount != firstCount {
		t.Errorf("Expected cached result, but readFile was called %d more times", callCount-firstCount)
	}

	// Wait for cache to expire
	time.Sleep(60 * time.Millisecond)

	// Third call should read files again
	_, err = c.CollectQuick()
	if err != nil {
		t.Fatalf("CollectQuick() error = %v", err)
	}
	if callCount <= firstCount {
		t.Errorf("Expected cache miss after TTL, but readFile was not called")
	}
}

func TestCollectorConcurrency(t *testing.T) {
	c := NewCollector(CollectorConfig{
		CacheTTL: 10 * time.Millisecond,
	})
	c.readFile = func(path string) (string, error) {
		switch path {
		case "/proc/loadavg":
			return "1.0 0.5 0.3 1/100 1234", nil
		case "/proc/meminfo":
			return "MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\n", nil
		default:
			return "", nil
		}
	}
	c.statFS = func(path string) (*syscall.Statfs_t, error) {
		return &syscall.Statfs_t{Bsize: 4096, Blocks: 10000, Bfree: 5000, Bavail: 4500}, nil
	}

	var wg sync.WaitGroup
	errs := make(chan error, 50)

	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := c.CollectQuick()
			if err != nil {
				errs <- err
			}
		}()
	}

	wg.Wait()
	close(errs)

	for err := range errs {
		t.Errorf("concurrent CollectQuick() error: %v", err)
	}
}

func TestBuildTimeVariables(t *testing.T) {
	// Verify that build-time variables have their default values in tests
	if Version != "dev" {
		t.Logf("Version = %q (injected at build time)", Version)
	}
	if BuildDate != "unknown" {
		t.Logf("BuildDate = %q (injected at build time)", BuildDate)
	}
}
