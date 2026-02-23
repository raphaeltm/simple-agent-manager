// Package sysinfo collects system metrics from Linux procfs and Docker CLI.
// It provides two collection modes: CollectQuick (procfs only, microseconds)
// for heartbeat paths, and Collect (full, including Docker CLI) for on-demand
// endpoint requests.
package sysinfo

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Build-time variables injected via ldflags in the Makefile.
var (
	Version        = "dev"
	BuildDate      = "unknown"
	GoVersionBuild = "unknown"
)

// SystemInfo is the full system information response.
type SystemInfo struct {
	CPU      CPUInfo      `json:"cpu"`
	Memory   MemoryInfo   `json:"memory"`
	Disk     DiskInfo     `json:"disk"`
	Network  NetworkInfo  `json:"network"`
	Uptime   UptimeInfo   `json:"uptime"`
	Docker   DockerInfo   `json:"docker"`
	Software SoftwareInfo `json:"software"`
	Agent    AgentInfo    `json:"agent"`
}

// QuickMetrics is a lightweight subset for heartbeat enrichment.
type QuickMetrics struct {
	CPULoadAvg1   float64 `json:"cpuLoadAvg1"`
	MemoryPercent float64 `json:"memoryPercent"`
	DiskPercent   float64 `json:"diskPercent"`
}

// CPUInfo holds CPU load averages and core count.
type CPUInfo struct {
	LoadAvg1  float64 `json:"loadAvg1"`
	LoadAvg5  float64 `json:"loadAvg5"`
	LoadAvg15 float64 `json:"loadAvg15"`
	NumCPU    int     `json:"numCpu"`
}

// MemoryInfo holds system memory usage.
type MemoryInfo struct {
	TotalBytes     uint64  `json:"totalBytes"`
	UsedBytes      uint64  `json:"usedBytes"`
	AvailableBytes uint64  `json:"availableBytes"`
	UsedPercent    float64 `json:"usedPercent"`
}

// DiskInfo holds filesystem usage for a mount path.
type DiskInfo struct {
	TotalBytes     uint64  `json:"totalBytes"`
	UsedBytes      uint64  `json:"usedBytes"`
	AvailableBytes uint64  `json:"availableBytes"`
	UsedPercent    float64 `json:"usedPercent"`
	MountPath      string  `json:"mountPath"`
}

// NetworkInfo holds cumulative network byte counters.
type NetworkInfo struct {
	Interface string `json:"interface"`
	RxBytes   uint64 `json:"rxBytes"`
	TxBytes   uint64 `json:"txBytes"`
}

// UptimeInfo holds system uptime.
type UptimeInfo struct {
	Seconds     float64 `json:"seconds"`
	HumanFormat string  `json:"humanFormat"`
}

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

// SoftwareInfo holds version strings for installed software.
type SoftwareInfo struct {
	GoVersion       string `json:"goVersion"`
	NodeVersion     string `json:"nodeVersion"`
	DockerVersion   string `json:"dockerVersion"`
	DevcontainerCLI string `json:"devcontainerCliVersion"`
}

// AgentInfo holds VM agent process information.
type AgentInfo struct {
	Version    string `json:"version"`
	BuildDate  string `json:"buildDate"`
	GoRuntime  string `json:"goRuntime"`
	Goroutines int    `json:"goroutines"`
	HeapBytes  uint64 `json:"heapBytes"`
}

// CollectorConfig holds configurable timeouts for the Collector.
type CollectorConfig struct {
	DockerTimeout      time.Duration // Timeout for Docker CLI commands (default: 10s) — used for version check
	DockerListTimeout  time.Duration // Timeout for docker ps (default: 10s)
	DockerStatsTimeout time.Duration // Timeout for docker stats (default: 10s)
	VersionTimeout     time.Duration // Timeout for version check commands (default: 5s)
	CacheTTL           time.Duration // How long to cache full results (default: 5s)
	DiskMountPath      string        // Filesystem path for disk usage (default: "/")
}

// Collector gathers system information.
type Collector struct {
	config CollectorConfig

	cacheMu     sync.RWMutex
	cachedFull  *SystemInfo
	cachedAt    time.Time
	quickMu     sync.RWMutex
	cachedQuick *QuickMetrics
	quickAt     time.Time

	// readFile is a function to read a file's contents, injectable for testing.
	readFile func(path string) (string, error)
	// statFS is a function to stat a filesystem, injectable for testing.
	statFS func(path string) (*syscall.Statfs_t, error)
}

// envDuration reads a duration from an environment variable, returning the default if unset or invalid.
func envDuration(key string, defaultVal time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return defaultVal
}

// NewCollector creates a new system info collector.
func NewCollector(cfg CollectorConfig) *Collector {
	if cfg.DockerTimeout == 0 {
		cfg.DockerTimeout = envDuration("SYSINFO_DOCKER_TIMEOUT", 10*time.Second)
	}
	if cfg.DockerListTimeout == 0 {
		cfg.DockerListTimeout = envDuration("SYSINFO_DOCKER_LIST_TIMEOUT", 10*time.Second)
	}
	if cfg.DockerStatsTimeout == 0 {
		cfg.DockerStatsTimeout = envDuration("SYSINFO_DOCKER_STATS_TIMEOUT", 10*time.Second)
	}
	if cfg.VersionTimeout == 0 {
		cfg.VersionTimeout = 5 * time.Second
	}
	if cfg.CacheTTL == 0 {
		cfg.CacheTTL = 5 * time.Second
	}
	if cfg.DiskMountPath == "" {
		cfg.DiskMountPath = "/"
	}
	return &Collector{
		config:   cfg,
		readFile: defaultReadFile,
		statFS:   defaultStatFS,
	}
}

// CollectQuick returns lightweight metrics from procfs only (no exec calls).
// Safe to call from the heartbeat path.
func (c *Collector) CollectQuick() (*QuickMetrics, error) {
	c.quickMu.RLock()
	if c.cachedQuick != nil && time.Since(c.quickAt) < c.config.CacheTTL {
		result := *c.cachedQuick
		c.quickMu.RUnlock()
		return &result, nil
	}
	c.quickMu.RUnlock()

	cpu, err := c.collectCPU()
	if err != nil {
		return nil, fmt.Errorf("cpu: %w", err)
	}
	mem, err := c.collectMemory()
	if err != nil {
		return nil, fmt.Errorf("memory: %w", err)
	}
	disk, err := c.collectDisk()
	if err != nil {
		return nil, fmt.Errorf("disk: %w", err)
	}

	result := &QuickMetrics{
		CPULoadAvg1:   cpu.LoadAvg1,
		MemoryPercent: mem.UsedPercent,
		DiskPercent:   disk.UsedPercent,
	}

	c.quickMu.Lock()
	c.cachedQuick = result
	c.quickAt = time.Now()
	c.quickMu.Unlock()

	return result, nil
}

// Collect returns full system info including Docker CLI calls.
// Results are cached for CacheTTL to handle rapid polling.
func (c *Collector) Collect() (*SystemInfo, error) {
	c.cacheMu.RLock()
	if c.cachedFull != nil && time.Since(c.cachedAt) < c.config.CacheTTL {
		result := *c.cachedFull
		c.cacheMu.RUnlock()
		return &result, nil
	}
	c.cacheMu.RUnlock()

	cpu, err := c.collectCPU()
	if err != nil {
		return nil, fmt.Errorf("cpu: %w", err)
	}
	mem, err := c.collectMemory()
	if err != nil {
		return nil, fmt.Errorf("memory: %w", err)
	}
	disk, err := c.collectDisk()
	if err != nil {
		return nil, fmt.Errorf("disk: %w", err)
	}
	network := c.collectNetwork()
	uptime := c.collectUptime()
	docker := c.collectDocker()
	software := c.collectSoftware()
	agent := c.collectAgent()

	// Use docker version from docker info if software version is empty
	if software.DockerVersion == "" && docker.Version != "" {
		software.DockerVersion = docker.Version
	}

	result := &SystemInfo{
		CPU:      cpu,
		Memory:   mem,
		Disk:     disk,
		Network:  network,
		Uptime:   uptime,
		Docker:   docker,
		Software: software,
		Agent:    agent,
	}

	c.cacheMu.Lock()
	c.cachedFull = result
	c.cachedAt = time.Now()
	c.cacheMu.Unlock()

	return result, nil
}

// collectCPU reads /proc/loadavg.
func (c *Collector) collectCPU() (CPUInfo, error) {
	content, err := c.readFile("/proc/loadavg")
	if err != nil {
		return CPUInfo{NumCPU: runtime.NumCPU()}, err
	}
	return ParseLoadAvg(content), nil
}

// ParseLoadAvg parses the content of /proc/loadavg.
func ParseLoadAvg(content string) CPUInfo {
	fields := strings.Fields(strings.TrimSpace(content))
	info := CPUInfo{NumCPU: runtime.NumCPU()}
	if len(fields) >= 1 {
		info.LoadAvg1, _ = strconv.ParseFloat(fields[0], 64)
	}
	if len(fields) >= 2 {
		info.LoadAvg5, _ = strconv.ParseFloat(fields[1], 64)
	}
	if len(fields) >= 3 {
		info.LoadAvg15, _ = strconv.ParseFloat(fields[2], 64)
	}
	return info
}

// collectMemory reads /proc/meminfo.
func (c *Collector) collectMemory() (MemoryInfo, error) {
	content, err := c.readFile("/proc/meminfo")
	if err != nil {
		return MemoryInfo{}, err
	}
	return ParseMemInfo(content), nil
}

// ParseMemInfo parses the content of /proc/meminfo.
func ParseMemInfo(content string) MemoryInfo {
	fields := make(map[string]uint64)
	scanner := bufio.NewScanner(strings.NewReader(content))
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		valStr := strings.TrimSpace(parts[1])
		// Remove "kB" suffix
		valStr = strings.TrimSuffix(valStr, " kB")
		valStr = strings.TrimSpace(valStr)
		val, err := strconv.ParseUint(valStr, 10, 64)
		if err != nil {
			continue
		}
		fields[key] = val * 1024 // Convert kB to bytes
	}

	total := fields["MemTotal"]
	available := fields["MemAvailable"]
	// Fallback: if MemAvailable is not present (older kernels), estimate it
	if available == 0 {
		available = fields["MemFree"] + fields["Buffers"] + fields["Cached"]
	}

	used := uint64(0)
	if total > available {
		used = total - available
	}

	var usedPercent float64
	if total > 0 {
		usedPercent = roundTo(float64(used)/float64(total)*100, 1)
	}

	return MemoryInfo{
		TotalBytes:     total,
		UsedBytes:      used,
		AvailableBytes: available,
		UsedPercent:    usedPercent,
	}
}

// collectDisk uses syscall.Statfs to get filesystem usage.
func (c *Collector) collectDisk() (DiskInfo, error) {
	stat, err := c.statFS(c.config.DiskMountPath)
	if err != nil {
		return DiskInfo{MountPath: c.config.DiskMountPath}, err
	}
	return StatFSToDiskInfo(stat, c.config.DiskMountPath), nil
}

// StatFSToDiskInfo converts a Statfs_t to DiskInfo.
func StatFSToDiskInfo(stat *syscall.Statfs_t, mountPath string) DiskInfo {
	total := stat.Blocks * uint64(stat.Bsize)
	available := stat.Bavail * uint64(stat.Bsize)
	used := total - (stat.Bfree * uint64(stat.Bsize))

	var usedPercent float64
	if total > 0 {
		usedPercent = roundTo(float64(used)/float64(total)*100, 1)
	}

	return DiskInfo{
		TotalBytes:     total,
		UsedBytes:      used,
		AvailableBytes: available,
		UsedPercent:    usedPercent,
		MountPath:      mountPath,
	}
}

// collectNetwork reads /proc/net/dev for the first non-lo interface.
func (c *Collector) collectNetwork() NetworkInfo {
	content, err := c.readFile("/proc/net/dev")
	if err != nil {
		return NetworkInfo{}
	}
	return ParseNetDev(content)
}

// ParseNetDev parses the content of /proc/net/dev.
func ParseNetDev(content string) NetworkInfo {
	scanner := bufio.NewScanner(strings.NewReader(content))
	for scanner.Scan() {
		line := scanner.Text()
		// Skip header lines
		if strings.Contains(line, "|") || strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.SplitN(strings.TrimSpace(line), ":", 2)
		if len(parts) != 2 {
			continue
		}
		iface := strings.TrimSpace(parts[0])
		if iface == "lo" {
			continue
		}
		fields := strings.Fields(strings.TrimSpace(parts[1]))
		if len(fields) < 9 {
			continue
		}
		rxBytes, _ := strconv.ParseUint(fields[0], 10, 64)
		txBytes, _ := strconv.ParseUint(fields[8], 10, 64)
		return NetworkInfo{
			Interface: iface,
			RxBytes:   rxBytes,
			TxBytes:   txBytes,
		}
	}
	return NetworkInfo{}
}

// collectUptime reads /proc/uptime.
func (c *Collector) collectUptime() UptimeInfo {
	content, err := c.readFile("/proc/uptime")
	if err != nil {
		return UptimeInfo{}
	}
	return ParseUptime(content)
}

// ParseUptime parses the content of /proc/uptime.
func ParseUptime(content string) UptimeInfo {
	fields := strings.Fields(strings.TrimSpace(content))
	if len(fields) < 1 {
		return UptimeInfo{}
	}
	seconds, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return UptimeInfo{}
	}
	return UptimeInfo{
		Seconds:     seconds,
		HumanFormat: formatUptime(seconds),
	}
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

// dockerStatsEntry represents per-container resource usage from docker stats.
type dockerStatsEntry struct {
	ID         string `json:"id"`
	CPUPercent string `json:"cpuPercent"`
	MemUsage   string `json:"memUsage"`
	MemPercent string `json:"memPercent"`
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
		return info
	}

	// Parse docker ps output
	containers := parseDockerPS(string(out))
	if len(containers) == 0 {
		info.Containers = 0
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

// collectSoftware queries installed software versions.
func (c *Collector) collectSoftware() SoftwareInfo {
	info := SoftwareInfo{
		GoVersion: runtime.Version(),
	}

	ctx, cancel := context.WithTimeout(context.Background(), c.config.VersionTimeout)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "node", "--version").Output(); err == nil {
		info.NodeVersion = strings.TrimSpace(string(out))
	}

	ctx2, cancel2 := context.WithTimeout(context.Background(), c.config.VersionTimeout)
	defer cancel2()
	if out, err := exec.CommandContext(ctx2, "docker", "version", "--format", "{{.Server.Version}}").Output(); err == nil {
		info.DockerVersion = strings.TrimSpace(string(out))
	}

	ctx3, cancel3 := context.WithTimeout(context.Background(), c.config.VersionTimeout)
	defer cancel3()
	if out, err := exec.CommandContext(ctx3, "devcontainer", "--version").Output(); err == nil {
		info.DevcontainerCLI = strings.TrimSpace(string(out))
	}

	return info
}

// collectAgent returns VM agent process info.
func (c *Collector) collectAgent() AgentInfo {
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)

	return AgentInfo{
		Version:    Version,
		BuildDate:  BuildDate,
		GoRuntime:  GoVersionBuild,
		Goroutines: runtime.NumGoroutine(),
		HeapBytes:  memStats.HeapAlloc,
	}
}

// parsePercentString strips a trailing "%" and parses to float64.
func parsePercentString(s string) float64 {
	s = strings.TrimSuffix(strings.TrimSpace(s), "%")
	v, _ := strconv.ParseFloat(s, 64)
	return v
}

// formatUptime formats seconds into a human-readable string like "2d 5h 32m".
func formatUptime(totalSeconds float64) string {
	secs := int(totalSeconds)
	days := secs / 86400
	secs %= 86400
	hours := secs / 3600
	secs %= 3600
	minutes := secs / 60

	if days > 0 {
		return fmt.Sprintf("%dd %dh %dm", days, hours, minutes)
	}
	if hours > 0 {
		return fmt.Sprintf("%dh %dm", hours, minutes)
	}
	return fmt.Sprintf("%dm", minutes)
}

// roundTo rounds a float64 to n decimal places.
func roundTo(val float64, places int) float64 {
	pow := math.Pow(10, float64(places))
	return math.Round(val*pow) / pow
}
