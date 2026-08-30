package resourcemon

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	DockerWorkspaceIDLabel = "sam.workspace.id"
	DockerOOMExitCode      = "137"
)

// ContainerOOMEvent is emitted when Docker reports a container OOM or die-137 event.
type ContainerOOMEvent struct {
	WorkspaceID   string    `json:"workspaceId,omitempty"`
	ContainerID   string    `json:"containerId"`
	ContainerName string    `json:"containerName,omitempty"`
	Action        string    `json:"action"`
	ExitCode      string    `json:"exitCode,omitempty"`
	OccurredAt    time.Time `json:"occurredAt"`
}

// DockerEventCommandFactory creates the docker events command. It exists for tests.
type DockerEventCommandFactory func(ctx context.Context) *exec.Cmd

// DockerEventSubscriberConfig configures a DockerEventSubscriber.
type DockerEventSubscriberConfig struct {
	OnContainerOOM func(workspaceID, containerID string)
	CommandFactory DockerEventCommandFactory
	EventBuffer    int
	Logger         *slog.Logger
}

// DockerEventSubscriber subscribes to Docker CLI events and emits OOM events.
type DockerEventSubscriber struct {
	onContainerOOM func(workspaceID, containerID string)
	commandFactory DockerEventCommandFactory
	logger         *slog.Logger

	events chan ContainerOOMEvent
	cancel context.CancelFunc
	done   chan struct{}

	started atomic.Bool
	closeMu sync.Mutex
}

// NewDockerEventSubscriber creates a CLI-backed Docker event subscriber.
func NewDockerEventSubscriber(cfg DockerEventSubscriberConfig) *DockerEventSubscriber {
	if cfg.CommandFactory == nil {
		cfg.CommandFactory = defaultDockerEventCommand
	}
	if cfg.EventBuffer <= 0 {
		cfg.EventBuffer = 16
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &DockerEventSubscriber{
		onContainerOOM: cfg.OnContainerOOM,
		commandFactory: cfg.CommandFactory,
		logger:         cfg.Logger,
		events:         make(chan ContainerOOMEvent, cfg.EventBuffer),
		done:           make(chan struct{}),
	}
}

func defaultDockerEventCommand(ctx context.Context) *exec.Cmd {
	return exec.CommandContext(ctx,
		"docker",
		"events",
		"--filter", "event=oom",
		"--filter", "event=die",
		"--format", "{{json .}}",
	)
}

// Start launches the long-running docker events subprocess.
func (s *DockerEventSubscriber) Start(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if !s.started.CompareAndSwap(false, true) {
		return nil
	}

	runCtx, cancel := context.WithCancel(ctx)
	s.closeMu.Lock()
	s.cancel = cancel
	s.closeMu.Unlock()

	cmd := s.commandFactory(runCtx)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		s.started.Store(false)
		return fmt.Errorf("docker events stdout pipe: %w", err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		cancel()
		s.started.Store(false)
		return fmt.Errorf("start docker events: %w", err)
	}

	go s.run(runCtx, stdout, cmd, &stderr)
	return nil
}

func (s *DockerEventSubscriber) run(ctx context.Context, stdout io.Reader, cmd *exec.Cmd, stderr *bytes.Buffer) {
	defer close(s.done)
	defer close(s.events)

	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		event, ok, err := ParseDockerOOMEvent(scanner.Text())
		if err != nil {
			s.logger.Debug("resourcemon: skipping unparseable Docker event", "error", err)
			continue
		}
		if !ok {
			continue
		}
		if s.onContainerOOM != nil {
			s.onContainerOOM(event.WorkspaceID, event.ContainerID)
		}
		select {
		case s.events <- event:
		default:
			s.logger.Warn("resourcemon: dropping Docker OOM event because channel is full",
				"workspaceId", event.WorkspaceID,
				"containerId", event.ContainerID,
			)
		}
	}

	if err := scanner.Err(); err != nil && !errors.Is(ctx.Err(), context.Canceled) {
		s.logger.Warn("resourcemon: Docker event stream read failed", "error", err)
	}
	if err := cmd.Wait(); err != nil && !errors.Is(ctx.Err(), context.Canceled) {
		s.logger.Warn("resourcemon: Docker event stream exited with error",
			"error", err,
			"stderr", strings.TrimSpace(stderr.String()),
		)
	}
}

// Events returns parsed container OOM events.
func (s *DockerEventSubscriber) Events() <-chan ContainerOOMEvent {
	return s.events
}

// Close stops the Docker events subprocess and waits for it to exit.
func (s *DockerEventSubscriber) Close() error {
	if !s.started.Load() {
		return nil
	}
	s.closeMu.Lock()
	cancel := s.cancel
	s.closeMu.Unlock()
	if cancel != nil {
		cancel()
	}
	<-s.done
	return nil
}

type dockerEventEnvelope struct {
	Status   string            `json:"status"`
	ID       string            `json:"id"`
	Type     string            `json:"Type"`
	Action   string            `json:"Action"`
	Actor    dockerEventActor  `json:"Actor"`
	Time     int64             `json:"time"`
	TimeNano int64             `json:"timeNano"`
	Attrs    map[string]string `json:"attrs"`
}

type dockerEventActor struct {
	ID         string            `json:"ID"`
	Attributes map[string]string `json:"Attributes"`
}

// ParseDockerOOMEvent parses a Docker event JSON line and returns true for OOM signals.
func ParseDockerOOMEvent(line string) (ContainerOOMEvent, bool, error) {
	line = strings.TrimSpace(line)
	if line == "" {
		return ContainerOOMEvent{}, false, nil
	}

	var raw dockerEventEnvelope
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return ContainerOOMEvent{}, false, err
	}
	if raw.Type != "" && strings.ToLower(raw.Type) != "container" {
		return ContainerOOMEvent{}, false, nil
	}

	action := strings.ToLower(firstNonEmpty(raw.Action, raw.Status))
	attributes := raw.Actor.Attributes
	if len(attributes) == 0 {
		attributes = raw.Attrs
	}
	exitCode := firstNonEmpty(
		attributes["exitCode"],
		attributes["exitcode"],
		attributes["ExitCode"],
	)

	isOOM := action == "oom" || (action == "die" && exitCode == DockerOOMExitCode)
	if !isOOM {
		return ContainerOOMEvent{}, false, nil
	}

	containerID := firstNonEmpty(raw.Actor.ID, raw.ID)
	event := ContainerOOMEvent{
		WorkspaceID:   attributes[DockerWorkspaceIDLabel],
		ContainerID:   containerID,
		ContainerName: firstNonEmpty(attributes["name"], attributes["containerName"]),
		Action:        action,
		ExitCode:      exitCode,
		OccurredAt:    dockerEventTime(raw.Time, raw.TimeNano),
	}
	return event, true, nil
}

func dockerEventTime(unixSeconds, unixNano int64) time.Time {
	if unixNano > 0 {
		return time.Unix(0, unixNano).UTC()
	}
	if unixSeconds > 0 {
		return time.Unix(unixSeconds, 0).UTC()
	}
	return time.Now().UTC()
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
