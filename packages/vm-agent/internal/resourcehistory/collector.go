package resourcehistory

// FILE SIZE EXCEPTION: cohesive VM resource-history collector covering sampling, chunking, spool, and upload; split after production validation fixes settle the collector boundary.

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	StorageFormat = "resource-history-gzip-json-v1"
	SourceVersion = 1

	DefaultSampleInterval = 5 * time.Second
	DefaultChunkInterval  = 15 * time.Minute
	DefaultUploadTimeout  = 10 * time.Second
	DefaultSpoolMaxBytes  = int64(20 * 1024 * 1024)
	DefaultMaxSamples     = 4096
)

type Config struct {
	ControlPlaneURL string
	ProjectID       string
	WorkspaceID     string
	NodeID          string
	SessionID       string
	TaskID          string
	AgentProfileID  string
	SkillID         string
	AgentType       string
	Runtime         string
	SampleInterval  time.Duration
	ChunkInterval   time.Duration
	UploadTimeout   time.Duration
	SpoolDir        string
	SpoolMaxBytes   int64
	MaxSamples      int
	ContainerID     func(context.Context) (string, error)
	CallbackToken   func() string
	HTTPClient      *http.Client
	Logger          *slog.Logger
	Now             func() time.Time
	CgroupRoot      string
	ProcRoot        string
}

type Attribution struct {
	ProjectID string
	SessionID string
	TaskID    string
	ProfileID string
	SkillID   string
	AgentType string
	Runtime   string
}

type Collector struct {
	cfg Config

	mu             sync.Mutex
	started        bool
	chunkStartedAt time.Time
	lastSampleAt   time.Time
	lastCounters   *cgroupCounters
	cgroupPath     string
	cgroupErr      string
	sequence       int64
	samples        []Sample
	gaps           []map[string]any
	toolSpans      []ToolSpan
	activeTools    map[string]time.Time
	activeToolKind map[string]string
	closed         bool

	cancel context.CancelFunc
}

type Sample struct {
	T               int64  `json:"t"`
	IntervalMillis  int64  `json:"intervalMillis,omitempty"`
	CPUMillis       int64  `json:"cpuMillis,omitempty"`
	MemoryBytes     uint64 `json:"memoryBytes,omitempty"`
	MemoryPeakBytes uint64 `json:"memoryPeakBytes,omitempty"`
	IOReadBytes     uint64 `json:"ioReadBytes,omitempty"`
	IOWriteBytes    uint64 `json:"ioWriteBytes,omitempty"`
	OOM             uint64 `json:"oom,omitempty"`
	OOMKill         uint64 `json:"oomKill,omitempty"`
	PidsCurrent     uint64 `json:"pidsCurrent,omitempty"`
	CounterReset    bool   `json:"counterReset,omitempty"`
	Unsupported     string `json:"unsupported,omitempty"`
	Gap             bool   `json:"gap,omitempty"`
}

type ToolSpan struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	StartedAt   int64  `json:"startedAt"`
	EndedAt     int64  `json:"endedAt,omitempty"`
	Concurrency int    `json:"concurrency,omitempty"`
	Approximate bool   `json:"approximate,omitempty"`
}

type chunkPayload struct {
	Version   int              `json:"version"`
	Samples   []Sample         `json:"samples"`
	ToolSpans []ToolSpan       `json:"toolSpans"`
	Gaps      []map[string]any `json:"gaps,omitempty"`
	Notes     []string         `json:"notes,omitempty"`
}

type summaryPayload struct {
	CPUMeanMillis          *float64 `json:"cpuMeanMillis,omitempty"`
	CPUPeakMillis          *int64   `json:"cpuPeakMillis,omitempty"`
	MemoryMeanBytes        *uint64  `json:"memoryMeanBytes,omitempty"`
	MemoryPeakBytes        *uint64  `json:"memoryPeakBytes,omitempty"`
	MemoryKernelPeakBytes  *uint64  `json:"memoryKernelPeakBytes,omitempty"`
	IOReadBytes            *uint64  `json:"ioReadBytes,omitempty"`
	IOWriteBytes           *uint64  `json:"ioWriteBytes,omitempty"`
	OOMCount               *uint64  `json:"oomCount,omitempty"`
	SampleIntervalMillis   int64    `json:"sampleIntervalMillis"`
	WeightedMeanWallMillis int64    `json:"weightedMeanWallMillis"`
}

type uploadBody struct {
	WorkspaceID       string         `json:"workspaceId"`
	NodeID            string         `json:"nodeId,omitempty"`
	SessionID         string         `json:"sessionId,omitempty"`
	TaskID            string         `json:"taskId,omitempty"`
	AgentProfileID    string         `json:"agentProfileId,omitempty"`
	SkillID           string         `json:"skillId,omitempty"`
	AgentType         string         `json:"agentType,omitempty"`
	Runtime           string         `json:"runtime,omitempty"`
	SourceVersion     int            `json:"sourceVersion"`
	ChunkSequence     int64          `json:"chunkSequence"`
	StartedAt         int64          `json:"startedAt"`
	EndedAt           int64          `json:"endedAt"`
	SampleCount       int            `json:"sampleCount"`
	GapCount          int            `json:"gapCount"`
	ToolSpanCount     int            `json:"toolSpanCount"`
	CompressedBase64  string         `json:"compressedBase64"`
	CompressedBytes   int            `json:"compressedBytes"`
	UncompressedBytes int            `json:"uncompressedBytes"`
	SHA256            string         `json:"sha256"`
	StorageFormat     string         `json:"storageFormat"`
	Completeness      map[string]any `json:"completeness"`
	Summary           summaryPayload `json:"summary"`
}

type permanentUploadError struct{ err error }

func (e permanentUploadError) Error() string { return e.err.Error() }
func (e permanentUploadError) Unwrap() error { return e.err }

func isPermanentUploadError(err error) bool {
	var permanent permanentUploadError
	return errors.As(err, &permanent)
}

func New(cfg Config) *Collector {
	if cfg.SampleInterval <= 0 {
		cfg.SampleInterval = DefaultSampleInterval
	}
	if cfg.ChunkInterval <= 0 {
		cfg.ChunkInterval = DefaultChunkInterval
	}
	if cfg.UploadTimeout <= 0 {
		cfg.UploadTimeout = DefaultUploadTimeout
	}
	if cfg.SpoolMaxBytes <= 0 {
		cfg.SpoolMaxBytes = DefaultSpoolMaxBytes
	}
	if cfg.MaxSamples <= 0 {
		cfg.MaxSamples = DefaultMaxSamples
	}
	if cfg.Runtime == "" {
		cfg.Runtime = "vm"
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: cfg.UploadTimeout}
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.CgroupRoot == "" {
		cfg.CgroupRoot = "/sys/fs/cgroup"
	}
	if cfg.ProcRoot == "" {
		cfg.ProcRoot = "/proc"
	}
	if cfg.SpoolDir == "" {
		cfg.SpoolDir = "/var/lib/vm-agent/resource-history"
	}
	return &Collector{cfg: cfg, activeTools: make(map[string]time.Time), activeToolKind: make(map[string]string)}
}

func (c *Collector) Enabled() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.enabledLocked()
}

func (c *Collector) enabledLocked() bool {
	return strings.TrimSpace(c.cfg.ControlPlaneURL) != "" && strings.TrimSpace(c.cfg.ProjectID) != "" && strings.TrimSpace(c.cfg.WorkspaceID) != "" && c.cfg.CallbackToken != nil
}

func (c *Collector) UpdateAttribution(attr Attribution) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if value := strings.TrimSpace(attr.ProjectID); value != "" {
		c.cfg.ProjectID = value
	}
	if value := strings.TrimSpace(attr.SessionID); value != "" {
		c.cfg.SessionID = value
	}
	if value := strings.TrimSpace(attr.TaskID); value != "" {
		c.cfg.TaskID = value
	}
	if value := strings.TrimSpace(attr.ProfileID); value != "" {
		c.cfg.AgentProfileID = value
	}
	if value := strings.TrimSpace(attr.SkillID); value != "" {
		c.cfg.SkillID = value
	}
	if value := strings.TrimSpace(attr.AgentType); value != "" {
		c.cfg.AgentType = value
	}
	if value := strings.TrimSpace(attr.Runtime); value != "" {
		c.cfg.Runtime = value
	}
}

func (c *Collector) Start(parent context.Context) {
	c.mu.Lock()
	if !c.enabledLocked() {
		c.mu.Unlock()
		return
	}
	if c.started {
		c.mu.Unlock()
		return
	}
	runCtx, cancel := context.WithCancel(parent)
	c.cancel = cancel
	c.started = true
	c.chunkStartedAt = c.cfg.Now()
	c.mu.Unlock()

	if err := os.MkdirAll(c.cfg.SpoolDir, 0o700); err != nil {
		c.cfg.Logger.Warn("resourcehistory: create spool directory failed", "error", err)
	}
	c.mu.Lock()
	c.loadSequenceLocked()
	c.mu.Unlock()
	go c.loop(runCtx)
}

func (c *Collector) Stop(ctx context.Context) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	if c.cancel != nil {
		c.cancel()
	}
	c.mu.Unlock()
	c.flush(ctx, true)
	c.retrySpool(ctx)
}

func (c *Collector) RecordACPToolCall(toolCallID string, status string, at time.Time) {
	if strings.TrimSpace(toolCallID) == "" {
		return
	}
	id := hashedToolID(toolCallID)
	kind := "acp_tool_call"
	terminal := status == "completed" || status == "failed" || status == "cancelled"
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || !c.enabledLocked() {
		return
	}
	start, active := c.activeTools[id]
	if terminal {
		if !active {
			return
		}
		delete(c.activeTools, id)
		delete(c.activeToolKind, id)
		c.toolSpans = append(c.toolSpans, ToolSpan{ID: id, Kind: kind, StartedAt: start.UnixMilli(), EndedAt: at.UnixMilli(), Concurrency: len(c.activeTools) + 1})
		return
	}
	if active {
		return
	}
	c.activeTools[id] = at
	c.activeToolKind[id] = kind
}

func (c *Collector) ReconcileACPToolCalls(at time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.enabledLocked() {
		return
	}
	for id, start := range c.activeTools {
		kind := c.activeToolKind[id]
		if kind == "" {
			kind = "acp_tool_call"
		}
		c.toolSpans = append(c.toolSpans, ToolSpan{ID: id, Kind: kind, StartedAt: start.UnixMilli(), EndedAt: at.UnixMilli(), Approximate: true})
	}
	c.activeTools = make(map[string]time.Time)
	c.activeToolKind = make(map[string]string)
}

func (c *Collector) loop(ctx context.Context) {
	ticker := time.NewTicker(c.cfg.SampleInterval)
	defer ticker.Stop()
	c.sample(ctx)
	c.retrySpool(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.sample(ctx)
			if c.shouldFlush() {
				c.flush(ctx, false)
			}
			c.retrySpool(ctx)
		}
	}
}

func (c *Collector) shouldFlush() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.samples) >= c.cfg.MaxSamples || (!c.chunkStartedAt.IsZero() && c.cfg.Now().Sub(c.chunkStartedAt) >= c.cfg.ChunkInterval)
}

func (c *Collector) sample(ctx context.Context) {
	now := c.cfg.Now()
	c.mu.Lock()
	path := c.cgroupPath
	c.mu.Unlock()
	if path == "" {
		resolved, err := c.resolveCgroupPath(ctx)
		c.mu.Lock()
		if err != nil {
			c.cgroupErr = err.Error()
		} else {
			c.cgroupErr = ""
			c.cgroupPath = resolved
			path = resolved
		}
		c.mu.Unlock()
	}

	var sample Sample
	if path == "" {
		sample = Sample{T: now.UnixMilli(), Unsupported: c.cgroupErr}
	} else {
		counters, err := readCgroupCounters(path)
		if err != nil {
			c.mu.Lock()
			if c.cgroupPath == path {
				c.cgroupPath = ""
			}
			c.cgroupErr = err.Error()
			c.mu.Unlock()
			sample = Sample{T: now.UnixMilli(), Unsupported: err.Error()}
		} else {
			sample = c.sampleFromCounters(now, counters)
		}
	}

	c.mu.Lock()
	if !c.lastSampleAt.IsZero() {
		expected := c.cfg.SampleInterval * 2
		if now.Sub(c.lastSampleAt) > expected {
			sample.Gap = true
			c.gaps = append(c.gaps, map[string]any{"startedAt": c.lastSampleAt.UnixMilli(), "endedAt": now.UnixMilli(), "reason": "sampler_delay"})
		}
	}
	c.lastSampleAt = now
	c.samples = append(c.samples, sample)
	c.mu.Unlock()
}

func (c *Collector) sampleFromCounters(now time.Time, counters cgroupCounters) Sample {
	c.mu.Lock()
	defer c.mu.Unlock()
	sample := Sample{T: now.UnixMilli(), MemoryBytes: counters.MemoryCurrent, MemoryPeakBytes: counters.MemoryPeak}
	sample.PidsCurrent = counters.PidsCurrent
	if !c.lastSampleAt.IsZero() {
		sample.IntervalMillis = now.Sub(c.lastSampleAt).Milliseconds()
	}
	if c.lastCounters != nil {
		if counters.CPUUsageUsec >= c.lastCounters.CPUUsageUsec {
			sample.CPUMillis = int64((counters.CPUUsageUsec - c.lastCounters.CPUUsageUsec) / 1000)
		} else {
			sample.CounterReset = true
		}
		if counters.IOReadBytes >= c.lastCounters.IOReadBytes {
			sample.IOReadBytes = counters.IOReadBytes - c.lastCounters.IOReadBytes
		} else {
			sample.CounterReset = true
		}
		if counters.IOWriteBytes >= c.lastCounters.IOWriteBytes {
			sample.IOWriteBytes = counters.IOWriteBytes - c.lastCounters.IOWriteBytes
		} else {
			sample.CounterReset = true
		}
		if counters.OOM >= c.lastCounters.OOM {
			sample.OOM = counters.OOM - c.lastCounters.OOM
		}
		if counters.OOMKill >= c.lastCounters.OOMKill {
			sample.OOMKill = counters.OOMKill - c.lastCounters.OOMKill
		}
	}
	copyCounters := counters
	c.lastCounters = &copyCounters
	return sample
}

func (c *Collector) flush(ctx context.Context, final bool) {
	body, ok := c.buildUpload(final)
	if !ok {
		return
	}
	if err := c.writeSpool(body); err != nil {
		c.cfg.Logger.Warn("resourcehistory: spool write failed", "error", err)
		return
	}
	c.retrySpool(ctx)
}

func (c *Collector) buildUpload(final bool) (uploadBody, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.samples) == 0 && len(c.toolSpans) == 0 && !final {
		return uploadBody{}, false
	}
	if len(c.samples) == 0 && len(c.toolSpans) == 0 {
		return uploadBody{}, false
	}
	started := c.chunkStartedAt
	if started.IsZero() {
		started = c.cfg.Now()
	}
	ended := c.cfg.Now()
	samples := append([]Sample(nil), c.samples...)
	spans := append([]ToolSpan(nil), c.toolSpans...)
	gaps := append([]map[string]any(nil), c.gaps...)
	c.loadSequenceLocked()
	sequence := c.sequence
	c.sequence++
	c.persistSequenceLocked()
	c.samples = nil
	c.toolSpans = nil
	c.gaps = nil
	c.chunkStartedAt = ended
	payload := chunkPayload{Version: SourceVersion, Samples: samples, ToolSpans: spans, Gaps: gaps, Notes: []string{"cpuMillis/ioReadBytes/ioWriteBytes are per-sample deltas from monotonic cgroup counters", "tool spans are workload-overlap correlation, not per-process causal attribution"}}
	uncompressed, err := json.Marshal(payload)
	if err != nil {
		c.cfg.Logger.Warn("resourcehistory: marshal payload failed", "error", err)
		return uploadBody{}, false
	}
	compressed, err := gzipBytes(uncompressed)
	if err != nil {
		c.cfg.Logger.Warn("resourcehistory: gzip payload failed", "error", err)
		return uploadBody{}, false
	}
	digest := sha256.Sum256(compressed)
	body := uploadBody{
		WorkspaceID: c.cfg.WorkspaceID, NodeID: c.cfg.NodeID, SessionID: c.cfg.SessionID, TaskID: c.cfg.TaskID,
		AgentProfileID: c.cfg.AgentProfileID, SkillID: c.cfg.SkillID, AgentType: c.cfg.AgentType, Runtime: c.cfg.Runtime,
		SourceVersion: SourceVersion, ChunkSequence: sequence, StartedAt: started.UnixMilli(), EndedAt: ended.UnixMilli(),
		SampleCount: len(samples), GapCount: len(gaps), ToolSpanCount: len(spans), CompressedBase64: base64.StdEncoding.EncodeToString(compressed),
		CompressedBytes: len(compressed), UncompressedBytes: len(uncompressed), SHA256: hex.EncodeToString(digest[:]), StorageFormat: StorageFormat,
		Completeness: c.completeness(final), Summary: summarize(samples, c.cfg.SampleInterval),
	}
	return body, true
}

func (c *Collector) completeness(final bool) map[string]any {
	status := "complete"
	if c.cgroupErr != "" {
		status = "partial"
	}
	return map[string]any{"status": status, "finalFlush": final, "unsupported": c.cgroupErr, "nodeLossMayLoseUnflushedWindow": true, "source": "cgroup-v2"}
}

func summarize(samples []Sample, interval time.Duration) summaryPayload {
	var totalCPU int64
	var peakCPU int64
	var totalMem uint64
	var peakMem uint64
	var kernelPeak uint64
	var read uint64
	var write uint64
	var oom uint64
	var weightedWall int64
	for _, s := range samples {
		totalCPU += s.CPUMillis
		if s.CPUMillis > peakCPU {
			peakCPU = s.CPUMillis
		}
		totalMem += s.MemoryBytes
		if s.MemoryBytes > peakMem {
			peakMem = s.MemoryBytes
		}
		if s.MemoryPeakBytes > kernelPeak {
			kernelPeak = s.MemoryPeakBytes
		}
		read += s.IOReadBytes
		write += s.IOWriteBytes
		oom += s.OOM + s.OOMKill
		weightedWall += s.IntervalMillis
	}
	out := summaryPayload{SampleIntervalMillis: interval.Milliseconds(), WeightedMeanWallMillis: weightedWall}
	if len(samples) > 0 {
		meanCPU := float64(totalCPU) / float64(len(samples))
		meanMem := totalMem / uint64(len(samples))
		out.CPUMeanMillis = &meanCPU
		out.CPUPeakMillis = &peakCPU
		out.MemoryMeanBytes = &meanMem
		out.MemoryPeakBytes = &peakMem
		out.MemoryKernelPeakBytes = &kernelPeak
		out.IOReadBytes = &read
		out.IOWriteBytes = &write
		out.OOMCount = &oom
	}
	return out
}

func (c *Collector) sequencePath() string {
	return filepath.Join(c.cfg.SpoolDir, ".sequence")
}

func (c *Collector) loadSequenceLocked() {
	if c.sequence > 0 {
		return
	}
	maxSequence := c.cfg.Now().UnixMilli()
	if data, err := os.ReadFile(c.sequencePath()); err == nil {
		if parsed, parseErr := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64); parseErr == nil && parsed > maxSequence {
			maxSequence = parsed
		}
	}
	entries, err := os.ReadDir(c.cfg.SpoolDir)
	if err == nil {
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			sequenceText := strings.TrimSuffix(entry.Name(), ".json")
			if parsed, parseErr := strconv.ParseInt(sequenceText, 10, 64); parseErr == nil && parsed >= maxSequence {
				maxSequence = parsed + 1
			}
		}
	}
	c.sequence = maxSequence
}

func (c *Collector) persistSequenceLocked() {
	if err := os.MkdirAll(c.cfg.SpoolDir, 0o700); err != nil {
		c.cfg.Logger.Warn("resourcehistory: create sequence directory failed", "error", err)
		return
	}
	path := c.sequencePath()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(strconv.FormatInt(c.sequence, 10)), 0o600); err != nil {
		c.cfg.Logger.Warn("resourcehistory: write sequence failed", "error", err)
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		c.cfg.Logger.Warn("resourcehistory: persist sequence failed", "error", err)
	}
}

func (c *Collector) writeSpool(body uploadBody) error {
	if err := os.MkdirAll(c.cfg.SpoolDir, 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	path := filepath.Join(c.cfg.SpoolDir, fmt.Sprintf("%020d.json", body.ChunkSequence))
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return err
	}
	return c.enforceSpoolBudget()
}

func (c *Collector) enforceSpoolBudget() error {
	entries, err := os.ReadDir(c.cfg.SpoolDir)
	if err != nil {
		return err
	}
	type fileInfo struct {
		name string
		size int64
		mod  time.Time
	}
	var files []fileInfo
	var total int64
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, fileInfo{e.Name(), info.Size(), info.ModTime()})
		total += info.Size()
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.Before(files[j].mod) })
	for total > c.cfg.SpoolMaxBytes && len(files) > 0 {
		victim := files[0]
		files = files[1:]
		if err := os.Remove(filepath.Join(c.cfg.SpoolDir, victim.name)); err == nil {
			total -= victim.size
		}
	}
	return nil
}

func (c *Collector) retrySpool(ctx context.Context) {
	entries, err := os.ReadDir(c.cfg.SpoolDir)
	if err != nil {
		return
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		select {
		case <-ctx.Done():
			return
		default:
		}
		path := filepath.Join(c.cfg.SpoolDir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var body uploadBody
		if err := json.Unmarshal(data, &body); err != nil {
			_ = os.Remove(path)
			continue
		}
		if err := c.upload(ctx, body); err != nil {
			if isPermanentUploadError(err) {
				c.cfg.Logger.Warn("resourcehistory: dropping permanently rejected spool file", "file", name, "error", err)
				_ = os.Remove(path)
				continue
			}
			c.cfg.Logger.Debug("resourcehistory: upload failed", "error", err)
			return
		}
		_ = os.Remove(path)
	}
}

func (c *Collector) upload(parent context.Context, body uploadBody) error {
	c.mu.Lock()
	callbackToken := c.cfg.CallbackToken
	controlPlaneURL := c.cfg.ControlPlaneURL
	projectID := c.cfg.ProjectID
	uploadTimeout := c.cfg.UploadTimeout
	httpClient := c.cfg.HTTPClient
	c.mu.Unlock()
	if callbackToken == nil {
		return errors.New("missing callback token")
	}
	token := strings.TrimSpace(callbackToken())
	if token == "" {
		return errors.New("missing callback token")
	}
	ctx, cancel := context.WithTimeout(parent, uploadTimeout)
	defer cancel()
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	url := strings.TrimRight(controlPlaneURL, "/") + "/api/projects/" + projectID + "/workspace-resource-history"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	err = fmt.Errorf("control plane status %d: %s", resp.StatusCode, strings.TrimSpace(string(bodyBytes)))
	if resp.StatusCode >= 400 && resp.StatusCode < 500 && resp.StatusCode != http.StatusTooManyRequests {
		return permanentUploadError{err: err}
	}
	return err
}

func gzipBytes(raw []byte) ([]byte, error) {
	var buf bytes.Buffer
	writer := gzip.NewWriter(&buf)
	if _, err := writer.Write(raw); err != nil {
		_ = writer.Close()
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func hashedToolID(raw string) string {
	digest := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(digest[:])[:16]
}

type cgroupCounters struct {
	CPUUsageUsec  uint64
	MemoryCurrent uint64
	MemoryPeak    uint64
	IOReadBytes   uint64
	IOWriteBytes  uint64
	OOM           uint64
	OOMKill       uint64
	PidsCurrent   uint64
}

func (c *Collector) resolveCgroupPath(ctx context.Context) (string, error) {
	if c.cfg.ContainerID == nil {
		return "", errors.New("container resolver unavailable")
	}
	containerID, err := c.cfg.ContainerID(ctx)
	if err != nil {
		return "", err
	}
	containerID = strings.TrimSpace(containerID)
	if containerID == "" {
		return "", errors.New("container id unavailable")
	}
	return ResolveCgroupPath(ctx, c.cfg.CgroupRoot, c.cfg.ProcRoot, containerID)
}

type errCgroupPathFound struct{ path string }

func (e errCgroupPathFound) Error() string { return e.path }

func normalizeCgroupRoots(cgroupRoot, procRoot string) (string, string) {
	cgroupRoot = strings.TrimSpace(cgroupRoot)
	if cgroupRoot == "" {
		cgroupRoot = "/sys/fs/cgroup"
	}
	procRoot = strings.TrimSpace(procRoot)
	if procRoot == "" {
		procRoot = "/proc"
	}
	return cgroupRoot, procRoot
}

func shortContainerID(containerID string) string {
	if len(containerID) <= 12 {
		return containerID
	}
	return containerID[:12]
}

func cgroupPathCandidates(cgroupRoot, containerID, shortID string) []string {
	return []string{
		filepath.Join(cgroupRoot, "docker", containerID),
		filepath.Join(cgroupRoot, "docker", shortID),
		filepath.Join(cgroupRoot, "system.slice", "docker-"+containerID+".scope"),
		filepath.Join(cgroupRoot, "system.slice", "docker-"+shortID+".scope"),
	}
}

func firstExistingCgroupPath(candidates []string) string {
	for _, p := range candidates {
		if hasCgroupFiles(p) {
			return p
		}
	}
	return ""
}

func walkCgroupPath(ctx context.Context, cgroupRoot, containerID, shortID string) (string, error) {
	visited := 0
	walkErr := filepath.WalkDir(cgroupRoot, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		visited++
		if visited > 5000 {
			return filepath.SkipAll
		}
		if !d.IsDir() {
			return nil
		}
		if cgroupEntryMatches(d.Name(), containerID, shortID) && hasCgroupFiles(p) {
			return errCgroupPathFound{path: p}
		}
		return nil
	})
	var found errCgroupPathFound
	if errors.As(walkErr, &found) {
		return found.path, nil
	}
	if walkErr != nil && !errors.Is(walkErr, filepath.SkipAll) {
		return "", walkErr
	}
	return "", nil
}

func cgroupEntryMatches(name, containerID, shortID string) bool {
	return strings.Contains(name, containerID) || strings.Contains(name, shortID)
}

func ResolveCgroupPath(ctx context.Context, cgroupRoot, procRoot, containerID string) (string, error) {
	cgroupRoot, _ = normalizeCgroupRoots(cgroupRoot, procRoot)
	shortID := shortContainerID(containerID)
	if path := firstExistingCgroupPath(cgroupPathCandidates(cgroupRoot, containerID, shortID)); path != "" {
		return path, nil
	}
	if path, err := walkCgroupPath(ctx, cgroupRoot, containerID, shortID); path != "" || err != nil {
		return path, err
	}
	return "", fmt.Errorf("cgroup v2 path not found for container %s", shortID)
}

func hasCgroupFiles(path string) bool {
	if path == "" {
		return false
	}
	if _, err := os.Stat(filepath.Join(path, "cpu.stat")); err != nil {
		return false
	}
	if _, err := os.Stat(filepath.Join(path, "memory.current")); err != nil {
		return false
	}
	return true
}

func readCgroupCounters(path string) (cgroupCounters, error) {
	var out cgroupCounters
	cpu, err := readKeyedUintFile(filepath.Join(path, "cpu.stat"))
	if err != nil {
		return out, err
	}
	out.CPUUsageUsec = cpu["usage_usec"]
	out.MemoryCurrent, _ = readUintFile(filepath.Join(path, "memory.current"))
	out.MemoryPeak, _ = readUintFile(filepath.Join(path, "memory.peak"))
	ioStats, _ := readIOStat(filepath.Join(path, "io.stat"))
	out.IOReadBytes = ioStats[0]
	out.IOWriteBytes = ioStats[1]
	events, _ := readKeyedUintFile(filepath.Join(path, "memory.events"))
	out.OOM = events["oom"]
	out.OOMKill = events["oom_kill"]
	out.PidsCurrent, _ = readUintFile(filepath.Join(path, "pids.current"))
	return out, nil
}

func readUintFile(path string) (uint64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	return strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
}

func readKeyedUintFile(path string) (map[string]uint64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	result := map[string]uint64{}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err == nil {
			result[fields[0]] = value
		}
	}
	return result, nil
}

func readIOStat(path string) ([2]uint64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return [2]uint64{}, err
	}
	var totals [2]uint64
	for _, line := range strings.Split(string(data), "\n") {
		for _, field := range strings.Fields(line) {
			parts := strings.SplitN(field, "=", 2)
			if len(parts) != 2 {
				continue
			}
			value, err := strconv.ParseUint(parts[1], 10, 64)
			if err != nil {
				continue
			}
			switch parts[0] {
			case "rbytes":
				totals[0] += value
			case "wbytes":
				totals[1] += value
			}
		}
	}
	return totals, nil
}
