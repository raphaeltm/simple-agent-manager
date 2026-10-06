package resourcemon

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/container"
)

const (
	DockerWorkspaceIDLabel = "sam.workspace.id"
	DockerOOMExitCode      = "137"
	dockerCommandSafePath  = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
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
	OnContainerOOM    func(workspaceID, containerID string)
	CommandFactory    DockerEventCommandFactory
	EventBuffer       int
	Logger            *slog.Logger
	ReconnectInterval time.Duration
}

// DockerEventSubscriber subscribes to Docker CLI events and emits OOM events.
type DockerEventSubscriber struct {
	onContainerOOM func(workspaceID, containerID string)
	commandFactory DockerEventCommandFactory
	logger         *slog.Logger

	events chan ContainerOOMEvent
	cancel context.CancelFunc
	done   chan struct{}

	started           bool
	closed            bool
	closeMu           sync.Mutex
	reconnectInterval time.Duration
}

// NewDockerEventSubscriber creates a CLI-backed Docker event subscriber.
func NewDockerEventSubscriber(cfg DockerEventSubscriberConfig) *DockerEventSubscriber {
	if cfg.CommandFactory == nil {
		cfg.CommandFactory = defaultDockerEventCommand
	}
	if cfg.EventBuffer <= 0 {
		cfg.EventBuffer = config.DefaultResourceEventBufferSize
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.ReconnectInterval <= 0 {
		cfg.ReconnectInterval = time.Duration(config.DefaultPSIPollIntervalSeconds) * time.Second
	}
	return &DockerEventSubscriber{
		onContainerOOM:    cfg.OnContainerOOM,
		reconnectInterval: cfg.ReconnectInterval,
		commandFactory:    cfg.CommandFactory,
		logger:            cfg.Logger,
		events:            make(chan ContainerOOMEvent, cfg.EventBuffer),
		done:              make(chan struct{}),
	}
}

func defaultDockerEventCommand(ctx context.Context) *exec.Cmd {
	cmd := exec.CommandContext(ctx,
		container.DockerCLIPath(),
		"events",
		"--filter", "event=oom",
		"--filter", "event=die",
		"--format", "{{json .}}",
	)
	cmd.Env = append(os.Environ(), dockerCommandSafePath)
	return cmd
}

// Start launches the long-running docker events subprocess.
func (s *DockerEventSubscriber) Start(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	s.closeMu.Lock()
	defer s.closeMu.Unlock()
	if s.closed {
		return errors.New("Docker event subscriber is closed")
	}
	if s.started {
		return nil
	}
	runCtx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	s.started = true
	go s.run(runCtx)
	return nil
}

// run supervises the stream, including Docker missing during initial bootstrap.
// Reconnects are paced by configuration so daemon failures cannot spin the agent.
func (s *DockerEventSubscriber) run(ctx context.Context) {
	defer close(s.done)
	defer close(s.events)
	for ctx.Err() == nil {
		if err := s.consumeStream(ctx); err != nil && ctx.Err() == nil {
			s.logger.Warn("resourcemon: Docker event stream unavailable; reconnecting", "error", err)
		}
		timer := time.NewTimer(s.reconnectInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (s *DockerEventSubscriber) consumeStream(ctx context.Context) error {
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := s.commandFactory(streamCtx)
	// No raw Docker stderr is retained: a long-running error stream must not
	// grow an unbounded in-memory buffer on a memory-constrained host.
	cmd.Stderr = io.Discard
	cmd.WaitDelay = s.reconnectInterval
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("Docker events stdout pipe: %w", err)
	}
	defer stdout.Close()
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start Docker events: %w", err)
	}
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		event, ok, parseErr := ParseDockerOOMEvent(scanner.Text())
		if parseErr != nil || !ok {
			continue
		}
		if s.onContainerOOM != nil {
			s.onContainerOOM(event.WorkspaceID, event.ContainerID)
		}
		select {
		case s.events <- event:
		default:
			s.logger.Warn("resourcemon: dropping Docker OOM event because channel is full",
				"containerId", event.ContainerID)
		}
	}
	// A malformed oversized line must kill the reader's subprocess before
	// waiting; otherwise Docker may block forever writing to an unread pipe.
	cancel()
	waitErr := cmd.Wait()
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read Docker events: %w", err)
	}
	return waitErr
}

// Events returns parsed container OOM events until Close, including reconnects.
func (s *DockerEventSubscriber) Events() <-chan ContainerOOMEvent {
	return s.events
}

// Close stops the Docker events subprocess and any pending reconnect.
func (s *DockerEventSubscriber) Close() error {
	s.closeMu.Lock()
	s.closed = true
	started := s.started
	if s.cancel != nil {
		s.cancel()
	}
	s.closeMu.Unlock()
	if started {
		<-s.done
	}
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
