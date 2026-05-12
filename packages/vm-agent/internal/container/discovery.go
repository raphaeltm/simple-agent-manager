// Package container provides devcontainer discovery for PTY sessions.
package container

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type containerCandidate struct {
	id        string
	createdAt time.Time
}

var (
	listRunningContainersByLabel = dockerListRunningContainersByLabel
	isContainerRunning           = dockerIsContainerRunning
	inspectContainerBridgeIP     = dockerInspectContainerBridgeIP
)

func dockerCLIPath() string {
	path := os.Getenv("SAM_DOCKER_CLI_PATH")
	if filepath.IsAbs(path) {
		return path
	}
	return "/usr/bin/docker"
}

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
	bridgeIPForID string
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
		if isContainerRunning(id) {
			return id, nil
		}
		slog.Warn("Cached devcontainer no longer running, rediscovering", "containerID", id)
		d.clearContainerIfCurrent(id)
		return d.discover()
	}
	d.mu.RUnlock()

	return d.discover()
}

// discover queries Docker for the devcontainer and caches the result.
func (d *Discovery) discover() (string, error) {
	d.mu.Lock()
	if d.containerID != "" && time.Since(d.lastCheck) < d.cacheTTL {
		id := d.containerID
		d.mu.Unlock()
		if isContainerRunning(id) {
			return id, nil
		}
		slog.Warn("Cached devcontainer no longer running, rediscovering", "containerID", id)
		d.clearContainerIfCurrent(id)
	} else {
		d.mu.Unlock()
	}

	candidates, err := listRunningContainersByLabel(d.labelKey, d.labelValue)
	if err != nil {
		return "", fmt.Errorf("failed to query docker: %w", err)
	}
	if len(candidates) == 0 {
		d.mu.Lock()
		d.containerID = ""
		d.lastCheck = time.Time{}
		d.mu.Unlock()
		d.clearBridgeIP()
		return "", fmt.Errorf("no running devcontainer found (label: %s=%s)", d.labelKey, d.labelValue)
	}

	sort.Slice(candidates, func(i, j int) bool {
		if !candidates[i].createdAt.Equal(candidates[j].createdAt) {
			return candidates[i].createdAt.After(candidates[j].createdAt)
		}
		return candidates[i].id < candidates[j].id
	})

	id := candidates[0].id
	d.mu.Lock()
	if d.containerID != "" && d.containerID != id {
		d.clearBridgeIP()
	}
	d.containerID = id
	d.lastCheck = time.Now()
	d.mu.Unlock()

	slog.Info("Discovered devcontainer", "containerID", id, "matches", len(candidates))
	return id, nil
}

func dockerListRunningContainersByLabel(labelKey, labelValue string) ([]containerCandidate, error) {
	filter := fmt.Sprintf("label=%s=%s", labelKey, labelValue)
	cmd := exec.Command(dockerCLIPath(), "ps", "--format", "{{.ID}}\t{{.CreatedAt}}", "--filter", filter)
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	var candidates []containerCandidate
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.SplitN(line, "\t", 2)
		id := strings.TrimSpace(fields[0])
		if id == "" {
			continue
		}
		createdAt := time.Time{}
		if len(fields) == 2 {
			if parsed, err := time.Parse("2006-01-02 15:04:05 -0700 MST", strings.TrimSpace(fields[1])); err == nil {
				createdAt = parsed
			}
		}
		candidates = append(candidates, containerCandidate{id: id, createdAt: createdAt})
	}
	return candidates, nil
}

func dockerIsContainerRunning(containerID string) bool {
	if strings.TrimSpace(containerID) == "" {
		return false
	}
	cmd := exec.Command(dockerCLIPath(), "inspect", "-f", "{{.State.Running}}", containerID)
	output, err := cmd.Output()
	return err == nil && strings.TrimSpace(string(output)) == "true"
}

func dockerInspectContainerBridgeIP(containerID string) (string, error) {
	cmd := exec.Command(dockerCLIPath(), "inspect", "-f",
		"{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", containerID)
	output, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

func (d *Discovery) clearContainerIfCurrent(containerID string) {
	d.mu.Lock()
	if d.containerID == containerID {
		d.containerID = ""
		d.lastCheck = time.Time{}
		d.mu.Unlock()
		d.clearBridgeIP()
		return
	}
	d.mu.Unlock()
}

func (d *Discovery) clearBridgeIP() {
	d.bridgeIPMu.Lock()
	d.bridgeIP = ""
	d.bridgeIPForID = ""
	d.bridgeIPCheck = time.Time{}
	d.bridgeIPMu.Unlock()
}

// GetBridgeIP returns the container's bridge network IP address.
// It caches the result and re-checks if the cache is stale.
func (d *Discovery) GetBridgeIP() (string, error) {
	containerID, err := d.GetContainerID()
	if err != nil {
		return "", err
	}

	d.bridgeIPMu.RLock()
	if d.bridgeIP != "" && d.bridgeIPForID == containerID && time.Since(d.bridgeIPCheck) < d.bridgeIPTTL {
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
	if d.bridgeIP != "" && d.bridgeIPForID == containerID && time.Since(d.bridgeIPCheck) < d.bridgeIPTTL {
		return d.bridgeIP, nil
	}

	ip, err := inspectContainerBridgeIP(containerID)
	if err != nil {
		return "", fmt.Errorf("docker inspect bridge IP: %w", err)
	}
	if ip == "" {
		return "", fmt.Errorf("container %s has no bridge IP", containerID)
	}

	d.bridgeIP = ip
	d.bridgeIPForID = containerID
	d.bridgeIPCheck = time.Now()
	slog.Info("Resolved container bridge IP", "containerID", containerID, "bridgeIP", ip)
	return ip, nil
}

// Invalidate clears the cached container ID and bridge IP, forcing re-discovery on next call.
func (d *Discovery) Invalidate() {
	d.mu.Lock()
	d.containerID = ""
	d.lastCheck = time.Time{}
	d.mu.Unlock()

	d.clearBridgeIP()
}
