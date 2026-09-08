package resourcemon

import (
	"context"
	"sort"
	"time"

	"github.com/workspace/vm-agent/internal/sysinfo"
)

// ContainerMetric is the active resource usage for one Docker container.
type ContainerMetric struct {
	ID             string    `json:"id"`
	Name           string    `json:"name,omitempty"`
	CPUPercent     float64   `json:"cpuPercent"`
	MemUsageBytes  uint64    `json:"memUsageBytes"`
	MemLimitBytes  uint64    `json:"memLimitBytes"`
	MemPercent     float64   `json:"memPercent"`
	PIDs           uint64    `json:"pids"`
	CollectedAt    time.Time `json:"collectedAt"`
	MemUsage       string    `json:"memUsage,omitempty"`
	CPUPercentText string    `json:"cpuPercentText,omitempty"`
	MemPercentText string    `json:"memPercentText,omitempty"`
}

// DockerStatsCollectorFunc is the shared Docker stats collection boundary.
type DockerStatsCollectorFunc func(ctx context.Context, timeout time.Duration, containerIDs ...string) (map[string]sysinfo.DockerStatsEntry, error)

// ContainerMetricsCollectorConfig configures container metrics collection.
type ContainerMetricsCollectorConfig struct {
	DockerStatsTimeout time.Duration
	CollectDockerStats DockerStatsCollectorFunc
}

// ContainerMetricsCollector polls Docker stats through the shared sysinfo parser.
type ContainerMetricsCollector struct {
	dockerStatsTimeout time.Duration
	collectDockerStats DockerStatsCollectorFunc
}

// NewContainerMetricsCollector creates a Docker CLI-backed container metrics collector.
func NewContainerMetricsCollector(cfg ContainerMetricsCollectorConfig) *ContainerMetricsCollector {
	if cfg.CollectDockerStats == nil {
		cfg.CollectDockerStats = sysinfo.CollectDockerStats
	}
	return &ContainerMetricsCollector{
		dockerStatsTimeout: cfg.DockerStatsTimeout,
		collectDockerStats: cfg.CollectDockerStats,
	}
}

// Poll collects one no-stream Docker stats sample.
func (c *ContainerMetricsCollector) Poll(ctx context.Context) ([]ContainerMetric, error) {
	stats, err := c.collectDockerStats(ctx, c.dockerStatsTimeout)
	if err != nil {
		return nil, err
	}
	return DockerStatsToContainerMetrics(stats, time.Now().UTC()), nil
}

// ParseContainerMetrics parses docker stats JSON lines into resource metrics.
func ParseContainerMetrics(output string) []ContainerMetric {
	return DockerStatsToContainerMetrics(sysinfo.ParseDockerStats(output), time.Time{})
}

// DockerStatsToContainerMetrics converts parsed sysinfo Docker stats into sorted metrics.
func DockerStatsToContainerMetrics(stats map[string]sysinfo.DockerStatsEntry, collectedAt time.Time) []ContainerMetric {
	if len(stats) == 0 {
		return nil
	}
	ids := make([]string, 0, len(stats))
	for id := range stats {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	metrics := make([]ContainerMetric, 0, len(ids))
	for _, id := range ids {
		entry := stats[id]
		metrics = append(metrics, ContainerMetric{
			ID:             entry.ID,
			Name:           entry.Name,
			CPUPercent:     entry.CPUPercent,
			MemUsageBytes:  entry.MemUsageBytes,
			MemLimitBytes:  entry.MemLimitBytes,
			MemPercent:     entry.MemPercent,
			PIDs:           entry.PIDs,
			CollectedAt:    collectedAt,
			MemUsage:       entry.MemUsage,
			CPUPercentText: entry.CPUPercentText,
			MemPercentText: entry.MemPercentText,
		})
	}
	return metrics
}
