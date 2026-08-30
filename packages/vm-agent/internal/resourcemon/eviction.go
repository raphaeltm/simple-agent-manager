package resourcemon

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"
)

// EvictionReason is the control-plane reason emitted for a workspace eviction.
type EvictionReason string

const (
	EvictionReasonMemoryPressure EvictionReason = "memory_pressure"
	EvictionReasonOOMKill        EvictionReason = "oom_kill"
)

// PressureSource is the ResourceGuard surface consumed by EvictionController.
type PressureSource interface {
	PressureEvents() <-chan PressureEvent
	CurrentPressure() ResourcePressure
}

// WorkspaceContainer binds a Docker container metrics row to a VM-agent workspace.
type WorkspaceContainer struct {
	WorkspaceID   string
	ContainerID   string
	ContainerName string
}

// EvictionTarget is the selected workspace/container for one eviction attempt.
type EvictionTarget struct {
	WorkspaceID   string
	ContainerID   string
	ContainerName string
	Reason        EvictionReason
	Event         PressureEvent
	Metric        *ContainerMetric
	TriggeredAt   time.Time
}

// EvictionResult captures all side effects attempted for one eviction.
type EvictionResult struct {
	Target             EvictionTarget
	SnapshotCaptured   bool
	SnapshotError      error
	ContainerStopped   bool
	ContainerStopError error
	NotifyError        error
	StartedAt          time.Time
	CompletedAt        time.Time
}

// EvictionControllerConfig configures ResourceGuard-triggered workspace eviction.
type EvictionControllerConfig struct {
	Source               PressureSource
	DebounceWindow       time.Duration
	SnapshotTimeout      time.Duration
	ResolveTimeout       time.Duration
	ResolveWorkspace     func(context.Context, ContainerMetric) (WorkspaceContainer, bool)
	SnapshotWorkspace    func(context.Context, EvictionTarget) error
	StopContainer        func(context.Context, EvictionTarget) error
	MarkWorkspaceEvicted func(EvictionResult)
	NotifyEviction       func(context.Context, EvictionResult) error
	Clock                func() time.Time
	Logger               *slog.Logger
}

// Validate checks eviction controller configuration.
func (c EvictionControllerConfig) Validate() error {
	var errs []error
	if c.Source == nil {
		errs = append(errs, errors.New("Source is required"))
	}
	if c.DebounceWindow <= 0 {
		errs = append(errs, fmt.Errorf("DebounceWindow must be > 0, got %s", c.DebounceWindow))
	}
	if c.SnapshotTimeout <= 0 {
		errs = append(errs, fmt.Errorf("SnapshotTimeout must be > 0, got %s", c.SnapshotTimeout))
	}
	if c.ResolveTimeout <= 0 {
		errs = append(errs, fmt.Errorf("ResolveTimeout must be > 0, got %s", c.ResolveTimeout))
	}
	if c.SnapshotWorkspace == nil {
		errs = append(errs, errors.New("SnapshotWorkspace is required"))
	}
	if c.StopContainer == nil {
		errs = append(errs, errors.New("StopContainer is required"))
	}
	if c.MarkWorkspaceEvicted == nil {
		errs = append(errs, errors.New("MarkWorkspaceEvicted is required"))
	}
	if c.NotifyEviction == nil {
		errs = append(errs, errors.New("NotifyEviction is required"))
	}
	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	return nil
}

// EvictionController serializes pressure-triggered workspace evictions.
type EvictionController struct {
	cfg    EvictionControllerConfig
	logger *slog.Logger

	startOnce sync.Once
	closeOnce sync.Once
	cancel    context.CancelFunc
	wg        sync.WaitGroup

	evictionMu sync.Mutex
	debounceMu sync.Mutex
	lastByKey  map[string]time.Time
}

// NewEvictionController creates a controller for ResourceGuard pressure events.
func NewEvictionController(cfg EvictionControllerConfig) (*EvictionController, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if cfg.Clock == nil {
		cfg.Clock = func() time.Time { return time.Now().UTC() }
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &EvictionController{
		cfg:       cfg,
		logger:    cfg.Logger,
		lastByKey: make(map[string]time.Time),
	}, nil
}

// Start begins consuming ResourceGuard pressure events.
func (c *EvictionController) Start(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	c.startOnce.Do(func() {
		runCtx, cancel := context.WithCancel(ctx)
		c.cancel = cancel
		c.wg.Add(1)
		go c.loop(runCtx)
	})
	return nil
}

// Close stops the controller and waits for its event loop to exit.
func (c *EvictionController) Close() {
	c.closeOnce.Do(func() {
		if c.cancel != nil {
			c.cancel()
		}
		c.wg.Wait()
	})
}

func (c *EvictionController) loop(ctx context.Context) {
	defer c.wg.Done()
	events := c.cfg.Source.PressureEvents()
	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-events:
			if !ok {
				return
			}
			c.handleEvent(ctx, event)
		}
	}
}

func (c *EvictionController) handleEvent(ctx context.Context, event PressureEvent) {
	if event.Level == PressureLevelWarning {
		c.logWarning(event)
		return
	}
	if event.Level != PressureLevelCritical && event.Type != PressureEventContainerOOM {
		return
	}

	resolveCtx, cancel := context.WithTimeout(ctx, c.cfg.ResolveTimeout)
	target, ok := c.selectTarget(resolveCtx, event)
	cancel()
	if !ok {
		c.logger.Warn("resourcemon: critical pressure event had no evictable workspace",
			"type", event.Type,
			"workspaceId", event.WorkspaceID,
			"containerId", event.ContainerID,
			"containerName", event.ContainerName,
		)
		return
	}

	c.evictionMu.Lock()
	defer c.evictionMu.Unlock()
	if c.debounced(target) {
		c.logger.Info("resourcemon: eviction skipped by debounce",
			"workspaceId", target.WorkspaceID,
			"containerId", target.ContainerID,
			"containerName", target.ContainerName,
			"reason", target.Reason,
			"debounceWindow", c.cfg.DebounceWindow,
		)
		return
	}

	c.performEviction(context.WithoutCancel(ctx), target)
}

func (c *EvictionController) logWarning(event PressureEvent) {
	pressure := c.cfg.Source.CurrentPressure()
	metric := metricForEvent(event, pressure.Containers)
	if metric == nil {
		metric = largestMemoryConsumer(pressure.Containers)
	}

	attrs := []any{
		"type", event.Type,
		"level", event.Level,
		"workspaceId", event.WorkspaceID,
		"containerId", event.ContainerID,
		"containerName", event.ContainerName,
		"containerCount", len(pressure.Containers),
	}
	if event.Memory != nil {
		attrs = append(attrs,
			"someAvg10", event.Memory.Some.Avg10,
			"someAvg60", event.Memory.Some.Avg60,
			"fullAvg10", event.Memory.Full.Avg10,
			"fullAvg60", event.Memory.Full.Avg60,
		)
	}
	if metric != nil {
		attrs = append(attrs,
			"topContainerId", metric.ID,
			"topContainerName", metric.Name,
			"topContainerMemUsageBytes", metric.MemUsageBytes,
			"topContainerMemPercent", metric.MemPercent,
		)
	}

	message := strings.TrimSpace(event.Message)
	if message == "" {
		message = "resourcemon: resource pressure warning"
	}
	c.logger.Warn(message, attrs...)
}

func (c *EvictionController) selectTarget(ctx context.Context, event PressureEvent) (EvictionTarget, bool) {
	reason := EvictionReasonMemoryPressure
	if event.Type == PressureEventContainerOOM {
		reason = EvictionReasonOOMKill
	}
	triggeredAt := event.OccurredAt
	if triggeredAt.IsZero() {
		triggeredAt = c.now()
	}

	pressure := c.cfg.Source.CurrentPressure()
	if event.WorkspaceID != "" && (event.ContainerID != "" || event.ContainerName != "") {
		metric := metricForEvent(event, pressure.Containers)
		return EvictionTarget{
			WorkspaceID:   event.WorkspaceID,
			ContainerID:   event.ContainerID,
			ContainerName: event.ContainerName,
			Reason:        reason,
			Event:         event,
			Metric:        cloneMetricPointer(metric),
			TriggeredAt:   triggeredAt,
		}, true
	}

	metrics := sortedMemoryConsumers(pressure.Containers)
	if len(metrics) == 0 {
		if event.WorkspaceID != "" {
			return EvictionTarget{
				WorkspaceID:   event.WorkspaceID,
				ContainerID:   event.ContainerID,
				ContainerName: event.ContainerName,
				Reason:        reason,
				Event:         event,
				TriggeredAt:   triggeredAt,
			}, true
		}
		return EvictionTarget{}, false
	}

	for _, metric := range metrics {
		if event.ContainerID != "" && !containerIDMatches(event.ContainerID, metric.ID) {
			continue
		}
		if event.ContainerName != "" && !containerNameMatches(event.ContainerName, metric.Name) {
			continue
		}
		workspace, ok := c.resolveWorkspace(ctx, metric)
		if !ok {
			continue
		}
		if event.WorkspaceID != "" && workspace.WorkspaceID != event.WorkspaceID {
			continue
		}
		if workspace.ContainerID == "" {
			workspace.ContainerID = metric.ID
		}
		if workspace.ContainerName == "" {
			workspace.ContainerName = metric.Name
		}
		metricCopy := metric
		return EvictionTarget{
			WorkspaceID:   workspace.WorkspaceID,
			ContainerID:   workspace.ContainerID,
			ContainerName: workspace.ContainerName,
			Reason:        reason,
			Event:         event,
			Metric:        &metricCopy,
			TriggeredAt:   triggeredAt,
		}, true
	}

	if event.WorkspaceID != "" {
		return EvictionTarget{
			WorkspaceID:   event.WorkspaceID,
			ContainerID:   event.ContainerID,
			ContainerName: event.ContainerName,
			Reason:        reason,
			Event:         event,
			TriggeredAt:   triggeredAt,
		}, true
	}

	return EvictionTarget{}, false
}

func (c *EvictionController) resolveWorkspace(ctx context.Context, metric ContainerMetric) (WorkspaceContainer, bool) {
	if c.cfg.ResolveWorkspace == nil {
		return WorkspaceContainer{}, false
	}
	return c.cfg.ResolveWorkspace(ctx, metric)
}

func (c *EvictionController) debounced(target EvictionTarget) bool {
	key := evictionDebounceKey(target)
	if key == "" {
		return false
	}

	now := c.now()
	c.debounceMu.Lock()
	defer c.debounceMu.Unlock()
	if last, ok := c.lastByKey[key]; ok && now.Sub(last) < c.cfg.DebounceWindow {
		return true
	}
	c.lastByKey[key] = now
	return false
}

func (c *EvictionController) performEviction(ctx context.Context, target EvictionTarget) {
	result := EvictionResult{
		Target:    target,
		StartedAt: c.now(),
	}

	snapshotCtx, cancel := context.WithTimeout(ctx, c.cfg.SnapshotTimeout)
	if err := c.cfg.SnapshotWorkspace(snapshotCtx, target); err != nil {
		result.SnapshotError = err
		c.logger.Warn("resourcemon: eviction snapshot failed; proceeding to docker stop",
			"workspaceId", target.WorkspaceID,
			"containerId", target.ContainerID,
			"containerName", target.ContainerName,
			"reason", target.Reason,
			"error", err,
		)
	} else {
		result.SnapshotCaptured = true
	}
	cancel()

	if err := c.cfg.StopContainer(ctx, target); err != nil {
		result.ContainerStopError = err
		c.logger.Warn("resourcemon: eviction docker stop failed",
			"workspaceId", target.WorkspaceID,
			"containerId", target.ContainerID,
			"containerName", target.ContainerName,
			"reason", target.Reason,
			"error", err,
		)
	} else {
		result.ContainerStopped = true
	}

	result.CompletedAt = c.now()
	c.cfg.MarkWorkspaceEvicted(result)
	if err := c.cfg.NotifyEviction(ctx, result); err != nil {
		result.NotifyError = err
		c.logger.Warn("resourcemon: eviction callback failed",
			"workspaceId", target.WorkspaceID,
			"containerId", target.ContainerID,
			"containerName", target.ContainerName,
			"reason", target.Reason,
			"error", err,
		)
	}
}

func (c *EvictionController) now() time.Time {
	return c.cfg.Clock().UTC()
}

func evictionDebounceKey(target EvictionTarget) string {
	if id := strings.TrimSpace(target.ContainerID); id != "" {
		return "container:" + id
	}
	if name := strings.TrimSpace(target.ContainerName); name != "" {
		return "container-name:" + name
	}
	if workspaceID := strings.TrimSpace(target.WorkspaceID); workspaceID != "" {
		return "workspace:" + workspaceID
	}
	return ""
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
