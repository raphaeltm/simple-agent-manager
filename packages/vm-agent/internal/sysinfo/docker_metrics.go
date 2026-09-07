// Docker collection, bounded command execution, and metric parsing.
package sysinfo

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/workspace/vm-agent/internal/container"
)

// DockerInfo holds Docker engine info and per-container stats.
type DockerInfo struct {
	Version       string          `json:"version"`
	Containers    int             `json:"containers"`
	ContainerList []ContainerInfo `json:"containerList"`
	Error         *string         `json:"error,omitempty"`
}

// ContainerInfo holds per-container state and resource usage.
type ContainerInfo struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Image      string  `json:"image"`
	Status     string  `json:"status"`
	State      string  `json:"state"`
	CPUPercent float64 `json:"cpuPercent"`
	MemUsage   string  `json:"memUsage"`
	MemPercent float64 `json:"memPercent"`
	CreatedAt  string  `json:"createdAt"`
}

// DockerContainerStats holds bounded per-container telemetry for heartbeat admission.
type DockerContainerStats struct {
	ID               string    `json:"containerId"`
	Name             string    `json:"containerName,omitempty"`
	LabelValue       string    `json:"-"`
	CPUPercent       float64   `json:"cpuPercent"`
	MemoryUsageBytes uint64    `json:"memoryUsageBytes"`
	MemoryLimitBytes uint64    `json:"memoryLimitBytes,omitempty"`
	MemoryPercent    float64   `json:"memoryPercent,omitempty"`
	CollectedAt      time.Time `json:"collectedAt"`
}

const (
	defaultDockerStatsMaxContainers = 8
	defaultDockerCommandMaxBytes    = 64 * 1024
	defaultDockerCommandWaitDelay   = 500 * time.Millisecond
)

var dockerCommandSecretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(authorization:\s*bearer\s+)[^\s]+`),
	regexp.MustCompile(`(?i)((?:token|secret|password|credential|api[_-]?key)\s*[=:]\s*)[^\s]+`),
	regexp.MustCompile(`(?i)([?&](?:access_token|api[_-]?key|token|secret)=)[^&#\s]+`),
}

type DockerContainerStatsOptions struct {
	Timeout        time.Duration
	MaxContainers  int
	MaxOutputBytes int64
}

// dockerPSEntry represents the JSON output from docker ps --format '{{json .}}'.
type dockerPSEntry struct {
	ID        string `json:"ID"`
	Names     string `json:"Names"`
	Image     string `json:"Image"`
	Status    string `json:"Status"`
	State     string `json:"State"`
	CreatedAt string `json:"CreatedAt"`
}

type dockerPSLabelEntry struct {
	ID         string `json:"id"`
	Names      string `json:"names"`
	LabelValue string `json:"labelValue"`
}

// dockerStatsEntry represents per-container resource usage from docker stats.
type dockerStatsEntry struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	CPUPercent string `json:"cpuPercent"`
	MemUsage   string `json:"memUsage"`
	MemPercent string `json:"memPercent"`
}

// CollectDockerContainerStats collects Docker stats for a bounded set of container IDs.
func CollectDockerContainerStats(ctx context.Context, timeout time.Duration, containerIDs []string) (map[string]DockerContainerStats, error) {
	return collectDockerContainerStats(ctx, DockerContainerStatsOptions{Timeout: timeout}, containerIDs)
}

func collectDockerContainerStats(ctx context.Context, opts DockerContainerStatsOptions, containerIDs []string) (map[string]DockerContainerStats, error) {
	if len(containerIDs) == 0 {
		return map[string]DockerContainerStats{}, nil
	}
	if opts.MaxContainers > 0 && len(containerIDs) > opts.MaxContainers {
		return nil, fmt.Errorf("workspace container stats request exceeded max containers %d", opts.MaxContainers)
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	args := append([]string{"stats", "--no-stream", "--format",
		`{"id":"{{.ID}}","name":"{{.Name}}","cpuPercent":"{{.CPUPerc}}","memUsage":"{{.MemUsage}}","memPercent":"{{.MemPerc}}"}`},
		containerIDs...)
	out, err := dockerCommandOutput(ctx, opts.MaxOutputBytes, args...)
	if err != nil {
		return nil, err
	}

	requestedIDs := make(map[string]struct{}, len(containerIDs))
	for _, id := range containerIDs {
		requestedIDs[id] = struct{}{}
	}
	collectedAt := time.Now().UTC()
	result := make(map[string]DockerContainerStats)
	for id, entry := range parseDockerStats(string(out)) {
		if _, ok := requestedIDs[id]; !ok {
			continue
		}
		used, limit := parseDockerMemUsage(entry.MemUsage)
		result[id] = DockerContainerStats{
			ID:               id,
			Name:             strings.TrimPrefix(entry.Name, "/"),
			CPUPercent:       parsePercentString(entry.CPUPercent),
			MemoryUsageBytes: used,
			MemoryLimitBytes: limit,
			MemoryPercent:    parsePercentString(entry.MemPercent),
			CollectedAt:      collectedAt,
		}
	}
	return result, nil
}

// CollectDockerContainerStatsForLabels collects stats for running containers whose label value is
// in the requested set. It performs one bounded docker ps and one bounded docker stats call.
func CollectDockerContainerStatsForLabels(
	ctx context.Context,
	timeout time.Duration,
	labelKey string,
	labelValues []string,
) (map[string]DockerContainerStats, error) {
	return CollectDockerContainerStatsForLabelsBounded(
		ctx,
		DockerContainerStatsOptions{Timeout: timeout},
		labelKey,
		labelValues,
	)
}

func CollectDockerContainerStatsForLabelsBounded(
	ctx context.Context,
	opts DockerContainerStatsOptions,
	labelKey string,
	labelValues []string,
) (map[string]DockerContainerStats, error) {
	desired := make(map[string]struct{}, len(labelValues))
	for _, value := range labelValues {
		value = strings.TrimSpace(value)
		if value != "" {
			desired[value] = struct{}{}
		}
	}
	if len(desired) == 0 {
		return map[string]DockerContainerStats{}, nil
	}
	if strings.TrimSpace(labelKey) == "" {
		labelKey = "devcontainer.local_folder"
	}
	maxContainers := opts.MaxContainers
	if maxContainers <= 0 {
		maxContainers = defaultDockerStatsMaxContainers
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	labelTemplate := fmt.Sprintf(
		`{"id":"{{.ID}}","names":"{{.Names}}","labelValue":{{json (.Label %q)}}}`,
		labelKey,
	)
	out, err := dockerCommandOutput(ctx, opts.MaxOutputBytes, "ps", "--filter", "label="+labelKey, "--format", labelTemplate)
	if err != nil {
		return nil, err
	}

	containerIDs := make([]string, 0, len(desired))
	containerLabelValues := make(map[string]string, len(desired))
	for _, entry := range parseDockerPSLabelEntries(string(out)) {
		labelValue := strings.TrimSpace(entry.LabelValue)
		if _, ok := desired[labelValue]; !ok {
			continue
		}
		if entry.ID != "" {
			containerIDs = append(containerIDs, entry.ID)
			containerLabelValues[entry.ID] = labelValue
			if len(containerIDs) > maxContainers {
				return nil, fmt.Errorf("workspace container metric discovery exceeded max containers %d", maxContainers)
			}
		}
	}
	if len(containerIDs) == 0 {
		return map[string]DockerContainerStats{}, nil
	}

	stats, err := collectDockerContainerStats(ctx, opts, containerIDs)
	if err != nil {
		return nil, err
	}
	for id, stat := range stats {
		stat.LabelValue = containerLabelValues[id]
		stats[id] = stat
	}
	return stats, nil
}

func dockerCommandOutput(ctx context.Context, maxOutputBytes int64, args ...string) ([]byte, error) {
	if maxOutputBytes <= 0 {
		maxOutputBytes = defaultDockerCommandMaxBytes
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	stdout := newBoundedCommandOutput(maxOutputBytes, cancel)
	stderr := newBoundedCommandOutput(maxOutputBytes, cancel)
	cmd := exec.CommandContext(runCtx, container.DockerCLIPath(), args...)
	configureDockerCommand(cmd)
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	err := cmd.Run()
	if stdout.exceededLimit() {
		_ = terminateDockerCommand(cmd)
		return nil, fmt.Errorf("%s stdout exceeded %d bytes", dockerCommandSummary(args), maxOutputBytes)
	}
	if stderr.exceededLimit() {
		_ = terminateDockerCommand(cmd)
		return nil, fmt.Errorf("%s stderr exceeded %d bytes", dockerCommandSummary(args), maxOutputBytes)
	}
	if err != nil {
		_ = terminateDockerCommand(cmd)
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		if errors.Is(err, exec.ErrWaitDelay) {
			return nil, fmt.Errorf("%s output pipes did not close before wait delay", dockerCommandSummary(args))
		}
		if msg := sanitizeDockerCommandOutput(stderr.String()); msg != "" {
			return nil, fmt.Errorf("%w: %s", err, msg)
		}
		return nil, err
	}
	return stdout.Bytes(), nil
}

type boundedCommandOutput struct {
	mu         sync.Mutex
	buf        bytes.Buffer
	maxBytes   int64
	exceeded   bool
	onExceeded func()
}

func newBoundedCommandOutput(maxBytes int64, onExceeded func()) *boundedCommandOutput {
	return &boundedCommandOutput{maxBytes: maxBytes, onExceeded: onExceeded}
}

func (b *boundedCommandOutput) Write(p []byte) (int, error) {
	b.mu.Lock()
	remaining := int(b.maxBytes + 1 - int64(b.buf.Len()))
	if remaining > 0 {
		if remaining > len(p) {
			remaining = len(p)
		}
		_, _ = b.buf.Write(p[:remaining])
	}
	overLimit := int64(b.buf.Len()) > b.maxBytes || remaining < len(p)
	firstOverLimit := overLimit && !b.exceeded
	if overLimit {
		b.exceeded = true
	}
	onExceeded := b.onExceeded
	b.mu.Unlock()

	if firstOverLimit && onExceeded != nil {
		onExceeded()
	}
	return len(p), nil
}

func (b *boundedCommandOutput) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := append([]byte(nil), b.buf.Bytes()...)
	if int64(len(out)) > b.maxBytes {
		out = out[:b.maxBytes]
	}
	return out
}

func (b *boundedCommandOutput) String() string {
	return string(b.Bytes())
}

func (b *boundedCommandOutput) exceededLimit() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.exceeded
}

func configureDockerCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		return terminateDockerCommand(cmd)
	}
	cmd.WaitDelay = defaultDockerCommandWaitDelay
}

func terminateDockerCommand(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return os.ErrProcessDone
	}
	if cmd.SysProcAttr != nil && cmd.SysProcAttr.Setpgid {
		if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
			if errors.Is(err, syscall.ESRCH) {
				return os.ErrProcessDone
			}
			return err
		}
		return nil
	}
	if err := cmd.Process.Kill(); err != nil {
		if errors.Is(err, os.ErrProcessDone) {
			return os.ErrProcessDone
		}
		return err
	}
	return nil
}

func dockerCommandSummary(args []string) string {
	if len(args) == 0 {
		return "docker"
	}
	switch args[0] {
	case "ps", "stats", "version":
		return "docker " + args[0]
	default:
		return "docker command"
	}
}

func sanitizeDockerCommandOutput(value string) string {
	value = strings.TrimSpace(value)
	for _, pattern := range dockerCommandSecretPatterns {
		value = pattern.ReplaceAllString(value, "${1}[redacted]")
	}
	const maxErrorOutputBytes = 2048
	if len(value) > maxErrorOutputBytes {
		value = value[:maxErrorOutputBytes] + "...[truncated]"
	}
	return value
}

// collectDocker queries Docker CLI for version and container info.
// Uses docker ps -a for full container enumeration (all states) and
// docker stats --no-stream only for resource metrics of running containers.
func (c *Collector) collectDocker() DockerInfo {
	info := DockerInfo{}

	// Get Docker version
	ctx, cancel := context.WithTimeout(context.Background(), c.config.DockerTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "version", "--format", "{{.Server.Version}}").Output()
	if err == nil {
		info.Version = strings.TrimSpace(string(out))
	}

	// Phase 1: Enumerate all containers with docker ps -a
	ctx2, cancel2 := context.WithTimeout(context.Background(), c.config.DockerListTimeout)
	defer cancel2()
	out, err = exec.CommandContext(ctx2, "docker", "ps", "-a", "--format", "{{json .}}").Output()
	if err != nil {
		errMsg := fmt.Sprintf("failed to list containers: %v", err)
		slog.Warn("Docker container list failed", "error", err)
		info.Error = &errMsg
		info.ContainerList = []ContainerInfo{}
		return info
	}

	// Parse docker ps output
	containers := parseDockerPS(string(out))
	if len(containers) == 0 {
		info.Containers = 0
		info.ContainerList = []ContainerInfo{}
		return info
	}

	// Phase 2: Get resource stats for running containers only
	var runningIDs []string
	for _, ci := range containers {
		if ci.State == "running" {
			runningIDs = append(runningIDs, ci.ID)
		}
	}

	statsMap := make(map[string]dockerStatsEntry)
	if len(runningIDs) > 0 {
		ctx3, cancel3 := context.WithTimeout(context.Background(), c.config.DockerStatsTimeout)
		defer cancel3()
		args := append([]string{"stats", "--no-stream", "--format",
			`{"id":"{{.ID}}","cpuPercent":"{{.CPUPerc}}","memUsage":"{{.MemUsage}}","memPercent":"{{.MemPerc}}"}`},
			runningIDs...)
		out, err = exec.CommandContext(ctx3, "docker", args...).Output()
		if err != nil {
			slog.Warn("Docker stats query failed (containers still listed)", "error", err)
		} else {
			statsMap = parseDockerStats(string(out))
		}
	}

	// Merge ps + stats into ContainerInfo
	for i := range containers {
		if stats, ok := statsMap[containers[i].ID]; ok {
			containers[i].CPUPercent = parsePercentString(stats.CPUPercent)
			containers[i].MemUsage = stats.MemUsage
			containers[i].MemPercent = parsePercentString(stats.MemPercent)
		}
	}

	info.ContainerList = containers
	info.Containers = len(containers)
	return info
}

// parseDockerPS parses the output of docker ps -a --format '{{json .}}'.
func parseDockerPS(output string) []ContainerInfo {
	var containers []ContainerInfo
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var entry dockerPSEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			slog.Debug("Skipping unparseable docker ps line", "error", err)
			continue
		}
		ci := ContainerInfo{
			ID:        entry.ID,
			Name:      strings.TrimPrefix(entry.Names, "/"),
			Image:     entry.Image,
			Status:    entry.Status,
			State:     strings.ToLower(entry.State),
			CreatedAt: entry.CreatedAt,
		}
		containers = append(containers, ci)
	}
	return containers
}

// parseDockerStats parses docker stats --no-stream JSON output into a map keyed by container ID.
func parseDockerStats(output string) map[string]dockerStatsEntry {
	result := make(map[string]dockerStatsEntry)
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var entry dockerStatsEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		if entry.ID != "" {
			result[entry.ID] = entry
		}
	}
	return result
}

func parseDockerPSLabelEntries(output string) []dockerPSLabelEntry {
	entries := []dockerPSLabelEntry{}
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var entry dockerPSLabelEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		if entry.ID != "" {
			entries = append(entries, entry)
		}
	}
	return entries
}

func parseDockerMemUsage(value string) (uint64, uint64) {
	parts := strings.Split(value, "/")
	if len(parts) != 2 {
		return 0, 0
	}
	return parseDockerByteQuantity(parts[0]), parseDockerByteQuantity(parts[1])
}

func parseDockerByteQuantity(value string) uint64 {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	fields := strings.Fields(value)
	token := fields[0]
	unitStart := len(token)
	for i, r := range token {
		if (r < '0' || r > '9') && r != '.' {
			unitStart = i
			break
		}
	}
	numberText := token[:unitStart]
	unit := strings.ToLower(strings.TrimSpace(token[unitStart:]))
	parsed, err := strconv.ParseFloat(numberText, 64)
	if err != nil || parsed < 0 {
		return 0
	}
	multiplier := float64(1)
	switch unit {
	case "b", "":
		multiplier = 1
	case "kb":
		multiplier = 1000
	case "kib":
		multiplier = 1024
	case "mb":
		multiplier = 1000 * 1000
	case "mib":
		multiplier = 1024 * 1024
	case "gb":
		multiplier = 1000 * 1000 * 1000
	case "gib":
		multiplier = 1024 * 1024 * 1024
	case "tb":
		multiplier = 1000 * 1000 * 1000 * 1000
	case "tib":
		multiplier = 1024 * 1024 * 1024 * 1024
	default:
		return 0
	}
	return uint64(math.Round(parsed * multiplier))
}
