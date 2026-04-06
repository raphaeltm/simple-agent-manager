// Package browser manages Neko browser sidecar containers for workspaces.
// Each workspace can have at most one Neko sidecar running alongside its DevContainer,
// connected to the same Docker network with socat port forwarders bridging localhost.
package browser

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"sync"

	"github.com/workspace/vm-agent/internal/config"
)

// safeNetworkName validates Docker network names to prevent Go template injection.
var safeNetworkName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`)

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
	BridgeIP      string // Cached Neko container bridge IP (stable for container lifetime)
	Password      string // Per-container random password for Neko viewer
	PasswordAdmin string // Per-container random password for Neko admin
	Resolution    string // Screen resolution the container was started with (e.g. "375x667")
}

// StartOptions configures sidecar creation.
type StartOptions struct {
	ViewportWidth    int
	ViewportHeight   int
	DevicePixelRatio int
	IsTouchDevice    bool
	EnableAudio      *bool  // nil = use config default
	UserAgent        string // Custom user-agent string for Chrome (empty = default)
	StartURL         string // URL to open on Chrome startup (empty = about:blank)
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

// RecoverOrphanedContainers removes stale Neko containers from prior agent runs.
// Should be called once at startup before accepting requests.
func (m *Manager) RecoverOrphanedContainers(ctx context.Context) {
	out, err := m.docker.Run(ctx, "ps", "-a", "--filter", "name=neko-", "--format", "{{.Names}}")
	if err != nil {
		slog.Warn("Failed to list orphaned Neko containers", "error", err)
		return
	}
	names := strings.Split(strings.TrimSpace(string(out)), "\n")
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		slog.Info("Removing orphaned Neko container", "container", name)
		if err := m.docker.RunSilent(ctx, "rm", "-f", name); err != nil {
			slog.Warn("Failed to remove orphaned Neko container", "container", name, "error", err)
		}
	}
}

// Start creates and starts a Neko sidecar for a workspace.
// The mutex is released during Docker I/O to avoid blocking other operations.
func (m *Manager) Start(ctx context.Context, workspaceID, networkName, devContainerName, devContainerIP string, opts StartOptions) (*SidecarState, error) {
	m.mu.Lock()

	if existing, ok := m.sidecars[workspaceID]; ok {
		if existing.Status == StatusRunning {
			// Check if the requested resolution differs from the running container.
			// The Neko virtual display resolution (NEKO_SCREEN) is set at container
			// creation time and cannot be changed without restarting the container.
			requestedResolution := m.cfg.NekoScreenResolution
			if opts.ViewportWidth > 0 && opts.ViewportHeight > 0 {
				requestedResolution = fmt.Sprintf("%dx%d", opts.ViewportWidth, opts.ViewportHeight)
			}
			if existing.Resolution != "" && existing.Resolution != requestedResolution {
				slog.Info("Viewport changed — restarting Neko sidecar",
					"workspace", workspaceID,
					"oldResolution", existing.Resolution,
					"newResolution", requestedResolution,
				)
				containerName := existing.ContainerName
				// Cancel poll loop
				if cancel, ok := m.stopPolls[workspaceID]; ok {
					cancel()
					delete(m.stopPolls, workspaceID)
				}
				delete(m.sidecars, workspaceID)
				m.mu.Unlock()

				// Remove old container (without holding lock)
				_ = m.docker.RunSilent(ctx, "rm", "-f", containerName)

				// Re-enter Start to create fresh container with new resolution
				return m.Start(ctx, workspaceID, networkName, devContainerName, devContainerIP, opts)
			}

			cp := *existing
			m.mu.Unlock()
			return &cp, nil
		}
		// If already starting or in error, allow re-start
		if existing.Status == StatusStarting {
			cp := *existing
			m.mu.Unlock()
			return &cp, fmt.Errorf("browser sidecar is already starting for workspace %s", workspaceID)
		}
	}

	containerName := nekoContainerName(workspaceID)

	// Generate per-container random passwords for defense-in-depth
	password, err := generateRandomPassword(32)
	if err != nil {
		m.mu.Unlock()
		return &SidecarState{Status: StatusError, Error: "failed to generate Neko password"}, fmt.Errorf("failed to generate Neko password: %w", err)
	}
	passwordAdmin, err := generateRandomPassword(32)
	if err != nil {
		m.mu.Unlock()
		return &SidecarState{Status: StatusError, Error: "failed to generate Neko admin password"}, fmt.Errorf("failed to generate Neko admin password: %w", err)
	}

	// Build Neko container config
	resolution := m.cfg.NekoScreenResolution
	if opts.ViewportWidth > 0 && opts.ViewportHeight > 0 {
		resolution = fmt.Sprintf("%dx%d", opts.ViewportWidth, opts.ViewportHeight)
	}

	state := &SidecarState{
		Status:        StatusStarting,
		ContainerName: containerName,
		NekoPort:      m.cfg.NekoWebRTCPort,
		NetworkName:   networkName,
		TargetHost:    devContainerName,
		Password:      password,
		PasswordAdmin: passwordAdmin,
		Resolution:    resolution,
	}
	m.sidecars[workspaceID] = state

	enableAudio := m.cfg.NekoEnableAudio
	if opts.EnableAudio != nil {
		enableAudio = *opts.EnableAudio
	}

	// Resolve public IP for WebRTC NAT traversal
	nat1to1 := m.cfg.NekoNAT1TO1
	if nat1to1 == "" {
		if detectedIP, err := DetectPublicIP(); err == nil {
			nat1to1 = detectedIP
			slog.Info("Auto-detected public IP for Neko WebRTC", "ip", nat1to1)
		} else {
			slog.Warn("Failed to auto-detect public IP for Neko NAT1TO1 — WebRTC may not connect", "error", err)
		}
	}

	env := buildNekoEnvFromOpts(NekoEnvOptions{
		Resolution:    resolution,
		MaxFPS:        m.cfg.NekoMaxFPS,
		NekoPort:      m.cfg.NekoWebRTCPort,
		Password:      password,
		PasswordAdmin: passwordAdmin,
		EnableAudio:   enableAudio,
		TCPFallback:   m.cfg.NekoTCPFallback,
		NAT1TO1:       nat1to1,
		MuxPort:       m.cfg.NekoMuxPort,
	})

	limits := ResourceLimits{
		MemoryLimit: m.cfg.NekoMemoryLimit,
		CPULimit:    m.cfg.NekoCPULimit,
		PidsLimit:   m.cfg.NekoPidsLimit,
	}
	args := buildDockerRunArgsFromOpts(DockerRunOptions{
		ContainerName:    containerName,
		Image:            m.cfg.NekoImage,
		NetworkName:      networkName,
		ShmSize:          m.cfg.NekoShmSize,
		NekoPort:         m.cfg.NekoWebRTCPort,
		MuxPort:          m.cfg.NekoMuxPort,
		EnvVars:          env,
		Limits:           limits,
		DevContainerName: devContainerName,
		DevContainerIP:   devContainerIP,
	})

	// Release lock during Docker I/O
	m.mu.Unlock()

	if err := m.docker.RunSilent(ctx, args...); err != nil {
		// Deferred cleanup: remove the container if it was partially created
		_ = m.docker.RunSilent(ctx, "rm", "-f", containerName)

		m.mu.Lock()
		if s, ok := m.sidecars[workspaceID]; ok && s == state {
			state.Status = StatusError
			state.Error = fmt.Sprintf("failed to create Neko container: %v", err)
		}
		cp := *state
		m.mu.Unlock()

		slog.Error("Failed to start Neko sidecar", "workspace", workspaceID, "error", err)
		return &cp, fmt.Errorf("failed to start Neko container: %w", err)
	}

	// Ensure socat is available inside Neko container for port forwarding.
	// The default Neko images don't ship with socat, so install it on first start.
	if installErr := m.docker.RunSilent(ctx, "exec", containerName, "sh", "-c",
		"command -v socat >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y --no-install-recommends socat >/dev/null 2>&1)"); installErr != nil {
		slog.Warn("Failed to install socat in Neko container — port forwarding may not work",
			"workspace", workspaceID, "error", installErr)
	} else {
		slog.Info("socat available in Neko container", "workspace", workspaceID)
	}

	// Run an initial port sync BEFORE Chrome customization. This ensures socat
	// forwarders are established and tracked in state before Chrome opens the
	// startURL. The pre-seed in applyChromeCustomization is removed — this
	// initial sync handles it properly with state tracking.
	m.mu.Lock()
	if s, ok := m.sidecars[workspaceID]; ok && s == state {
		state.Status = StatusRunning
		state.TargetHost = devContainerName
	}
	m.mu.Unlock()
	m.syncForwarders(ctx, workspaceID)

	// Apply Chrome customization: disable extensions (SponsorBlock, uBlock),
	// suppress first-run prompts, set startup URL, user agent, and touch mode.
	customization := ChromeCustomization{
		UserAgent:        opts.UserAgent,
		StartURL:         opts.StartURL,
		IsTouchDevice:    opts.IsTouchDevice,
		DevicePixelRatio: opts.DevicePixelRatio,
		ViewportWidth:    opts.ViewportWidth,
		ViewportHeight:   opts.ViewportHeight,
	}
	if customErr := applyChromeCustomization(ctx, m.docker, containerName, customization); customErr != nil {
		slog.Warn("Failed to apply Chrome customization — browser may show extension popups",
			"workspace", workspaceID, "error", customErr)
	}

	// Get the container ID
	out, inspectErr := m.docker.Run(ctx, "inspect", "-f", "{{.Id}}", containerName)

	// Re-acquire lock to update final state
	m.mu.Lock()
	if s, ok := m.sidecars[workspaceID]; ok && s == state {
		if inspectErr == nil {
			state.ContainerID = trimOutput(out)
		} else {
			slog.Warn("Failed to inspect Neko container ID", "workspace", workspaceID, "error", inspectErr)
		}
		state.Status = StatusRunning

		// Start socat port sync loop
		pollCtx, cancel := context.WithCancel(context.Background())
		m.stopPolls[workspaceID] = cancel
		go m.socatPollLoop(pollCtx, workspaceID)
	}
	cp := *state
	cp.Forwarders = make([]PortForwarder, len(state.Forwarders))
	copy(cp.Forwarders, state.Forwarders)
	m.mu.Unlock()

	slog.Info("Neko browser sidecar started",
		"workspace", workspaceID,
		"container", containerName,
		"network", networkName,
		"resolution", resolution,
	)

	return &cp, nil
}

// Stop removes the Neko sidecar for a workspace.
// The mutex is released during Docker I/O to avoid blocking other operations.
func (m *Manager) Stop(ctx context.Context, workspaceID string) error {
	m.mu.Lock()
	state, ok := m.sidecars[workspaceID]
	if !ok {
		m.mu.Unlock()
		return nil // nothing to stop
	}

	// Cancel poll loop
	if cancel, ok := m.stopPolls[workspaceID]; ok {
		cancel()
		delete(m.stopPolls, workspaceID)
	}

	state.Status = StatusStopping
	containerName := state.ContainerName

	// Release lock during Docker I/O
	m.mu.Unlock()

	// Force-remove the container (and all socat processes with it)
	if err := m.docker.RunSilent(ctx, "rm", "-f", containerName); err != nil {
		slog.Warn("Failed to remove Neko container", "workspace", workspaceID, "container", containerName, "error", err)
	}

	// Re-acquire lock to clean up map entry
	m.mu.Lock()
	delete(m.sidecars, workspaceID)
	m.mu.Unlock()

	slog.Info("Neko browser sidecar stopped", "workspace", workspaceID)
	return nil
}

// Cleanup stops and removes all sidecars. Called on server shutdown.
// Collects container names under lock, then removes them without holding the lock.
func (m *Manager) Cleanup(ctx context.Context) {
	m.mu.Lock()
	// Cancel all poll loops and collect container names
	toRemove := make(map[string]string) // workspaceID -> containerName
	for wsID, state := range m.sidecars {
		if cancel, ok := m.stopPolls[wsID]; ok {
			cancel()
		}
		state.Status = StatusStopping
		toRemove[wsID] = state.ContainerName
	}
	m.stopPolls = make(map[string]context.CancelFunc)
	m.mu.Unlock()

	// Remove containers without holding the lock
	for wsID, containerName := range toRemove {
		if err := m.docker.RunSilent(ctx, "rm", "-f", containerName); err != nil {
			slog.Warn("Failed to remove Neko container during cleanup", "workspace", wsID, "container", containerName, "error", err)
		}
	}

	// Final cleanup of the map
	m.mu.Lock()
	for wsID := range toRemove {
		delete(m.sidecars, wsID)
	}
	m.mu.Unlock()
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

// GetNekoBridgeIP returns the Docker bridge IP of the Neko container for a workspace.
// This is used by the browser proxy to forward HTTP traffic to the Neko container.
// The IP is cached in SidecarState after the first successful lookup since it is
// stable for the container's lifetime.
func (m *Manager) GetNekoBridgeIP(ctx context.Context, workspaceID string) (string, int, error) {
	m.mu.RLock()
	state, ok := m.sidecars[workspaceID]
	if !ok || state.Status != StatusRunning {
		m.mu.RUnlock()
		return "", 0, fmt.Errorf("no running browser sidecar for workspace %s", workspaceID)
	}
	// Return cached IP if available (stable for container lifetime)
	if state.BridgeIP != "" {
		ip, port := state.BridgeIP, state.NekoPort
		m.mu.RUnlock()
		return ip, port, nil
	}
	containerName := state.ContainerName
	networkName := state.NetworkName
	nekoPort := state.NekoPort
	m.mu.RUnlock()

	// Validate network name to prevent Go template injection via crafted Docker network names.
	if !safeNetworkName.MatchString(networkName) {
		return "", 0, fmt.Errorf("invalid Docker network name %q for workspace %s", networkName, workspaceID)
	}

	// Use the known network name to extract exactly one IP, avoiding concatenation
	// when the container is attached to multiple networks.
	template := fmt.Sprintf(`{{(index .NetworkSettings.Networks "%s").IPAddress}}`, networkName)
	out, err := m.docker.Run(ctx, "inspect", "-f", template, containerName)
	if err != nil {
		return "", 0, fmt.Errorf("failed to inspect Neko container %s: %w", containerName, err)
	}
	ip := trimOutput(out)
	if ip == "" {
		return "", 0, fmt.Errorf("Neko container %s has no bridge IP on network %s", containerName, networkName)
	}

	// Cache the IP under write lock
	m.mu.Lock()
	if s, ok := m.sidecars[workspaceID]; ok && s == state {
		state.BridgeIP = ip
	}
	m.mu.Unlock()

	return ip, nekoPort, nil
}

// DockerExec returns the underlying Docker executor (used by handlers for network discovery).
func (m *Manager) DockerExec() DockerExecutor {
	return m.docker
}

// nekoContainerName generates a deterministic container name for a workspace's sidecar.
func nekoContainerName(workspaceID string) string {
	return fmt.Sprintf("neko-%s", workspaceID)
}
