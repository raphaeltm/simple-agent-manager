package config

import (
	"fmt"
	"time"
)

// validateEvictionParkTimeout keeps the fallback deadline outside a healthy eviction's
// stop, final capture and recording windows. The stop command has a 1.5x deadline
// plus one stop timeout of WaitDelay (server.stopEvictionContainer). Subtract each
// bound separately so an overflowing sum can never accept an unsafe configuration.
func (c *Config) validateEvictionParkTimeout() error {
	remaining := c.ACPEvictionParkTimeout
	if remaining == 0 {
		remaining = DefaultACPEvictionParkTimeout
	}
	for _, budget := range []struct {
		name     string
		duration time.Duration
	}{
		{"docker stop", c.EvictionDockerStopTimeout},
		{"docker stop cancellation", c.EvictionDockerStopTimeout / 2},
		{"docker stop WaitDelay", c.EvictionDockerStopTimeout},
		{"final snapshot", c.SnapshotHelper.WithDefaults().FinalSnapshotTimeout},
		{"recording", c.HTTPCallbackTimeout},
	} {
		if remaining <= budget.duration || budget.duration < 0 {
			return fmt.Errorf("EVICTION_PARK_TIMEOUT must exceed the combined docker-stop, final snapshot and recording budgets (exhausted at %s)", budget.name)
		}
		remaining -= budget.duration
	}
	return nil
}
