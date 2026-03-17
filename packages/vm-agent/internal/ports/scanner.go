package ports

import (
	"fmt"
	"log/slog"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DetectedPort represents a port actively listening inside a container.
type DetectedPort struct {
	Port       int    `json:"port"`
	Address    string `json:"address"`
	Label      string `json:"label"`
	URL        string `json:"url"`
	DetectedAt string `json:"detectedAt"`
}

// EventEmitter is called when ports are detected or closed.
type EventEmitter func(eventType, message string, detail map[string]interface{})

// ContainerResolver is called when the scanner has no container ID.
// It allows lazy resolution when the container isn't ready at scanner creation time.
type ContainerResolver func() (string, error)

// ScannerConfig holds configuration for the port scanner.
type ScannerConfig struct {
	Enabled           bool
	Interval          time.Duration
	ExcludePorts      map[int]bool
	EphemeralMin      int
	BaseDomain        string
	WorkspaceID       string
	ContainerID       string // Resolved container ID for docker exec
	ContainerResolver ContainerResolver
	EventEmitter      EventEmitter
}

// Default scanner configuration values.
const (
	DefaultScanInterval = 5 * time.Second
	DefaultEphemeralMin = 32768
)

// Scanner polls /proc/net/tcp inside a container to detect listening ports.
type Scanner struct {
	cfg                 ScannerConfig
	mu                  sync.RWMutex
	ports               map[int]DetectedPort
	containerID         string
	stop                chan struct{}
	stopped             chan struct{}
	closeOnce           sync.Once
	consecutiveFailures int
	containerResolved   bool // tracks whether container was ever successfully resolved
}

// NewScanner creates a new port scanner for a workspace container.
func NewScanner(cfg ScannerConfig) *Scanner {
	if cfg.Interval <= 0 {
		cfg.Interval = DefaultScanInterval
	}
	if cfg.EphemeralMin <= 0 {
		cfg.EphemeralMin = DefaultEphemeralMin
	}
	return &Scanner{
		cfg:               cfg,
		ports:             make(map[int]DetectedPort),
		containerID:       cfg.ContainerID,
		stop:              make(chan struct{}),
		stopped:           make(chan struct{}),
		containerResolved: cfg.ContainerID != "",
	}
}

// Start begins the scanning loop in a goroutine.
func (s *Scanner) Start() {
	go s.loop()
}

// Stop signals the scanner to stop and waits for it to finish.
// Safe to call multiple times.
func (s *Scanner) Stop() {
	s.closeOnce.Do(func() {
		close(s.stop)
	})
	<-s.stopped
}

// Ports returns the currently detected ports.
func (s *Scanner) Ports() []DetectedPort {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]DetectedPort, 0, len(s.ports))
	for _, p := range s.ports {
		result = append(result, p)
	}
	return result
}

// ConsecutiveFailures returns the current consecutive failure count.
func (s *Scanner) ConsecutiveFailures() int {
	return s.consecutiveFailures
}

// ContainerResolved returns whether the container was ever successfully resolved.
func (s *Scanner) ContainerResolved() bool {
	return s.containerResolved
}

// SetContainerID updates the container ID for scanning.
// Called when the container is discovered or changes.
func (s *Scanner) SetContainerID(id string) {
	s.mu.Lock()
	s.containerID = id
	s.mu.Unlock()
}

func (s *Scanner) loop() {
	defer close(s.stopped)

	// Perform an initial scan immediately rather than waiting for the first tick.
	s.scan()

	ticker := time.NewTicker(s.cfg.Interval)
	defer ticker.Stop()

	for {
		select {
		case <-s.stop:
			return
		case <-ticker.C:
			s.scan()
		}
	}
}

func (s *Scanner) scan() {
	s.mu.RLock()
	containerID := s.containerID
	s.mu.RUnlock()

	if containerID == "" {
		// Attempt lazy resolution if a resolver is configured.
		if s.cfg.ContainerResolver != nil {
			if id, err := s.cfg.ContainerResolver(); err == nil && id != "" {
				s.SetContainerID(id)
				containerID = id
				s.containerResolved = true
				s.consecutiveFailures = 0
				slog.Info("Port scanner: resolved container ID lazily",
					"workspaceId", s.cfg.WorkspaceID, "containerID", id)
				// Emit event so the UI knows the scanner is now active.
				if s.cfg.EventEmitter != nil {
					s.cfg.EventEmitter("port.scanner_ready",
						"Port scanner: container discovered, scanning for open ports",
						map[string]interface{}{
							"containerID": id,
						})
				}
			} else {
				s.consecutiveFailures++
				// Log at WARN level so these are visible in node logs.
				// First failure gets INFO, subsequent get WARN with failure count.
				if s.consecutiveFailures == 1 {
					slog.Info("Port scanner: container not yet available, will retry",
						"workspaceId", s.cfg.WorkspaceID, "error", err)
				} else {
					slog.Warn("Port scanner: container still not available",
						"workspaceId", s.cfg.WorkspaceID,
						"consecutiveFailures", s.consecutiveFailures,
						"error", err)
				}
				// Emit node event every 6 failures (~30s at 5s interval) so the UI
				// shows diagnostics without flooding events.
				if s.consecutiveFailures%6 == 0 && s.cfg.EventEmitter != nil {
					s.cfg.EventEmitter("port.scanner_waiting",
						fmt.Sprintf("Port scanner: waiting for container (attempt %d)", s.consecutiveFailures),
						map[string]interface{}{
							"consecutiveFailures": s.consecutiveFailures,
							"error":               fmt.Sprintf("%v", err),
						})
				}
				return
			}
		} else {
			return
		}
	}

	content, err := readProcNetTCP(containerID)
	if err != nil {
		s.consecutiveFailures++
		// Log scan failures at WARN level so they're visible.
		slog.Warn("Port scan failed",
			"workspaceId", s.cfg.WorkspaceID,
			"containerID", containerID,
			"consecutiveFailures", s.consecutiveFailures,
			"error", err)
		return
	}

	// Reset failure counter on successful scan.
	s.consecutiveFailures = 0

	entries, err := ParseProcNetTCP(content)
	if err != nil {
		slog.Warn("Parse /proc/net/tcp failed",
			"workspaceId", s.cfg.WorkspaceID,
			"error", err)
		return
	}

	listening := FilterListening(entries, s.cfg.ExcludePorts, s.cfg.EphemeralMin)

	// Build set of currently listening ports
	current := make(map[int]TCPEntry, len(listening))
	for _, e := range listening {
		current[e.LocalPort] = e
	}

	// portEvent holds event data to emit after releasing the lock.
	type portEvent struct {
		eventType string
		message   string
		detail    map[string]interface{}
	}
	var events []portEvent

	s.mu.Lock()

	// Detect new ports
	now := time.Now().UTC().Format(time.RFC3339)
	for port, entry := range current {
		if _, exists := s.ports[port]; !exists {
			dp := DetectedPort{
				Port:       port,
				Address:    entry.LocalAddress,
				Label:      LabelForPort(port),
				URL:        buildPortURL(s.cfg.BaseDomain, s.cfg.WorkspaceID, port),
				DetectedAt: now,
			}
			s.ports[port] = dp

			if s.cfg.EventEmitter != nil {
				events = append(events, portEvent{
					eventType: "port.detected",
					message:   fmt.Sprintf("Port %d detected (%s)", port, dp.Label),
					detail: map[string]interface{}{
						"port":    port,
						"address": dp.Address,
						"label":   dp.Label,
						"url":     dp.URL,
					},
				})
			}
		}
	}

	// Detect closed ports
	for port, dp := range s.ports {
		if _, exists := current[port]; !exists {
			delete(s.ports, port)

			if s.cfg.EventEmitter != nil {
				events = append(events, portEvent{
					eventType: "port.closed",
					message:   fmt.Sprintf("Port %d closed (%s)", port, dp.Label),
					detail: map[string]interface{}{
						"port":  port,
						"label": dp.Label,
					},
				})
			}
		}
	}

	s.mu.Unlock()

	// Emit events outside the lock to prevent deadlocks
	for _, e := range events {
		s.cfg.EventEmitter(e.eventType, e.message, e.detail)
	}
}

// readProcNetTCP reads /proc/net/tcp from inside a container via docker exec.
func readProcNetTCP(containerID string) (string, error) {
	cmd := exec.Command("docker", "exec", containerID, "cat", "/proc/net/tcp")
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("docker exec cat /proc/net/tcp: %w", err)
	}
	return string(output), nil
}

func buildPortURL(baseDomain, workspaceID string, port int) string {
	if baseDomain == "" || workspaceID == "" {
		return ""
	}
	return fmt.Sprintf("https://ws-%s--%d.%s",
		strings.ToLower(workspaceID), port, baseDomain)
}

// Common port labels for developer tools.
var portLabels = map[int]string{
	80:    "HTTP",
	443:   "HTTPS",
	3000:  "Dev Server",
	3001:  "Dev Server",
	4000:  "Dev Server",
	4200:  "Angular",
	5000:  "Flask",
	5173:  "Vite",
	5174:  "Vite",
	5432:  "PostgreSQL",
	6379:  "Redis",
	8000:  "Django",
	8001:  "Dev Server",
	8080:  "HTTP Alt",
	8081:  "HTTP Alt",
	8888:  "Jupyter",
	9000:  "Dev Server",
	9090:  "Dev Server",
	27017: "MongoDB",
}

// LabelForPort returns a human-readable label for a well-known port,
// or a generic "Port {n}" label for unknown ports.
func LabelForPort(port int) string {
	if label, ok := portLabels[port]; ok {
		return label
	}
	return fmt.Sprintf("Port %d", port)
}

// DefaultExcludePorts returns the default set of infrastructure ports to exclude.
func DefaultExcludePorts() map[int]bool {
	return map[int]bool{
		22:   true, // SSH
		2375: true, // Docker (unencrypted)
		2376: true, // Docker (TLS)
		8443: true, // VM Agent
	}
}

// ParseExcludePorts parses a comma-separated string of port numbers.
func ParseExcludePorts(s string) map[int]bool {
	result := make(map[int]bool)
	if s == "" {
		return result
	}
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if port, err := strconv.Atoi(part); err == nil && port > 0 && port <= 65535 {
			result[port] = true
		}
	}
	return result
}
