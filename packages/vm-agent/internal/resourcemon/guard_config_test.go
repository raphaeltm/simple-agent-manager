package resourcemon

import (
	"math"
	"testing"
)

func TestResourceGuardRejectsInvalidPercentages(t *testing.T) {
	for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), 101, 0, -1} {
		for _, field := range []struct {
			name string
			set  func(*PSIThresholds, float64)
		}{
			{"MemorySomeWarningThreshold", func(c *PSIThresholds, v float64) { c.MemorySomeWarningThreshold = v }},
			{"MemorySomeCriticalThreshold", func(c *PSIThresholds, v float64) { c.MemorySomeCriticalThreshold = v }},
			{"MemoryFullWarningThreshold", func(c *PSIThresholds, v float64) { c.MemoryFullWarningThreshold = v }},
			{"MemoryFullCriticalThreshold", func(c *PSIThresholds, v float64) { c.MemoryFullCriticalThreshold = v }},
		} {
			cfg := testResourceGuardConfig()
			field.set(&cfg.PSIThresholds, value)
			if err := cfg.Validate(); err == nil {
				t.Errorf("accepted %s=%v", field.name, value)
			}
		}
	}
}
func TestResourceGuardUsesConfiguredEventQueueCapacity(t *testing.T) {
	cfg := testResourceGuardConfig()
	cfg.EventBuffer = 7
	guard, err := NewResourceGuard(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if cap(guard.pressureEvents) != 7 || cap(guard.dockerEvents.events) != 7 {
		t.Fatal("configured buffer not propagated to both queues")
	}
}
