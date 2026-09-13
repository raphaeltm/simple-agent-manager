package resourcemon

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os/exec"
	"sync"

	"github.com/workspace/vm-agent/internal/sysinfo"
	"testing"
	"time"
)

func testResourceGuardConfig() ResourceGuardConfig {
	return ResourceGuardConfig{
		PSIPollInterval:        time.Hour,
		ContainerStatsInterval: time.Hour,
		PSIThresholds:          testPSIThresholds(),
		EventBuffer:            4096,
	}
}

func TestResourceGuardCurrentPressureCopiesMutableFields(t *testing.T) {
	guard, err := NewResourceGuard(testResourceGuardConfig())
	if err != nil {
		t.Fatalf("NewResourceGuard() error = %v", err)
	}
	defer guard.Close()

	guard.updateContainerMetrics([]ContainerMetric{{ID: "abc", CPUPercent: 1}})
	guard.handleContainerOOM(ContainerOOMEvent{WorkspaceID: "ws", ContainerID: "abc", OccurredAt: time.Now().UTC()})

	snapshot := guard.CurrentPressure()
	snapshot.Containers[0].CPUPercent = 99
	snapshot.LastContainerOOM.ContainerID = "mutated"

	next := guard.CurrentPressure()
	if next.Containers[0].CPUPercent != 1 {
		t.Fatalf("container metrics slice was not copied: %#v", next.Containers[0])
	}
	if next.LastContainerOOM.ContainerID != "abc" {
		t.Fatalf("last OOM event was not copied: %#v", next.LastContainerOOM)
	}
}

func TestResourceGuardConcurrentGetterSafety(t *testing.T) {
	guard, err := NewResourceGuard(testResourceGuardConfig())
	if err != nil {
		t.Fatalf("NewResourceGuard() error = %v", err)
	}
	defer guard.Close()

	stop := make(chan struct{})
	var readers sync.WaitGroup
	for i := 0; i < 16; i++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-stop:
					return
				default:
					_ = guard.CurrentPressure()
					_ = guard.PressureLevel()
				}
			}
		}()
	}

	for i := 0; i < 1000; i++ {
		pressure := MemoryPressure{
			Available:   true,
			Some:        PSIReading{Avg10: float64(i % 60), Avg60: float64(i % 30)},
			Full:        PSIReading{Avg10: float64(i % 20), Avg60: float64(i % 10)},
			CollectedAt: time.Now().UTC(),
		}
		pressure.Level = ClassifyMemoryPressure(pressure, testPSIThresholds())
		guard.updateMemoryPressure(pressure)
		guard.updateContainerMetrics([]ContainerMetric{{
			ID:            "abc",
			CPUPercent:    float64(i),
			MemUsageBytes: uint64(i),
			CollectedAt:   time.Now().UTC(),
		}})
		if i%10 == 0 {
			guard.handleContainerOOM(ContainerOOMEvent{
				WorkspaceID: "ws",
				ContainerID: "abc",
				OccurredAt:  time.Now().UTC(),
			})
		}
	}

	close(stop)
	readers.Wait()
}

func TestResourceGuardValidateRejectsInvalidThresholdOrder(t *testing.T) {
	cfg := testResourceGuardConfig()
	cfg.PSIThresholds.MemorySomeWarningThreshold = 60
	cfg.PSIThresholds.MemorySomeCriticalThreshold = 50
	if err := cfg.Validate(); err == nil {
		t.Fatal("Validate() should reject warning threshold above critical threshold")
	}
}

func TestResourceGuardRepeatsCriticalPressureUntilRecovery(t *testing.T) {
	guard, err := NewResourceGuard(testResourceGuardConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Close()
	for i := 0; i < 3; i++ {
		guard.updateMemoryPressure(MemoryPressure{Available: true, Level: PressureLevelCritical, CollectedAt: time.Now()})
		select {
		case event := <-guard.PressureEvents():
			if event.Level != PressureLevelCritical {
				t.Fatalf("event = %#v", event)
			}
		default:
			t.Fatal("sustained critical pressure lost retry")
		}
	}
	guard.updateMemoryPressure(MemoryPressure{Available: true, Level: PressureLevelNone, CollectedAt: time.Now()})
	select {
	case event := <-guard.PressureEvents():
		t.Fatalf("unexpected recovery event %#v", event)
	default:
	}
}

func TestResourceGuardInitialPressureHasContainerMetrics(t *testing.T) {
	cfg := testResourceGuardConfig()
	cfg.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	cfg.DockerEventsCommand = func(ctx context.Context) *exec.Cmd { return exec.CommandContext(ctx, "/nonexistent-sam-test-docker") }
	cfg.PressureReadFile = func(string) ([]byte, error) {
		return []byte("some avg10=90 avg60=90 avg300=90 total=100\nfull avg10=90 avg60=90 avg300=90 total=100\n"), nil
	}
	cfg.CollectDockerStats = func(context.Context, time.Duration, ...string) (map[string]sysinfo.DockerStatsEntry, error) {
		return map[string]sysinfo.DockerStatsEntry{"victim": {ID: "victim"}}, nil
	}
	guard, err := NewResourceGuard(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := guard.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer guard.Close()
	select {
	case <-guard.PressureEvents():
		if len(guard.CurrentPressure().Containers) != 1 {
			t.Fatal("initial critical event had no metrics")
		}
	case <-time.After(time.Second):
		t.Fatal("initial pressure event missing")
	}
}

func TestResourceGuardCriticalPressureRefreshesVictimsAndDropsStaleMetricsOnFailure(t *testing.T) {
	cfg := testResourceGuardConfig()
	cfg.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	cfg.PressureReadFile = func(string) ([]byte, error) {
		return []byte("some avg10=90 avg60=90 avg300=90 total=100\nfull avg10=90 avg60=90 avg300=90 total=100\n"), nil
	}
	fail := false
	cfg.CollectDockerStats = func(context.Context, time.Duration, ...string) (map[string]sysinfo.DockerStatsEntry, error) {
		if fail {
			return nil, errors.New("Docker unavailable")
		}
		return map[string]sysinfo.DockerStatsEntry{"fresh": {ID: "fresh"}}, nil
	}
	guard, err := NewResourceGuard(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Close()
	guard.updateContainerMetrics([]ContainerMetric{{ID: "stale"}})
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	psiC := ticker.C
	guard.pollPSI(context.Background(), &psiC, ticker)
	if got := guard.CurrentPressure().Containers; len(got) != 1 || got[0].ID != "fresh" {
		t.Fatalf("victims = %#v", got)
	}
	fail = true
	guard.pollPSI(context.Background(), &psiC, ticker)
	if got := guard.CurrentPressure(); len(got.Containers) != 0 || got.Level != PressureLevelCritical {
		t.Fatalf("failed sample retained stale victim or hid pressure: %#v", got)
	}
}
