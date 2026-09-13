package sysinfo

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestCollectDockerStatsSharesHeartbeatMetrics(t *testing.T) {
	installFakeDockerCLI(t, "collector")
	t.Setenv("PATH", t.TempDir())
	stats, err := CollectDockerStats(context.Background(), time.Second, "abc123")
	if err != nil {
		t.Fatal(err)
	}
	heartbeat, err := CollectDockerContainerStats(context.Background(), time.Second, []string{"abc123"})
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 1 || len(heartbeat) != 1 {
		t.Fatalf("resource and heartbeat samples: %#v / %#v", stats, heartbeat)
	}
	resource, beat := stats["abc123"], heartbeat["abc123"]
	if resource.PIDs != 7 || resource.MemUsageBytes != 10*1024*1024 || resource.MemLimitBytes != 1024*1024*1024 {
		t.Fatalf("numeric resource metrics missing: %#v", resource)
	}
	if beat.CPUPercent != resource.CPUPercent || beat.MemoryUsageBytes != resource.MemUsageBytes || beat.MemoryLimitBytes != resource.MemLimitBytes || beat.MemoryPercent != resource.MemPercent || beat.Name != resource.Name {
		t.Fatalf("resource and heartbeat metrics disagree: %#v / %#v", resource, beat)
	}
}

func TestCollectDockerStatsBoundsResourceGuardCommands(t *testing.T) {
	for _, tt := range []struct {
		name, mode, errorText string
	}{
		{"stdout", "stats-excess", "stdout exceeded"},
		{"stderr", "stats-stderr-excess", "stderr exceeded"},
		{"redaction", "stats-error-secret", "[redacted]"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			installFakeDockerCLI(t, tt.mode)
			stats, err := CollectDockerStats(context.Background(), time.Second)
			if err == nil || !strings.Contains(err.Error(), tt.errorText) || stats != nil {
				t.Fatalf("stats = %#v, err = %v; expected %s", stats, err, tt.errorText)
			}
			if strings.Contains(err.Error(), "super-secret") || strings.Contains(err.Error(), "bearer-secret") || strings.Contains(err.Error(), "bad-password") {
				t.Fatal("Docker error leaked credentials")
			}
		})
	}
}

func TestCollectDockerStatsHonorsContextAndTimeout(t *testing.T) {
	installFakeDockerCLI(t, "stats-sleep")
	_, err := CollectDockerStats(context.Background(), 50*time.Millisecond)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline exceeded, got %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = CollectDockerStats(ctx, time.Second)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
}

func TestParseDockerMemoryUsageUnitsAndInvalidValues(t *testing.T) {
	for _, tt := range []struct {
		input string
		want  uint64
	}{
		{"1.5 GiB", 1610612736},
		{"1.5GB", 1500000000},
		{"1.5B", 2},
		{"1 PiB", 1125899906842624},
		{"-1GiB", 0},
		{"NaNGiB", 0},
		{"18446744073709551616B", 0},
		{"999999999999999999999999999999999999GiB", 0},
		{"1 unknown", 0},
	} {
		t.Run(tt.input, func(t *testing.T) {
			got, limit := ParseDockerMemoryUsage(tt.input + " / 2GiB")
			if got != tt.want || limit != 2*1024*1024*1024 {
				t.Fatalf("got %d / %d; want %d / 2GiB", got, limit, tt.want)
			}
		})
	}
}

func TestCollectDockerStatsUsesConfiguredDefaultTimeout(t *testing.T) {
	installFakeDockerCLI(t, "stats-sleep")
	t.Setenv("SYSINFO_DOCKER_STATS_TIMEOUT", "25ms")
	_, err := CollectDockerStats(nil, 0)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected configured default deadline, got %v", err)
	}
}
