package resourcemon

import (
	"sync"
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
