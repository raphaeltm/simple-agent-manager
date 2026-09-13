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
