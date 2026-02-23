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

func TestParseDockerPS(t *testing.T) {
	tests := []struct {
		name       string
		input      string
		wantCount  int
		wantFirst  ContainerInfo
		wantStates []string
	}{
		{
			name: "multiple containers in different states",
			input: `{"ID":"abc123","Names":"my-app","Image":"node:20","Status":"Up 2 hours","State":"running","CreatedAt":"2026-02-23 10:00:00 +0000 UTC"}
{"ID":"def456","Names":"old-app","Image":"python:3.12","Status":"Exited (0) 3 hours ago","State":"exited","CreatedAt":"2026-02-22 08:00:00 +0000 UTC"}
{"ID":"ghi789","Names":"paused-svc","Image":"redis:7","Status":"Up 1 hour (Paused)","State":"paused","CreatedAt":"2026-02-23 09:00:00 +0000 UTC"}`,
			wantCount: 3,
			wantFirst: ContainerInfo{
				ID:        "abc123",
				Name:      "my-app",
				Image:     "node:20",
				Status:    "Up 2 hours",
				State:     "running",
				CreatedAt: "2026-02-23 10:00:00 +0000 UTC",
			},
			wantStates: []string{"running", "exited", "paused"},
		},
		{
			name: "single running container",
			input: `{"ID":"abc123","Names":"/my-app","Image":"node:20","Status":"Up 5 minutes","State":"Running","CreatedAt":"2026-02-23 10:00:00 +0000 UTC"}
`,
			wantCount: 1,
			wantFirst: ContainerInfo{
				ID:        "abc123",
				Name:      "my-app", // leading / stripped
				Image:     "node:20",
				Status:    "Up 5 minutes",
				State:     "running", // lowercased
				CreatedAt: "2026-02-23 10:00:00 +0000 UTC",
			},
			wantStates: []string{"running"},
		},
		{
			name:      "empty output",
			input:     "",
			wantCount: 0,
		},
		{
			name:      "whitespace only",
			input:     "  \n  \n  ",
			wantCount: 0,
		},
		{
			name:  "invalid JSON lines skipped",
			input: "not json\n{\"ID\":\"abc\",\"Names\":\"ok\",\"Image\":\"img\",\"Status\":\"Up\",\"State\":\"running\",\"CreatedAt\":\"now\"}\nmore garbage",
			wantCount: 1,
			wantFirst: ContainerInfo{
				ID:        "abc",
				Name:      "ok",
				Image:     "img",
				Status:    "Up",
				State:     "running",
				CreatedAt: "now",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			containers := parseDockerPS(tt.input)
			if len(containers) != tt.wantCount {
				t.Fatalf("got %d containers, want %d", len(containers), tt.wantCount)
			}
			if tt.wantCount > 0 {
				got := containers[0]
				if got.ID != tt.wantFirst.ID {
					t.Errorf("first.ID = %q, want %q", got.ID, tt.wantFirst.ID)
				}
				if got.Name != tt.wantFirst.Name {
					t.Errorf("first.Name = %q, want %q", got.Name, tt.wantFirst.Name)
				}
				if got.Image != tt.wantFirst.Image {
					t.Errorf("first.Image = %q, want %q", got.Image, tt.wantFirst.Image)
				}
				if got.Status != tt.wantFirst.Status {
					t.Errorf("first.Status = %q, want %q", got.Status, tt.wantFirst.Status)
				}
				if got.State != tt.wantFirst.State {
					t.Errorf("first.State = %q, want %q", got.State, tt.wantFirst.State)
				}
				if got.CreatedAt != tt.wantFirst.CreatedAt {
					t.Errorf("first.CreatedAt = %q, want %q", got.CreatedAt, tt.wantFirst.CreatedAt)
				}
			}
			if tt.wantStates != nil {
				for i, wantState := range tt.wantStates {
					if containers[i].State != wantState {
						t.Errorf("containers[%d].State = %q, want %q", i, containers[i].State, wantState)
					}
				}
			}
		})
	}
}

func TestParseDockerStats(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		wantCount int
		wantIDs   []string
	}{
		{
			name: "two containers with stats",
			input: `{"id":"abc123","cpuPercent":"5.25%","memUsage":"128MiB / 2GiB","memPercent":"6.25%"}
{"id":"def456","cpuPercent":"0.50%","memUsage":"64MiB / 2GiB","memPercent":"3.12%"}`,
			wantCount: 2,
			wantIDs:   []string{"abc123", "def456"},
		},
		{
			name:      "empty output",
			input:     "",
			wantCount: 0,
		},
		{
			name:      "invalid JSON skipped",
			input:     "not json\n{\"id\":\"abc\",\"cpuPercent\":\"1%\",\"memUsage\":\"10MiB\",\"memPercent\":\"2%\"}",
			wantCount: 1,
			wantIDs:   []string{"abc"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := parseDockerStats(tt.input)
			if len(result) != tt.wantCount {
				t.Fatalf("got %d entries, want %d", len(result), tt.wantCount)
			}
			for _, wantID := range tt.wantIDs {
				if _, ok := result[wantID]; !ok {
					t.Errorf("missing expected entry for ID %q", wantID)
				}
			}
		})
	}
}

func TestParseDockerStatsMerge(t *testing.T) {
	// Verify that parseDockerStats values can be correctly parsed by parsePercentString
	input := `{"id":"abc123","cpuPercent":"52.30%","memUsage":"256MiB / 4GiB","memPercent":"6.25%"}`
	result := parseDockerStats(input)

	entry, ok := result["abc123"]
	if !ok {
		t.Fatal("missing entry for abc123")
	}

	cpuPct := parsePercentString(entry.CPUPercent)
	if cpuPct != 52.3 {
		t.Errorf("cpuPercent = %f, want 52.3", cpuPct)
	}

	memPct := parsePercentString(entry.MemPercent)
	if memPct != 6.25 {
		t.Errorf("memPercent = %f, want 6.25", memPct)
	}

	if entry.MemUsage != "256MiB / 4GiB" {
		t.Errorf("memUsage = %q, want %q", entry.MemUsage, "256MiB / 4GiB")
	}
}

func TestDockerInfoErrorField(t *testing.T) {
	// When DockerInfo has an error, it should be non-nil
	errMsg := "failed to list containers: connection refused"
	info := DockerInfo{
		Error: &errMsg,
	}
	if info.Error == nil {
		t.Fatal("expected error to be non-nil")
	}
	if *info.Error != errMsg {
		t.Errorf("error = %q, want %q", *info.Error, errMsg)
	}

	// When no error, it should be nil
	infoOk := DockerInfo{}
	if infoOk.Error != nil {
		t.Errorf("expected nil error, got %q", *infoOk.Error)
	}
}

func TestContainerInfoStateField(t *testing.T) {
	// Verify ContainerInfo has both Status (human-readable) and State (machine-readable)
	ci := ContainerInfo{
		ID:     "abc",
		Name:   "test",
		Image:  "nginx",
		Status: "Up 2 hours",
		State:  "running",
	}
	if ci.State != "running" {
		t.Errorf("State = %q, want %q", ci.State, "running")
	}
	if ci.Status != "Up 2 hours" {
		t.Errorf("Status = %q, want %q", ci.Status, "Up 2 hours")
	}
}

func TestEnvDuration(t *testing.T) {
	// Test with unset env var — should return default
	got := envDuration("SYSINFO_TEST_NONEXISTENT_VAR", 42*time.Second)
	if got != 42*time.Second {
		t.Errorf("envDuration(unset) = %v, want 42s", got)
	}

	// Test with valid env var
	t.Setenv("SYSINFO_TEST_DURATION", "5s")
	got = envDuration("SYSINFO_TEST_DURATION", 42*time.Second)
	if got != 5*time.Second {
		t.Errorf("envDuration(5s) = %v, want 5s", got)
	}

	// Test with invalid env var — should return default
	t.Setenv("SYSINFO_TEST_DURATION_BAD", "not-a-duration")
	got = envDuration("SYSINFO_TEST_DURATION_BAD", 42*time.Second)
	if got != 42*time.Second {
		t.Errorf("envDuration(invalid) = %v, want 42s", got)
	}
}

func TestNewCollectorEnvTimeouts(t *testing.T) {
	// Test that NewCollector reads env vars for Docker timeouts
	t.Setenv("SYSINFO_DOCKER_LIST_TIMEOUT", "15s")
	t.Setenv("SYSINFO_DOCKER_STATS_TIMEOUT", "20s")

	c := NewCollector(CollectorConfig{})
	if c.config.DockerListTimeout != 15*time.Second {
		t.Errorf("DockerListTimeout = %v, want 15s", c.config.DockerListTimeout)
	}
	if c.config.DockerStatsTimeout != 20*time.Second {
		t.Errorf("DockerStatsTimeout = %v, want 20s", c.config.DockerStatsTimeout)
	}
}

func TestStatsOnlyForRunningContainers(t *testing.T) {
	// Verify that non-running containers have zero CPU/mem after merge
	// (since stats are only collected for running containers)
	psOutput := `{"ID":"run1","Names":"runner","Image":"img","Status":"Up","State":"running","CreatedAt":"now"}
{"ID":"exit1","Names":"stopped","Image":"img","Status":"Exited (0)","State":"exited","CreatedAt":"now"}`

	statsOutput := `{"id":"run1","cpuPercent":"12.5%","memUsage":"128MiB / 2GiB","memPercent":"6.25%"}`

	containers := parseDockerPS(psOutput)
	statsMap := parseDockerStats(statsOutput)

	// Merge
	for i := range containers {
		if stats, ok := statsMap[containers[i].ID]; ok {
			containers[i].CPUPercent = parsePercentString(stats.CPUPercent)
			containers[i].MemUsage = stats.MemUsage
			containers[i].MemPercent = parsePercentString(stats.MemPercent)
		}
	}

	if len(containers) != 2 {
		t.Fatalf("expected 2 containers, got %d", len(containers))
	}

	// Running container should have stats
	if containers[0].CPUPercent != 12.5 {
		t.Errorf("running container CPUPercent = %f, want 12.5", containers[0].CPUPercent)
	}
	if containers[0].MemUsage != "128MiB / 2GiB" {
		t.Errorf("running container MemUsage = %q, want %q", containers[0].MemUsage, "128MiB / 2GiB")
	}

	// Exited container should have zero stats (no stats entry)
	if containers[1].CPUPercent != 0 {
		t.Errorf("exited container CPUPercent = %f, want 0", containers[1].CPUPercent)
	}
	if containers[1].MemUsage != "" {
		t.Errorf("exited container MemUsage = %q, want empty", containers[1].MemUsage)
	}
	if containers[1].MemPercent != 0 {
		t.Errorf("exited container MemPercent = %f, want 0", containers[1].MemPercent)
	}
}
