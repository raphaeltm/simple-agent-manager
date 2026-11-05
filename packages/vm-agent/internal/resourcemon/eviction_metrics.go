package resourcemon

import (
	"sort"
	"strings"
)

func evictionMetricsForEvent(event PressureEvent, containers []ContainerMetric) []ContainerMetric {
	metrics := sortedMemoryConsumers(containers)
	if event.Type == PressureEventContainerOOM {
		// An exited OOM victim is absent from docker stats. Resolve its immutable
		// ID directly; Docker labels supplied by the event are only hints.
		if strings.TrimSpace(event.ContainerID) == "" {
			return nil
		}
		metric := ContainerMetric{ID: event.ContainerID, Name: event.ContainerName}
		if sampled := metricForEvent(event, metrics); sampled != nil {
			metric = *sampled
			metric.ID = event.ContainerID // Never substitute a same-name replacement.
		}
		metrics = []ContainerMetric{metric}
	}
	return metrics
}

func sortedMemoryConsumers(metrics []ContainerMetric) []ContainerMetric {
	if len(metrics) == 0 {
		return nil
	}
	out := cloneContainerMetrics(metrics)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].MemUsageBytes != out[j].MemUsageBytes {
			return out[i].MemUsageBytes > out[j].MemUsageBytes
		}
		if out[i].MemPercent != out[j].MemPercent {
			return out[i].MemPercent > out[j].MemPercent
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func largestMemoryConsumer(metrics []ContainerMetric) *ContainerMetric {
	sorted := sortedMemoryConsumers(metrics)
	if len(sorted) == 0 {
		return nil
	}
	return &sorted[0]
}

func metricForEvent(event PressureEvent, metrics []ContainerMetric) *ContainerMetric {
	for i := range metrics {
		metric := metrics[i]
		if event.ContainerID != "" && containerIDMatches(event.ContainerID, metric.ID) {
			return &metric
		}
		if event.ContainerName != "" && containerNameMatches(event.ContainerName, metric.Name) {
			return &metric
		}
	}
	return nil
}

func cloneMetricPointer(metric *ContainerMetric) *ContainerMetric {
	if metric == nil {
		return nil
	}
	copy := *metric
	return &copy
}

func containerIDMatches(a, b string) bool {
	a = strings.TrimSpace(a)
	b = strings.TrimSpace(b)
	if a == "" || b == "" {
		return false
	}
	return a == b || strings.HasPrefix(a, b) || strings.HasPrefix(b, a)
}

func containerNameMatches(a, b string) bool {
	a = strings.Trim(strings.TrimSpace(a), "/")
	b = strings.Trim(strings.TrimSpace(b), "/")
	return a != "" && b != "" && a == b
}
