package errorreport

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const snapshotManifestVersion = 1

var (
	sensitiveKeyPattern    = regexp.MustCompile(`(?i)(authorization|cookie|credential|password|private.?key|api.?key|access.?key|secret|token)`)
	sensitiveValuePatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)bearer\s+[a-z0-9._~+/=-]{8,}`),
		regexp.MustCompile(`(?i)(?:github_pat_|gh[pousr]_)[a-z0-9_]{8,}`),
		regexp.MustCompile(`(?i)sk-[a-z0-9_-]{8,}`),
		regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`),
		regexp.MustCompile(`[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`),
		regexp.MustCompile(`(?i)(?:token|secret|password|api[_-]?key|credential)\s*[=:]\s*\S+`),
	}
)

// IncidentContext is the non-sensitive context available to allowlisted collectors.
type IncidentContext struct {
	IncidentID  string
	NodeID      string
	WorkspaceID string
	Source      string
	Timestamp   string
}

// Collector returns one explicitly allowlisted structured document.
type Collector interface {
	Name() string
	Collect(context.Context, IncidentContext) (any, error)
}

// CollectorFunc adapts a function to Collector without exposing arbitrary files.
type CollectorFunc struct {
	CollectorName string
	CollectFunc   func(context.Context, IncidentContext) (any, error)
}

func (c CollectorFunc) Name() string { return c.CollectorName }

func (c CollectorFunc) Collect(ctx context.Context, incident IncidentContext) (any, error) {
	if c.CollectFunc == nil {
		return nil, fmt.Errorf("collector is not configured")
	}
	return c.CollectFunc(ctx, incident)
}

type CollectorOutcome struct {
	Name       string `json:"name"`
	Status     string `json:"status"`
	File       string `json:"file,omitempty"`
	Bytes      int    `json:"bytes"`
	Truncated  bool   `json:"truncated"`
	Redactions int    `json:"redactions"`
	Error      string `json:"error,omitempty"`
}

type SnapshotManifest struct {
	Version      int                `json:"version"`
	IncidentID   string             `json:"incidentId"`
	NodeID       string             `json:"nodeId"`
	WorkspaceID  string             `json:"workspaceId,omitempty"`
	Source       string             `json:"source"`
	CreatedAt    string             `json:"createdAt"`
	Collectors   []CollectorOutcome `json:"collectors"`
	TotalBytes   int                `json:"totalBytes"`
	Redactions   int                `json:"redactions"`
	AnyTruncated bool               `json:"anyTruncated"`
}

type snapshotDocument struct {
	name string
	data []byte
}

func runtimeCollector() Collector {
	return CollectorFunc{
		CollectorName: "runtime-health",
		CollectFunc: func(context.Context, IncidentContext) (any, error) {
			return map[string]any{
				"goRuntime":  runtime.Version(),
				"goroutines": runtime.NumGoroutine(),
				"status":     "running",
			}, nil
		},
	}
}

func (r *Reporter) SetCollectors(collectors ...Collector) {
	if r == nil {
		return
	}
	r.collectorsMu.Lock()
	defer r.collectorsMu.Unlock()
	r.collectors = []Collector{runtimeCollector()}
	for _, collector := range collectors {
		if collector != nil && len(r.collectors) < r.config.MaxCollectorDocs {
			r.collectors = append(r.collectors, collector)
		}
	}
}

func (r *Reporter) recoverPendingSnapshots() {
	rows, err := r.readPendingSnapshots()
	if err != nil {
		return
	}
	for _, row := range rows {
		r.startSnapshot(row)
	}
}

func (r *Reporter) startSnapshot(row outboxRow) {
	r.snapshotWG.Add(1)
	go func() {
		defer r.snapshotWG.Done()
		r.collectSnapshot(row)
	}()
}

func (r *Reporter) collectSnapshot(row outboxRow) {
	if r == nil || r.db == nil {
		return
	}
	r.collectMu.Lock()
	defer r.collectMu.Unlock()

	var state string
	if err := r.db.QueryRow(`SELECT artifact_state FROM error_report_outbox WHERE incident_id = ?`,
		row.entry.IncidentID).Scan(&state); err != nil || state != "pending" {
		return
	}

	path, manifest, preview, checksum, size, err := r.buildSnapshot(row.entry)
	if err != nil {
		r.markSnapshotFailed(row.entry.IncidentID, err)
		return
	}
	if err := r.markSnapshotReady(row.entry.IncidentID, path, manifest, preview, checksum, size); err != nil {
		_ = os.Remove(path)
		return
	}
	r.signalFlush()
}

func (r *Reporter) buildSnapshot(entry ErrorEntry) (string, string, string, string, int64, error) {
	if r.config.SpoolDir == "" {
		return "", "", "", "", 0, fmt.Errorf("private evidence spool is not configured")
	}
	if err := os.MkdirAll(r.config.SpoolDir, 0o700); err != nil {
		return "", "", "", "", 0, fmt.Errorf("create evidence spool: %w", err)
	}
	if err := os.Chmod(r.config.SpoolDir, 0o700); err != nil {
		return "", "", "", "", 0, fmt.Errorf("restrict evidence spool: %w", err)
	}
	used, err := spoolBytes(r.config.SpoolDir)
	if err != nil {
		return "", "", "", "", 0, err
	}
	if used >= r.config.SpoolMaxBytes {
		return "", "", "", "", 0, fmt.Errorf("evidence spool quota reached")
	}

	incident := IncidentContext{
		IncidentID:  entry.IncidentID,
		NodeID:      r.nodeID,
		WorkspaceID: entry.WorkspaceID,
		Source:      entry.Source,
		Timestamp:   entry.Timestamp,
	}
	ctx, cancel := context.WithTimeout(context.Background(), r.config.CollectorTimeout)
	defer cancel()

	r.collectorsMu.RLock()
	collectors := append([]Collector(nil), r.collectors...)
	r.collectorsMu.RUnlock()
	documents := make([]snapshotDocument, 0, len(collectors)+1)
	previews := make(map[string]any, len(collectors))
	manifest := SnapshotManifest{
		Version:     snapshotManifestVersion,
		IncidentID:  incident.IncidentID,
		NodeID:      sanitizeString(incident.NodeID),
		WorkspaceID: sanitizeString(incident.WorkspaceID),
		Source:      sanitizeString(incident.Source),
		CreatedAt:   incident.Timestamp,
		Collectors:  make([]CollectorOutcome, 0, len(collectors)),
	}

	for index, collector := range collectors {
		name := safeCollectorName(collector.Name(), index)
		outcome := CollectorOutcome{Name: name, Status: "available"}
		value, collectErr := collector.Collect(ctx, incident)
		if collectErr != nil {
			outcome.Status = "failed"
			outcome.Error = "collector failed"
			manifest.Collectors = append(manifest.Collectors, outcome)
			continue
		}
		safe, stats := sanitizeValue(value, r.config)
		data, marshalErr := json.MarshalIndent(safe, "", "  ")
		if marshalErr != nil {
			outcome.Status = "failed"
			outcome.Error = "collector output was not serializable"
			manifest.Collectors = append(manifest.Collectors, outcome)
			continue
		}
		// MaxDocumentBytes is also the cumulative preview budget. Registration
		// remains bounded even when every allowlisted collector returns data.
		if len(data) > r.config.MaxDocumentBytes || manifest.TotalBytes+len(data) > r.config.MaxDocumentBytes {
			safe = map[string]any{"status": "truncated", "reason": "document byte limit"}
			data, _ = json.MarshalIndent(safe, "", "  ")
			stats.truncated = true
		}
		outcome.File = "collectors/" + name + ".json"
		outcome.Bytes = len(data)
		outcome.Truncated = stats.truncated
		outcome.Redactions = stats.redactions
		manifest.TotalBytes += len(data)
		manifest.Redactions += stats.redactions
		manifest.AnyTruncated = manifest.AnyTruncated || stats.truncated
		manifest.Collectors = append(manifest.Collectors, outcome)
		documents = append(documents, snapshotDocument{name: outcome.File, data: data})
		previews[name] = safe
	}

	manifestData, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return "", "", "", "", 0, err
	}
	previewData, err := json.Marshal(previews)
	if err != nil {
		return "", "", "", "", 0, err
	}
	documents = append(documents, snapshotDocument{name: "manifest.json", data: manifestData})

	path, size, checksum, err := r.writeArchive(entry.IncidentID, documents)
	if err != nil {
		return "", "", "", "", 0, err
	}
	return path, string(manifestData), string(previewData), checksum, size, nil
}

type sanitizeStats struct {
	items      int
	redactions int
	truncated  bool
}

func sanitizeValue(value any, cfg Config) (any, sanitizeStats) {
	data, err := json.Marshal(value)
	if err != nil {
		return map[string]any{"status": "unavailable"}, sanitizeStats{truncated: true}
	}
	var decoded any
	if err := json.Unmarshal(data, &decoded); err != nil {
		return map[string]any{"status": "unavailable"}, sanitizeStats{truncated: true}
	}
	stats := sanitizeStats{}
	return sanitizeRecursive(decoded, 0, cfg, &stats), stats
}

func sanitizeRecursive(value any, depth int, cfg Config, stats *sanitizeStats) any {
	if depth >= cfg.MaxValueDepth || stats.items >= cfg.MaxValueItems {
		stats.truncated = true
		return "[TRUNCATED]"
	}
	stats.items++
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		result := make(map[string]any, len(keys))
		for _, key := range keys {
			if stats.items >= cfg.MaxValueItems {
				stats.truncated = true
				break
			}
			if sensitiveKeyPattern.MatchString(key) {
				result[key] = "[REDACTED]"
				stats.redactions++
				continue
			}
			result[key] = sanitizeRecursive(typed[key], depth+1, cfg, stats)
		}
		return result
	case []any:
		result := make([]any, 0, len(typed))
		for _, item := range typed {
			if stats.items >= cfg.MaxValueItems {
				stats.truncated = true
				break
			}
			result = append(result, sanitizeRecursive(item, depth+1, cfg, stats))
		}
		return result
	case string:
		value := sanitizeString(typed)
		if value == "[REDACTED]" {
			stats.redactions++
		}
		if len(value) > cfg.MaxStringBytes {
			stats.truncated = true
			value = truncateUTF8(value, cfg.MaxStringBytes) + "[TRUNCATED]"
		}
		return value
	default:
		return typed
	}
}

func sanitizeString(value string) string {
	for _, pattern := range sensitiveValuePatterns {
		if pattern.MatchString(value) {
			return "[REDACTED]"
		}
	}
	return value
}

func truncateUTF8(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	cut := maxBytes
	for cut > 0 && !utf8.ValidString(value[:cut]) {
		cut--
	}
	return value[:cut]
}

func safeCollectorName(name string, index int) string {
	name = strings.ToLower(strings.TrimSpace(name))
	valid := regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,47}$`)
	if !valid.MatchString(name) {
		return fmt.Sprintf("collector-%d", index+1)
	}
	return name
}

type limitWriter struct {
	written int64
	max     int64
	w       io.Writer
}

func (w *limitWriter) Write(data []byte) (int, error) {
	if w.written+int64(len(data)) > w.max {
		return 0, fmt.Errorf("artifact exceeds %d bytes", w.max)
	}
	n, err := w.w.Write(data)
	w.written += int64(n)
	return n, err
}

func (r *Reporter) writeArchive(incidentID string, documents []snapshotDocument) (string, int64, string, error) {
	temp, err := os.CreateTemp(r.config.SpoolDir, ".incident-*.tmp")
	if err != nil {
		return "", 0, "", err
	}
	tempPath := temp.Name()
	removeTemp := true
	defer func() {
		_ = temp.Close()
		if removeTemp {
			_ = os.Remove(tempPath)
		}
	}()
	if err := temp.Chmod(0o600); err != nil {
		return "", 0, "", err
	}
	limited := &limitWriter{w: temp, max: r.config.ArtifactMaxBytes}
	archive := gzip.NewWriter(limited)
	archive.Header.ModTime = time.Unix(0, 0).UTC()
	tarWriter := tar.NewWriter(archive)
	for _, document := range documents {
		header := &tar.Header{
			Name: document.name, Mode: 0o600, Size: int64(len(document.data)),
			ModTime: time.Unix(0, 0).UTC(), Typeflag: tar.TypeReg,
		}
		if err := tarWriter.WriteHeader(header); err != nil {
			return "", 0, "", err
		}
		if _, err := tarWriter.Write(document.data); err != nil {
			return "", 0, "", err
		}
	}
	if err := tarWriter.Close(); err != nil {
		return "", 0, "", err
	}
	if err := archive.Close(); err != nil {
		return "", 0, "", err
	}
	if err := temp.Sync(); err != nil {
		return "", 0, "", err
	}
	if err := temp.Close(); err != nil {
		return "", 0, "", err
	}
	finalPath := filepath.Join(r.config.SpoolDir, incidentID+".tar.gz")
	if err := os.Rename(tempPath, finalPath); err != nil {
		return "", 0, "", err
	}
	removeTemp = false
	checksum, size, err := hashFile(finalPath)
	if err != nil {
		_ = os.Remove(finalPath)
		return "", 0, "", err
	}
	return finalPath, size, checksum, nil
}

func hashFile(path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(hash.Sum(nil)), size, nil
}

func spoolBytes(dir string) (int64, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, err
	}
	var total int64
	for _, entry := range entries {
		if entry.Type().IsRegular() {
			info, err := entry.Info()
			if err != nil {
				return 0, err
			}
			total += info.Size()
		}
	}
	return total, nil
}

func (r *Reporter) cleanupSpool() error {
	if r.config.SpoolDir == "" {
		return nil
	}
	if err := os.MkdirAll(r.config.SpoolDir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(r.config.SpoolDir, 0o700); err != nil {
		return err
	}
	referenced, err := r.referencedSpoolPaths()
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(r.config.SpoolDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		path := filepath.Join(r.config.SpoolDir, entry.Name())
		if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() {
			continue
		}
		if _, ok := referenced[path]; !ok {
			_ = os.Remove(path)
		}
	}
	return nil
}
