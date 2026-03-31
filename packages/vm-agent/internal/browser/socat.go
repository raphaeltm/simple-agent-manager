package browser

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// validHostnameRe matches safe Docker container hostnames (alphanumeric, hyphens, dots, underscores).
var validHostnameRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,253}$`)

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
// The mutex is only held briefly to read/write state — Docker I/O is performed unlocked.
func (m *Manager) syncForwarders(ctx context.Context, workspaceID string) {
	// Step 1: Copy state under short read lock
	m.mu.RLock()
	state, ok := m.sidecars[workspaceID]
	if !ok || state.Status != StatusRunning {
		m.mu.RUnlock()
		return
	}
	containerName := state.ContainerName
	targetHost := state.TargetHost
	currentForwarders := make([]PortForwarder, len(state.Forwarders))
	copy(currentForwarders, state.Forwarders)
	m.mu.RUnlock()

	// Step 2: Detect ports without any lock held (Docker I/O)
	detectedPorts, err := m.detectContainerPorts(ctx, targetHost)
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

	current := make(map[int]bool, len(currentForwarders))
	for _, f := range currentForwarders {
		current[f.Port] = true
	}

	// Step 3: Perform Docker I/O for add/remove without lock
	var added []PortForwarder
	for port := range desired {
		if !current[port] {
			if err := m.addForwarder(ctx, containerName, port, targetHost); err != nil {
				slog.Warn("Failed to add socat forwarder",
					"workspace", workspaceID,
					"port", port,
					"error", err,
				)
				continue
			}
			added = append(added, PortForwarder{
				Port:       port,
				TargetHost: targetHost,
				Active:     true,
			})
			slog.Info("Added socat forwarder", "workspace", workspaceID, "port", port, "target", targetHost)
		}
	}

	var removedPorts []int
	for _, f := range currentForwarders {
		if !desired[f.Port] {
			if err := m.removeForwarder(ctx, containerName, f.Port); err != nil {
				slog.Warn("Failed to remove socat forwarder",
					"workspace", workspaceID,
					"port", f.Port,
					"error", err,
				)
				// Keep the forwarder in state on failure to avoid duplicate socat processes
				continue
			}
			removedPorts = append(removedPorts, f.Port)
			slog.Info("Removed socat forwarder", "workspace", workspaceID, "port", f.Port)
		}
	}

	// Step 4: Re-acquire write lock to apply diff
	m.mu.Lock()
	defer m.mu.Unlock()

	// Re-check that state hasn't been replaced (e.g., workspace stopped while we did I/O)
	currentState, ok := m.sidecars[workspaceID]
	if !ok || currentState != state {
		return
	}

	// Build removed set for efficient filtering
	removedSet := make(map[int]bool, len(removedPorts))
	for _, p := range removedPorts {
		removedSet[p] = true
	}

	// Filter removed ports from current forwarders
	remaining := make([]PortForwarder, 0, len(state.Forwarders))
	for _, f := range state.Forwarders {
		if !removedSet[f.Port] {
			remaining = append(remaining, f)
		}
	}

	// Append added forwarders
	remaining = append(remaining, added...)
	state.Forwarders = remaining
}

// SyncForwardersFromPorts updates socat forwarders to match a given set of ports.
// This is the externally-callable version that takes a pre-detected port list.
func (m *Manager) SyncForwardersFromPorts(ctx context.Context, workspaceID string, ports []int) {
	// Step 1: Copy state under short read lock
	m.mu.RLock()
	state, ok := m.sidecars[workspaceID]
	if !ok || state.Status != StatusRunning {
		m.mu.RUnlock()
		return
	}
	containerName := state.ContainerName
	targetHost := state.TargetHost
	currentForwarders := make([]PortForwarder, len(state.Forwarders))
	copy(currentForwarders, state.Forwarders)
	m.mu.RUnlock()

	desired := make(map[int]bool, len(ports))
	for _, p := range ports {
		desired[p] = true
	}

	current := make(map[int]bool, len(currentForwarders))
	for _, f := range currentForwarders {
		current[f.Port] = true
	}

	// Step 2: Docker I/O unlocked
	var added []PortForwarder
	for _, port := range ports {
		if !current[port] {
			if err := m.addForwarder(ctx, containerName, port, targetHost); err != nil {
				slog.Warn("Failed to add socat forwarder", "workspace", workspaceID, "port", port, "error", err)
				continue
			}
			added = append(added, PortForwarder{
				Port:       port,
				TargetHost: targetHost,
				Active:     true,
			})
		}
	}

	var removedPorts []int
	for _, f := range currentForwarders {
		if !desired[f.Port] {
			if err := m.removeForwarder(ctx, containerName, f.Port); err != nil {
				slog.Warn("Failed to remove socat forwarder", "workspace", workspaceID, "port", f.Port, "error", err)
				// Keep in state on failure to prevent duplicate socat processes
				continue
			}
			removedPorts = append(removedPorts, f.Port)
		}
	}

	// Step 3: Re-acquire lock to apply diff
	m.mu.Lock()
	defer m.mu.Unlock()

	currentState, ok := m.sidecars[workspaceID]
	if !ok || currentState != state {
		return
	}

	removedSet := make(map[int]bool, len(removedPorts))
	for _, p := range removedPorts {
		removedSet[p] = true
	}

	remaining := make([]PortForwarder, 0, len(state.Forwarders))
	for _, f := range state.Forwarders {
		if !removedSet[f.Port] {
			remaining = append(remaining, f)
		}
	}
	remaining = append(remaining, added...)
	state.Forwarders = remaining
}

// addForwarder starts a socat process inside the Neko container to forward a port.
func (m *Manager) addForwarder(ctx context.Context, containerName string, port int, targetHost string) error {
	// Validate targetHost to prevent shell injection — only safe container hostnames allowed.
	if !validHostnameRe.MatchString(targetHost) {
		return fmt.Errorf("invalid target host: %q", targetHost)
	}
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
	// Anchor with comma after port to prevent matching port-prefix (e.g., port 80 matching 8080).
	cmd := fmt.Sprintf("pkill -f 'socat TCP-LISTEN:%d,' || true", port)
	return m.docker.RunSilent(ctx,
		"exec", containerName,
		"sh", "-c", cmd,
	)
}

// detectContainerPorts reads /proc/net/tcp and /proc/net/tcp6 from the DevContainer to find listening ports.
func (m *Manager) detectContainerPorts(ctx context.Context, containerName string) ([]int, error) {
	// Read IPv4
	out4, err := m.docker.Run(ctx, "exec", containerName, "cat", "/proc/net/tcp")
	if err != nil {
		return nil, fmt.Errorf("failed to read /proc/net/tcp: %w", err)
	}

	ports := parseProcNetTCP(string(out4), m.cfg.PortScanEphemeralMin, m.cfg.NekoSocatMinPort, m.cfg.NekoSocatMaxPort)

	// Read IPv6 (best-effort — may not exist)
	out6, err := m.docker.Run(ctx, "exec", containerName, "cat", "/proc/net/tcp6")
	if err == nil {
		ipv6Ports := parseProcNetTCP(string(out6), m.cfg.PortScanEphemeralMin, m.cfg.NekoSocatMinPort, m.cfg.NekoSocatMaxPort)
		// Merge, deduplicating
		seen := make(map[int]bool, len(ports))
		for _, p := range ports {
			seen[p] = true
		}
		for _, p := range ipv6Ports {
			if !seen[p] {
				seen[p] = true
				ports = append(ports, p)
			}
		}
	}

	return ports, nil
}

// parseProcNetTCP parses /proc/net/tcp or /proc/net/tcp6 output to extract listening port numbers.
// Lines with state 0A (LISTEN) have their local address port extracted.
// Ports outside [minPort, maxPort] or >= ephemeralMin are excluded.
func parseProcNetTCP(data string, ephemeralMin, minPort, maxPort int) []int {
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

		// Apply configurable port range filter
		if port < minPort || port > maxPort {
			continue
		}

		// Skip ephemeral range
		if port >= ephemeralMin {
			continue
		}

		if !seen[port] {
			seen[port] = true
			ports = append(ports, port)
		}
	}

	return ports
}
