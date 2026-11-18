package config

import (
	"math"
	"strings"
	"testing"
)

func TestResourceMonitoringRejectsInvalidPercentages(t *testing.T) {
	for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), 101, 0, -1} {
		for _, field := range []struct {
			name string
			set  func(*Config, float64)
		}{
			{"PSIMemorySomeWarningThreshold", func(c *Config, v float64) { c.PSIMemorySomeWarningThreshold = v }},
			{"PSIMemorySomeCriticalThreshold", func(c *Config, v float64) { c.PSIMemorySomeCriticalThreshold = v }},
			{"PSIMemoryFullWarningThreshold", func(c *Config, v float64) { c.PSIMemoryFullWarningThreshold = v }},
			{"PSIMemoryFullCriticalThreshold", func(c *Config, v float64) { c.PSIMemoryFullCriticalThreshold = v }},
		} {
			cfg := validConfig()
			field.set(cfg, value)
			if err := cfg.Validate(); err == nil {
				t.Errorf("accepted %s=%v", field.name, value)
			}
		}
	}
}
func TestResourceEventBufferConfiguration(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "test-workspace")
	for _, test := range []struct {
		raw  string
		want int
	}{{"", DefaultResourceEventBufferSize}, {"17", 17}} {
		t.Setenv(EnvDefaultResourceEventBufferSize, test.raw)
		cfg, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if cfg.ResourceEventBufferSize != test.want {
			t.Fatalf("buffer=%d want%d", cfg.ResourceEventBufferSize, test.want)
		}
	}
	cfg := validConfig()
	cfg.ResourceEventBufferSize = 0
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), EnvDefaultResourceEventBufferSize) {
		t.Fatalf("invalid queue size accepted: %v", err)
	}
}

// Docker treats --memory 0 as unlimited, so a value that parses to zero bytes must not
// reach the snapshot helper as a bound.
func TestSnapshotHelperMemoryLimitMustBePositive(t *testing.T) {
	for _, value := range []string{"0", "0g", "0.0001k", "0 MiB", "-1", "1x", "unlimited", "99999999999p"} {
		cfg := validConfig()
		cfg.SnapshotHelper.MemoryLimit = value
		if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), EnvSnapshotHelperMemoryLimit) {
			t.Errorf("accepted %s=%q: %v", EnvSnapshotHelperMemoryLimit, value, err)
		}
	}
	// Control: empty resolves to the default, and every unit Docker accepts still passes.
	for _, value := range []string{"", "1g", "512m", "1.5GiB", "6291456", "2 GB", "1024k"} {
		cfg := validConfig()
		cfg.SnapshotHelper.MemoryLimit = value
		if err := cfg.Validate(); err != nil {
			t.Errorf("rejected %s=%q: %v", EnvSnapshotHelperMemoryLimit, value, err)
		}
	}
	if bytes, ok := dockerMemoryBytes("1.5g"); !ok || bytes != 3<<29 {
		t.Fatalf("1.5g = %d, %v", bytes, ok)
	}
}
