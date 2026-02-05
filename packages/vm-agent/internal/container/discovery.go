// Package container provides devcontainer discovery for PTY sessions.
package container

import (
	"fmt"
	"log"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Discovery finds and caches the devcontainer's Docker container ID.
type Discovery struct {
	labelKey   string
	labelValue string

	mu          sync.RWMutex
	containerID string
	lastCheck   time.Time
	cacheTTL    time.Duration
}

// Config holds configuration for container discovery.
type Config struct {
	// LabelKey is the Docker label key to filter by (default: "devcontainer.local_folder").
	LabelKey string
	// LabelValue is the Docker label value to match (default: "/workspace").
	LabelValue string
	// CacheTTL is how long to cache a discovered container ID before re-checking.
	CacheTTL time.Duration
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
	return &Discovery{
		labelKey:   cfg.LabelKey,
		labelValue: cfg.LabelValue,
		cacheTTL:   cfg.CacheTTL,
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

	log.Printf("Discovered devcontainer: %s", d.containerID)
	return d.containerID, nil
}

// Invalidate clears the cached container ID, forcing re-discovery on next call.
func (d *Discovery) Invalidate() {
	d.mu.Lock()
	d.containerID = ""
	d.mu.Unlock()
}
