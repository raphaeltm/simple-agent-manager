// Package container provides devcontainer discovery for PTY sessions.
package container

import (
	"fmt"
	"log/slog"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Discovery finds and caches the devcontainer's Docker container ID and network metadata.
type Discovery struct {
	labelKey   string
	labelValue string

	mu          sync.RWMutex
	containerID string
	lastCheck   time.Time
	cacheTTL    time.Duration

	bridgeIPMu    sync.RWMutex
	bridgeIP      string
	bridgeIPCheck time.Time
	bridgeIPTTL   time.Duration
}

// Config holds configuration for container discovery.
type Config struct {
	// LabelKey is the Docker label key to filter by (default: "devcontainer.local_folder").
	LabelKey string
	// LabelValue is the Docker label value to match (default: "/workspace").
	LabelValue string
	// CacheTTL is how long to cache a discovered container ID before re-checking.
	CacheTTL time.Duration
	// BridgeIPTTL is how long to cache the container bridge IP before re-checking.
	// Defaults to 30s if not set.
	BridgeIPTTL time.Duration
}

// NewDiscovery creates a new container discovery instance.
func NewDiscovery(cfg Config) *Discovery {
	if cfg.LabelKey == "" {
		cfg.LabelKey = "devcontainer.local_folder"
	}
	if cfg.LabelValue == "" {
		cfg.LabelValue = "/workspace"
	}
	if cfg.CacheTTL == 0 {
		cfg.CacheTTL = 30 * time.Second
	}
	if cfg.BridgeIPTTL == 0 {
		cfg.BridgeIPTTL = 30 * time.Second
	}
	return &Discovery{
		labelKey:    cfg.LabelKey,
		labelValue:  cfg.LabelValue,
		cacheTTL:    cfg.CacheTTL,
		bridgeIPTTL: cfg.BridgeIPTTL,
	}
}

// GetContainerID returns the devcontainer's Docker container ID.
// It caches the result and re-discovers if the cache is stale or the container is gone.
func (d *Discovery) GetContainerID() (string, error) {
	d.mu.RLock()
	if d.containerID != "" && time.Since(d.lastCheck) < d.cacheTTL {
		id := d.containerID
		d.mu.RUnlock()
		return id, nil
	}
	d.mu.RUnlock()

	return d.discover()
}

// discover queries Docker for the devcontainer and caches the result.
func (d *Discovery) discover() (string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	// Double-check after acquiring write lock
	if d.containerID != "" && time.Since(d.lastCheck) < d.cacheTTL {
		return d.containerID, nil
	}

	filter := fmt.Sprintf("label=%s=%s", d.labelKey, d.labelValue)
	cmd := exec.Command("docker", "ps", "-q", "--filter", filter)
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to query docker: %w", err)
	}

	id := strings.TrimSpace(string(output))
	if id == "" {
		d.containerID = ""
		return "", fmt.Errorf("no running devcontainer found (label: %s=%s)", d.labelKey, d.labelValue)
	}

	// If multiple containers match, use the first one
	lines := strings.Split(id, "\n")
	d.containerID = strings.TrimSpace(lines[0])
	d.lastCheck = time.Now()

	slog.Info("Discovered devcontainer", "containerID", d.containerID)
	return d.containerID, nil
}

// GetBridgeIP returns the container's bridge network IP address.
// It caches the result and re-checks if the cache is stale.
func (d *Discovery) GetBridgeIP() (string, error) {
	containerID, err := d.GetContainerID()
	if err != nil {
		return "", err
	}

	d.bridgeIPMu.RLock()
	if d.bridgeIP != "" && time.Since(d.bridgeIPCheck) < d.bridgeIPTTL {
		ip := d.bridgeIP
		d.bridgeIPMu.RUnlock()
		return ip, nil
	}
	d.bridgeIPMu.RUnlock()

	return d.resolveBridgeIP(containerID)
}

func (d *Discovery) resolveBridgeIP(containerID string) (string, error) {
	d.bridgeIPMu.Lock()
	defer d.bridgeIPMu.Unlock()

	// Double-check after acquiring write lock
	if d.bridgeIP != "" && time.Since(d.bridgeIPCheck) < d.bridgeIPTTL {
		return d.bridgeIP, nil
	}

	cmd := exec.Command("docker", "inspect", "-f",
		"{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", containerID)
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("docker inspect bridge IP: %w", err)
	}

	ip := strings.TrimSpace(string(output))
	if ip == "" {
		return "", fmt.Errorf("container %s has no bridge IP", containerID)
	}

	d.bridgeIP = ip
	d.bridgeIPCheck = time.Now()
	slog.Info("Resolved container bridge IP", "containerID", containerID, "bridgeIP", ip)
	return ip, nil
}

// Invalidate clears the cached container ID and bridge IP, forcing re-discovery on next call.
func (d *Discovery) Invalidate() {
	d.mu.Lock()
	d.containerID = ""
	d.mu.Unlock()

	d.bridgeIPMu.Lock()
	d.bridgeIP = ""
	d.bridgeIPMu.Unlock()
}
