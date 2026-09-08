package resourcemon

import (
	"context"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/sysinfo"
)

func TestParseContainerMetrics(t *testing.T) {
	input := `{"BlockIO":"0B / 0B","CPUPerc":"12.50%","Container":"def456","ID":"def456","MemPerc":"25.00%","MemUsage":"512MiB / 2GiB","Name":"workspace-b","NetIO":"1kB / 2kB","PIDs":"42"}
{"BlockIO":"0B / 0B","CPUPerc":"2.50%","Container":"abc123","ID":"abc123","MemPerc":"6.25%","MemUsage":"128MiB / 2GiB","Name":"workspace-a","NetIO":"1kB / 2kB","PIDs":"7"}`

	metrics := ParseContainerMetrics(input)
	if len(metrics) != 2 {
		t.Fatalf("got %d metrics, want 2", len(metrics))
	}
	if metrics[0].ID != "abc123" || metrics[1].ID != "def456" {
		t.Fatalf("metrics should be sorted by ID, got %#v", metrics)
	}
	first := metrics[0]
	if first.Name != "workspace-a" {
		t.Fatalf("Name = %q, want workspace-a", first.Name)
	}
	if first.CPUPercent != 2.5 {
		t.Fatalf("CPUPercent = %f, want 2.5", first.CPUPercent)
	}
	if first.MemUsageBytes != 128*1024*1024 {
		t.Fatalf("MemUsageBytes = %d, want %d", first.MemUsageBytes, uint64(128*1024*1024))
	}
	if first.MemLimitBytes != 2*1024*1024*1024 {
		t.Fatalf("MemLimitBytes = %d, want %d", first.MemLimitBytes, uint64(2*1024*1024*1024))
	}
	if first.MemPercent != 6.25 {
		t.Fatalf("MemPercent = %f, want 6.25", first.MemPercent)
	}
	if first.PIDs != 7 {
		t.Fatalf("PIDs = %d, want 7", first.PIDs)
	}
}

func TestContainerMetricsCollectorPollUsesSharedDockerStatsCollector(t *testing.T) {
	called := false
	collector := NewContainerMetricsCollector(ContainerMetricsCollectorConfig{
		DockerStatsTimeout: 123 * time.Millisecond,
		CollectDockerStats: func(ctx context.Context, timeout time.Duration, containerIDs ...string) (map[string]sysinfo.DockerStatsEntry, error) {
			called = true
			if timeout != 123*time.Millisecond {
				t.Fatalf("timeout = %s, want 123ms", timeout)
			}
			if len(containerIDs) != 0 {
				t.Fatalf("containerIDs = %#v, want empty", containerIDs)
			}
			return map[string]sysinfo.DockerStatsEntry{
				"abc": {
					ID:             "abc",
					Name:           "worker",
					CPUPercent:     3.25,
					MemUsage:       "64MiB / 1GiB",
					MemUsageBytes:  64 * 1024 * 1024,
					MemLimitBytes:  1024 * 1024 * 1024,
					MemPercent:     6.25,
					PIDs:           5,
					CPUPercentText: "3.25%",
					MemPercentText: "6.25%",
				},
			}, nil
		},
	})

	metrics, err := collector.Poll(context.Background())
	if err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if !called {
		t.Fatal("expected shared Docker stats collector to be called")
	}
	if len(metrics) != 1 {
		t.Fatalf("got %d metrics, want 1", len(metrics))
	}
	if metrics[0].ID != "abc" || metrics[0].Name != "worker" || metrics[0].PIDs != 5 {
		t.Fatalf("unexpected metric: %#v", metrics[0])
	}
	if metrics[0].CollectedAt.IsZero() {
		t.Fatal("CollectedAt should be set")
	}
}
