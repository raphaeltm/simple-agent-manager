// Package browser manages Neko browser sidecar containers for workspaces.
// Each workspace can have at most one Neko sidecar running alongside its DevContainer,
// connected to the same Docker network with socat port forwarders bridging localhost.
package browser

import (
	"context"
	"fmt"
	"log/slog"
	"sync"

	"github.com/workspace/vm-agent/internal/config"
)

// Status represents the lifecycle state of a browser sidecar.
type Status string

const (
	StatusOff      Status = "off"
	StatusStarting Status = "starting"
	StatusRunning  Status = "running"
	StatusStopping Status = "stopping"
	StatusError    Status = "error"
)

// PortForwarder tracks a single socat forwarder inside the Neko container.
type PortForwarder struct {
	Port       int    `json:"port"`
	TargetHost string `json:"targetHost"`
	Active     bool   `json:"active"`
}

// SidecarState holds the runtime state of a single browser sidecar.
type SidecarState struct {
	Status        Status
	ContainerName string
	ContainerID   string
	NekoPort      int
	Error         string
	Forwarders    []PortForwarder
	NetworkName   string
	TargetHost    string // DevContainer hostname on the Docker network
}

// StartOptions configures sidecar creation.
type StartOptions struct {
	ViewportWidth    int
	ViewportHeight   int
	DevicePixelRatio int
	IsTouchDevice    bool
	EnableAudio      *bool // nil = use config default
}

// Manager manages Neko browser sidecar containers for all workspaces.
type Manager struct {
	cfg       *config.Config
	mu        sync.RWMutex
	sidecars  map[string]*SidecarState // keyed by workspaceID
	stopPolls map[string]context.CancelFunc
	docker    DockerExecutor
}

// DockerExecutor abstracts Docker CLI commands for testability.
type DockerExecutor interface {
	// Run executes a docker command and returns combined output.
	Run(ctx context.Context, args ...string) ([]byte, error)
	// RunSilent executes a docker command, returning only the error.
	RunSilent(ctx context.Context, args ...string) error
}

// NewManager creates a browser sidecar manager.
func NewManager(cfg *config.Config, docker DockerExecutor) *Manager {
	return &Manager{
		cfg:       cfg,
		sidecars:  make(map[string]*SidecarState),
		stopPolls: make(map[string]context.CancelFunc),
		docker:    docker,
	}
}

// Start creates and starts a Neko sidecar for a workspace.
func (m *Manager) Start(ctx context.Context, workspaceID, networkName, devContainerName string, opts StartOptions) (*SidecarState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.sidecars[workspaceID]; ok && existing.Status == StatusRunning {
		return existing, nil
	}

	containerName := nekoContainerName(workspaceID)
	state := &SidecarState{
		Status:        StatusStarting,
		ContainerName: containerName,
		NekoPort:      m.cfg.NekoWebRTCPort,
		NetworkName:   networkName,
		TargetHost:    devContainerName,
	}
	m.sidecars[workspaceID] = state

	// Build Neko container config
	resolution := m.cfg.NekoScreenResolution
	if opts.ViewportWidth > 0 && opts.ViewportHeight > 0 {
		resolution = fmt.Sprintf("%dx%d", opts.ViewportWidth, opts.ViewportHeight)
	}

	enableAudio := m.cfg.NekoEnableAudio
	if opts.EnableAudio != nil {
		enableAudio = *opts.EnableAudio
	}

	env := buildNekoEnv(resolution, m.cfg.NekoMaxFPS, enableAudio, m.cfg.NekoTCPFallback)

	// Create and start the container
	args := buildDockerRunArgs(containerName, m.cfg.NekoImage, networkName, m.cfg.NekoWebRTCPort, env)
	if err := m.docker.RunSilent(ctx, args...); err != nil {
		state.Status = StatusError
		state.Error = fmt.Sprintf("failed to create Neko container: %v", err)
		slog.Error("Failed to start Neko sidecar", "workspace", workspaceID, "error", err)
		return state, fmt.Errorf("failed to start Neko container: %w", err)
	}

	// Get the container ID
	out, err := m.docker.Run(ctx, "inspect", "-f", "{{.Id}}", containerName)
	if err == nil {
		state.ContainerID = trimOutput(out)
	}

	state.Status = StatusRunning

	// Start socat port sync loop
	pollCtx, cancel := context.WithCancel(context.Background())
	m.stopPolls[workspaceID] = cancel
	go m.socatPollLoop(pollCtx, workspaceID)

	slog.Info("Neko browser sidecar started",
		"workspace", workspaceID,
		"container", containerName,
		"network", networkName,
		"resolution", resolution,
	)

	return state, nil
}

// Stop removes the Neko sidecar for a workspace.
func (m *Manager) Stop(ctx context.Context, workspaceID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	return m.stopLocked(ctx, workspaceID)
}

func (m *Manager) stopLocked(ctx context.Context, workspaceID string) error {
	state, ok := m.sidecars[workspaceID]
	if !ok {
		return nil // nothing to stop
	}

	// Cancel poll loop
	if cancel, ok := m.stopPolls[workspaceID]; ok {
		cancel()
		delete(m.stopPolls, workspaceID)
	}

	state.Status = StatusStopping

	// Force-remove the container (and all socat processes with it)
	if err := m.docker.RunSilent(ctx, "rm", "-f", state.ContainerName); err != nil {
		slog.Warn("Failed to remove Neko container", "workspace", workspaceID, "container", state.ContainerName, "error", err)
	}

	delete(m.sidecars, workspaceID)

	slog.Info("Neko browser sidecar stopped", "workspace", workspaceID)
	return nil
}

// Cleanup stops and removes all sidecars. Called on server shutdown.
func (m *Manager) Cleanup(ctx context.Context) {
	m.mu.Lock()
	defer m.mu.Unlock()

	for wsID := range m.sidecars {
		_ = m.stopLocked(ctx, wsID)
	}
}

// GetStatus returns the current state of a workspace's browser sidecar.
func (m *Manager) GetStatus(workspaceID string) *SidecarState {
	m.mu.RLock()
	defer m.mu.RUnlock()

	state, ok := m.sidecars[workspaceID]
	if !ok {
		return &SidecarState{Status: StatusOff}
	}
	// Return a copy to avoid races
	cp := *state
	cp.Forwarders = make([]PortForwarder, len(state.Forwarders))
	copy(cp.Forwarders, state.Forwarders)
	return &cp
}

// GetPorts returns the active socat forwarders for a workspace's sidecar.
func (m *Manager) GetPorts(workspaceID string) []PortForwarder {
	m.mu.RLock()
	defer m.mu.RUnlock()

	state, ok := m.sidecars[workspaceID]
	if !ok {
		return nil
	}
	result := make([]PortForwarder, len(state.Forwarders))
	copy(result, state.Forwarders)
	return result
}

// DockerExec returns the underlying Docker executor (used by handlers for network discovery).
func (m *Manager) DockerExec() DockerExecutor {
	return m.docker
}

// nekoContainerName generates a deterministic container name for a workspace's sidecar.
func nekoContainerName(workspaceID string) string {
	return fmt.Sprintf("neko-%s", workspaceID)
}
