package resourcemon

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// PressureEventType identifies why a pressure event was emitted.
type PressureEventType string

const (
	PressureEventSystemMemory PressureEventType = "system_memory_pressure"
	PressureEventContainerOOM PressureEventType = "container_oom"
)

// PressureEvent is an active monitoring signal emitted by ResourceGuard.
type PressureEvent struct {
	Type          PressureEventType `json:"type"`
	Level         PressureLevel     `json:"level"`
	Message       string            `json:"message"`
	WorkspaceID   string            `json:"workspaceId,omitempty"`
	ContainerID   string            `json:"containerId,omitempty"`
	ContainerName string            `json:"containerName,omitempty"`
	OccurredAt    time.Time         `json:"occurredAt"`
	Memory        *MemoryPressure   `json:"memory,omitempty"`
}

// SystemPressure holds system-level resource pressure.
type SystemPressure struct {
	Memory MemoryPressure `json:"memory"`
	Level  PressureLevel  `json:"level"`
}

// ResourcePressure is the latest unified resource monitoring snapshot.
type ResourcePressure struct {
	Level            PressureLevel      `json:"level"`
	System           SystemPressure     `json:"system"`
	Containers       []ContainerMetric  `json:"containers"`
	LastContainerOOM *ContainerOOMEvent `json:"lastContainerOom,omitempty"`
	UpdatedAt        time.Time          `json:"updatedAt"`
}

// ResourceGuardConfig configures active resource monitoring.
type ResourceGuardConfig struct {
	PSIPollInterval        time.Duration
	ContainerStatsInterval time.Duration
	DockerStatsTimeout     time.Duration
	PSIThresholds          PSIThresholds
	PressurePath           string
	PressureReadFile       func(path string) ([]byte, error)
	CollectDockerStats     DockerStatsCollectorFunc
	DockerEventsCommand    DockerEventCommandFactory
	EventBuffer            int
	Logger                 *slog.Logger
}

// Validate checks ResourceGuard configuration.
func (c ResourceGuardConfig) Validate() error {
	var errs []error
	if c.PSIPollInterval <= 0 {
		errs = append(errs, fmt.Errorf("PSIPollInterval must be > 0, got %s", c.PSIPollInterval))
	}
	if c.ContainerStatsInterval <= 0 {
		errs = append(errs, fmt.Errorf("ContainerStatsInterval must be > 0, got %s", c.ContainerStatsInterval))
	}
	if c.PSIThresholds.MemorySomeWarningThreshold <= 0 {
		errs = append(errs, fmt.Errorf("MemorySomeWarningThreshold must be > 0, got %f", c.PSIThresholds.MemorySomeWarningThreshold))
	}
	if c.PSIThresholds.MemorySomeCriticalThreshold <= 0 {
		errs = append(errs, fmt.Errorf("MemorySomeCriticalThreshold must be > 0, got %f", c.PSIThresholds.MemorySomeCriticalThreshold))
	}
	if c.PSIThresholds.MemoryFullWarningThreshold <= 0 {
		errs = append(errs, fmt.Errorf("MemoryFullWarningThreshold must be > 0, got %f", c.PSIThresholds.MemoryFullWarningThreshold))
	}
	if c.PSIThresholds.MemoryFullCriticalThreshold <= 0 {
		errs = append(errs, fmt.Errorf("MemoryFullCriticalThreshold must be > 0, got %f", c.PSIThresholds.MemoryFullCriticalThreshold))
	}
	if c.PSIThresholds.MemorySomeWarningThreshold > c.PSIThresholds.MemorySomeCriticalThreshold {
		errs = append(errs, fmt.Errorf("MemorySomeWarningThreshold must be <= MemorySomeCriticalThreshold"))
	}
	if c.PSIThresholds.MemoryFullWarningThreshold > c.PSIThresholds.MemoryFullCriticalThreshold {
		errs = append(errs, fmt.Errorf("MemoryFullWarningThreshold must be <= MemoryFullCriticalThreshold"))
	}
	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	return nil
}

// ResourceGuard coordinates PSI, Docker event, and per-container resource monitoring.
type ResourceGuard struct {
	cfg              ResourceGuardConfig
	pressureMonitor  *PressureMonitor
	containerMetrics *ContainerMetricsCollector
	dockerEvents     *DockerEventSubscriber
	logger           *slog.Logger

	mu                 sync.RWMutex
	current            ResourcePressure
	lastPressureLevel  PressureLevel
	pressureEvents     chan PressureEvent
	psiUnavailableOnce atomic.Bool

	startOnce sync.Once
	closeOnce sync.Once
	wg        sync.WaitGroup
	cancel    context.CancelFunc
	startErr  error
}

// NewResourceGuard creates a ResourceGuard.
func NewResourceGuard(cfg ResourceGuardConfig) (*ResourceGuard, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if cfg.EventBuffer <= 0 {
		cfg.EventBuffer = 64
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	guard := &ResourceGuard{
		cfg: cfg,
		pressureMonitor: NewPressureMonitor(PressureMonitorConfig{
			Path:       cfg.PressurePath,
			Thresholds: cfg.PSIThresholds,
			ReadFile:   cfg.PressureReadFile,
		}),
		containerMetrics: NewContainerMetricsCollector(ContainerMetricsCollectorConfig{
			DockerStatsTimeout: cfg.DockerStatsTimeout,
			CollectDockerStats: cfg.CollectDockerStats,
		}),
		logger:            cfg.Logger,
		lastPressureLevel: PressureLevelNone,
		pressureEvents:    make(chan PressureEvent, cfg.EventBuffer),
		current: ResourcePressure{
			Level:     PressureLevelNone,
			UpdatedAt: time.Now().UTC(),
			System: SystemPressure{
				Level: PressureLevelNone,
			},
		},
	}
	guard.dockerEvents = NewDockerEventSubscriber(DockerEventSubscriberConfig{
		CommandFactory: cfg.DockerEventsCommand,
		EventBuffer:    cfg.EventBuffer,
		Logger:         cfg.Logger,
	})
	return guard, nil
}

// Start begins active resource monitoring.
func (g *ResourceGuard) Start(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	g.startOnce.Do(func() {
		runCtx, cancel := context.WithCancel(ctx)
		g.cancel = cancel

		if err := g.dockerEvents.Start(runCtx); err != nil {
			g.logger.Warn("resourcemon: Docker event subscription disabled", "error", err)
		} else {
			g.wg.Add(1)
			go g.consumeDockerEvents(runCtx)
		}

		g.wg.Add(1)
		go g.loop(runCtx)
	})
	return g.startErr
}

func (g *ResourceGuard) loop(ctx context.Context) {
	defer g.wg.Done()

	psiTicker := time.NewTicker(g.cfg.PSIPollInterval)
	defer psiTicker.Stop()
	containerTicker := time.NewTicker(g.cfg.ContainerStatsInterval)
	defer containerTicker.Stop()

	psiC := psiTicker.C
	g.pollPSI(ctx, &psiC, psiTicker)
	g.pollContainerStats(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case <-psiC:
			g.pollPSI(ctx, &psiC, psiTicker)
		case <-containerTicker.C:
			g.pollContainerStats(ctx)
		}
	}
}

func (g *ResourceGuard) pollPSI(ctx context.Context, psiC *<-chan time.Time, ticker *time.Ticker) {
	pressure, err := g.pressureMonitor.Poll(ctx)
	if err != nil {
		if errors.Is(err, ErrPressureUnavailable) {
			if g.psiUnavailableOnce.CompareAndSwap(false, true) {
				g.logger.Info("resourcemon: PSI memory pressure unavailable; disabling PSI polling",
					"path", g.pressureMonitor.path,
				)
			}
			ticker.Stop()
			*psiC = nil
			g.updateMemoryPressure(pressure)
			return
		}
		if !errors.Is(err, context.Canceled) {
			g.logger.Warn("resourcemon: PSI memory pressure poll failed", "error", err)
		}
		return
	}
	g.updateMemoryPressure(pressure)
}

func (g *ResourceGuard) pollContainerStats(ctx context.Context) {
	metrics, err := g.containerMetrics.Poll(ctx)
	if err != nil {
		if !errors.Is(err, context.Canceled) {
			g.logger.Warn("resourcemon: container metrics poll failed", "error", err)
		}
		return
	}
	g.updateContainerMetrics(metrics)
}

func (g *ResourceGuard) consumeDockerEvents(ctx context.Context) {
	defer g.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-g.dockerEvents.Events():
			if !ok {
				return
			}
			g.handleContainerOOM(event)
		}
	}
}

func (g *ResourceGuard) updateMemoryPressure(pressure MemoryPressure) {
	var emit *PressureEvent

	g.mu.Lock()
	previous := g.lastPressureLevel
	g.current.System.Memory = pressure
	g.current.System.Level = pressure.Level
	g.current.Level = pressure.Level
	g.current.UpdatedAt = time.Now().UTC()
	g.lastPressureLevel = pressure.Level
	if previous != pressure.Level && pressure.Level != PressureLevelNone {
		pressureCopy := pressure
		emit = &PressureEvent{
			Type:       PressureEventSystemMemory,
			Level:      pressure.Level,
			Message:    fmt.Sprintf("memory pressure is %s", pressure.Level),
			OccurredAt: pressure.CollectedAt,
			Memory:     &pressureCopy,
		}
	}
	g.mu.Unlock()

	if emit != nil {
		g.emit(*emit)
	}
}

func (g *ResourceGuard) updateContainerMetrics(metrics []ContainerMetric) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.current.Containers = cloneContainerMetrics(metrics)
	g.current.UpdatedAt = time.Now().UTC()
}

func (g *ResourceGuard) handleContainerOOM(event ContainerOOMEvent) {
	if event.OccurredAt.IsZero() {
		event.OccurredAt = time.Now().UTC()
	}
	g.mu.Lock()
	eventCopy := event
	g.current.LastContainerOOM = &eventCopy
	g.current.UpdatedAt = event.OccurredAt
	g.mu.Unlock()

	g.emit(PressureEvent{
		Type:          PressureEventContainerOOM,
		Level:         PressureLevelCritical,
		Message:       "container OOM detected",
		WorkspaceID:   event.WorkspaceID,
		ContainerID:   event.ContainerID,
		ContainerName: event.ContainerName,
		OccurredAt:    event.OccurredAt,
	})
}

func (g *ResourceGuard) emit(event PressureEvent) {
	select {
	case g.pressureEvents <- event:
	default:
		g.logger.Warn("resourcemon: dropping pressure event because channel is full",
			"type", event.Type,
			"level", event.Level,
			"workspaceId", event.WorkspaceID,
			"containerId", event.ContainerID,
		)
	}
}

// PressureEvents returns the active pressure event channel.
func (g *ResourceGuard) PressureEvents() <-chan PressureEvent {
	return g.pressureEvents
}

// CurrentPressure returns the latest unified resource pressure snapshot.
func (g *ResourceGuard) CurrentPressure() ResourcePressure {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return cloneResourcePressure(g.current)
}

// PressureLevel returns the latest system pressure level.
func (g *ResourceGuard) PressureLevel() PressureLevel {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.current.Level
}

// Close stops active monitoring and cleans up the Docker event subprocess.
func (g *ResourceGuard) Close() error {
	var err error
	g.closeOnce.Do(func() {
		if g.cancel != nil {
			g.cancel()
		}
		if g.dockerEvents != nil {
			err = g.dockerEvents.Close()
		}
		g.wg.Wait()
		close(g.pressureEvents)
	})
	return err
}

func cloneResourcePressure(input ResourcePressure) ResourcePressure {
	output := input
	output.Containers = cloneContainerMetrics(input.Containers)
	if input.LastContainerOOM != nil {
		eventCopy := *input.LastContainerOOM
		output.LastContainerOOM = &eventCopy
	}
	return output
}

func cloneContainerMetrics(input []ContainerMetric) []ContainerMetric {
	if len(input) == 0 {
		return nil
	}
	output := make([]ContainerMetric, len(input))
	copy(output, input)
	return output
}
