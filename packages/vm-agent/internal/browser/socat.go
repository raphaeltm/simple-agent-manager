package browser

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"
)

// socatPollLoop periodically syncs socat forwarders with DevContainer's detected ports.
func (m *Manager) socatPollLoop(ctx context.Context, workspaceID string) {
	ticker := time.NewTicker(m.cfg.NekoSocatPollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.syncForwarders(ctx, workspaceID)
		}
	}
}

// syncForwarders detects ports on the DevContainer and updates socat forwarders.
func (m *Manager) syncForwarders(ctx context.Context, workspaceID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	state, ok := m.sidecars[workspaceID]
	if !ok || state.Status != StatusRunning {
		return
	}

	// Detect listening ports on the DevContainer by inspecting /proc/net/tcp
	detectedPorts, err := m.detectContainerPorts(ctx, state.TargetHost)
	if err != nil {
		slog.Debug("Failed to detect DevContainer ports for socat sync",
			"workspace", workspaceID,
			"error", err,
		)
		return
	}

	// Build sets for diff
	desired := make(map[int]bool, len(detectedPorts))
	for _, p := range detectedPorts {
		desired[p] = true
	}

	current := make(map[int]bool, len(state.Forwarders))
	for _, f := range state.Forwarders {
		current[f.Port] = true
	}

	// Add forwarders for new ports
	for port := range desired {
		if !current[port] {
			if err := m.addForwarder(ctx, state.ContainerName, port, state.TargetHost); err != nil {
				slog.Warn("Failed to add socat forwarder",
					"workspace", workspaceID,
					"port", port,
					"error", err,
				)
				continue
			}
			state.Forwarders = append(state.Forwarders, PortForwarder{
				Port:       port,
				TargetHost: state.TargetHost,
				Active:     true,
			})
			slog.Info("Added socat forwarder", "workspace", workspaceID, "port", port, "target", state.TargetHost)
		}
	}

	// Remove forwarders for gone ports
	remaining := state.Forwarders[:0]
	for _, f := range state.Forwarders {
		if !desired[f.Port] {
			if err := m.removeForwarder(ctx, state.ContainerName, f.Port); err != nil {
				slog.Warn("Failed to remove socat forwarder",
					"workspace", workspaceID,
					"port", f.Port,
					"error", err,
				)
			} else {
				slog.Info("Removed socat forwarder", "workspace", workspaceID, "port", f.Port)
			}
			continue
		}
		remaining = append(remaining, f)
	}
	state.Forwarders = remaining
}

// SyncForwardersFromPorts updates socat forwarders to match a given set of ports.
// This is the externally-callable version that takes a pre-detected port list.
func (m *Manager) SyncForwardersFromPorts(ctx context.Context, workspaceID string, ports []int) {
	m.mu.Lock()
	defer m.mu.Unlock()

	state, ok := m.sidecars[workspaceID]
	if !ok || state.Status != StatusRunning {
		return
	}

	desired := make(map[int]bool, len(ports))
	for _, p := range ports {
		desired[p] = true
	}

	current := make(map[int]bool, len(state.Forwarders))
	for _, f := range state.Forwarders {
		current[f.Port] = true
	}

	// Add new
	for _, port := range ports {
		if !current[port] {
			if err := m.addForwarder(ctx, state.ContainerName, port, state.TargetHost); err != nil {
				slog.Warn("Failed to add socat forwarder", "workspace", workspaceID, "port", port, "error", err)
				continue
			}
			state.Forwarders = append(state.Forwarders, PortForwarder{
				Port:       port,
				TargetHost: state.TargetHost,
				Active:     true,
			})
		}
	}

	// Remove stale
	remaining := state.Forwarders[:0]
	for _, f := range state.Forwarders {
		if !desired[f.Port] {
			_ = m.removeForwarder(ctx, state.ContainerName, f.Port)
			continue
		}
		remaining = append(remaining, f)
	}
	state.Forwarders = remaining
}

// addForwarder starts a socat process inside the Neko container to forward a port.
func (m *Manager) addForwarder(ctx context.Context, containerName string, port int, targetHost string) error {
	// Run socat in background inside the Neko container.
	// socat listens on localhost:<port> and forwards to the DevContainer.
	cmd := fmt.Sprintf("socat TCP-LISTEN:%d,fork,reuseaddr TCP:%s:%d &", port, targetHost, port)
	return m.docker.RunSilent(ctx,
		"exec", "-d", containerName,
		"sh", "-c", cmd,
	)
}

// removeForwarder kills the socat process for a specific port inside the Neko container.
func (m *Manager) removeForwarder(ctx context.Context, containerName string, port int) error {
	// Find and kill socat processes listening on this port.
	cmd := fmt.Sprintf("pkill -f 'socat TCP-LISTEN:%d' || true", port)
	return m.docker.RunSilent(ctx,
		"exec", containerName,
		"sh", "-c", cmd,
	)
}

// detectContainerPorts reads /proc/net/tcp from the DevContainer to find listening ports.
func (m *Manager) detectContainerPorts(ctx context.Context, containerName string) ([]int, error) {
	out, err := m.docker.Run(ctx, "exec", containerName, "cat", "/proc/net/tcp")
	if err != nil {
		return nil, fmt.Errorf("failed to read /proc/net/tcp: %w", err)
	}

	return parseProcNetTCP(string(out)), nil
}

// parseProcNetTCP parses /proc/net/tcp output to extract listening port numbers.
// Lines with state 0A (LISTEN) have their local address port extracted.
func parseProcNetTCP(data string) []int {
	var ports []int
	seen := make(map[int]bool)

	for _, line := range strings.Split(data, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}

		// State field (index 3) must be "0A" (LISTEN)
		if fields[3] != "0A" {
			continue
		}

		// Local address field (index 1) is "ADDR:PORT" in hex
		localAddr := fields[1]
		parts := strings.SplitN(localAddr, ":", 2)
		if len(parts) != 2 {
			continue
		}

		portHex := parts[1]
		port64, err := strconv.ParseInt(portHex, 16, 32)
		if err != nil {
			continue
		}
		port := int(port64)

		// Skip well-known system ports and ephemeral range
		if port <= 0 || port >= 32768 {
			continue
		}

		if !seen[port] {
			seen[port] = true
			ports = append(ports, port)
		}
	}

	return ports
}
