// Package errorreport durably sends structured VM incidents and safe evidence.
// All methods are nil-safe: a nil *Reporter is a no-op.
package errorreport

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

// ErrorEntry is a stable incident sent to the control plane.
type ErrorEntry struct {
	IncidentID  string                 `json:"incidentId"`
	Level       string                 `json:"level"`
	Message     string                 `json:"message"`
	Source      string                 `json:"source"`
	Stack       string                 `json:"stack,omitempty"`
	WorkspaceID string                 `json:"workspaceId,omitempty"`
	Timestamp   string                 `json:"timestamp"`
	Context     map[string]interface{} `json:"context,omitempty"`
}

// Reporter uses a SQLite WAL outbox so delivery survives VM-agent restarts.
type Reporter struct {
	apiBaseURL string
	nodeID     string
	config     Config
	client     *http.Client
	db         *sql.DB
	initErr    error
	id         monotonicULID

	stateMu     sync.RWMutex
	authToken   string
	lifecycleMu sync.Mutex

	collectorsMu sync.RWMutex
	collectors   []Collector
	collectorSem chan struct{}
	spoolRoot    *os.Root

	wakeC          chan struct{}
	stopC          chan struct{}
	doneC          chan struct{}
	snapshotWakeC  chan struct{}
	snapshotStopC  chan struct{}
	snapshotDoneC  chan struct{}
	startOnce      sync.Once
	shutdownOnce   sync.Once
	started        atomic.Bool
	snapshotActive atomic.Bool
	closed         atomic.Bool
}

// New creates a reporter. InitError reports a disk/configuration failure.
func New(apiBaseURL, nodeID, authToken string, cfg Config) *Reporter {
	cfg = cfg.withDefaults()
	var db *sql.DB
	var err error
	if spoolContainsPath(cfg.SpoolDir, cfg.DBPath) {
		err = fmt.Errorf("private spool directory must not contain the outbox database")
	} else {
		db, err = openOutbox(cfg.DBPath, cfg.DBBusyTimeout)
	}
	r := &Reporter{
		apiBaseURL:    strings.TrimRight(apiBaseURL, "/"),
		nodeID:        nodeID,
		authToken:     authToken,
		config:        cfg,
		client:        config.NewControlPlaneClient(cfg.HTTPTimeout),
		db:            db,
		initErr:       err,
		wakeC:         make(chan struct{}, 1),
		stopC:         make(chan struct{}),
		doneC:         make(chan struct{}),
		snapshotWakeC: make(chan struct{}, 1),
		snapshotStopC: make(chan struct{}),
		snapshotDoneC: make(chan struct{}),
		collectorSem:  make(chan struct{}, cfg.CollectorWorkers),
	}
	r.SetCollectors()
	if err == nil && cfg.SpoolDir != "" {
		r.spoolRoot, err = openPrivateSpoolRoot(cfg.SpoolDir)
		if err != nil {
			r.initErr = fmt.Errorf("open private spool: %w", err)
		} else {
			r.config.SpoolDir = r.spoolRoot.Name()
		}
	}
	if r.initErr == nil {
		if cleanupErr := r.cleanupSpool(); cleanupErr != nil {
			r.initErr = fmt.Errorf("cleanup private spool: %w", cleanupErr)
		}
	}
	return r
}

// InitError returns any durable-storage initialization failure.
func (r *Reporter) InitError() error {
	if r == nil {
		return nil
	}
	return r.initErr
}

// SetToken atomically refreshes the callback JWT used by later retries.
func (r *Reporter) SetToken(token string) {
	if r == nil {
		return
	}
	r.stateMu.Lock()
	r.authToken = token
	r.stateMu.Unlock()
	r.signalFlush()
}

// Start launches snapshot recovery and the serialized delivery loop once.
func (r *Reporter) Start() {
	if r == nil || r.initErr != nil {
		return
	}
	r.lifecycleMu.Lock()
	defer r.lifecycleMu.Unlock()
	if r.closed.Load() {
		return
	}
	r.startOnce.Do(func() {
		r.started.Store(true)
		r.snapshotActive.Store(true)
		go r.snapshotLoop()
		go r.flushLoop()
		r.signalSnapshot()
		r.signalFlush()
	})
}

// Shutdown is idempotent and performs one final serialized flush.
func (r *Reporter) Shutdown() {
	if r == nil {
		return
	}
	r.shutdownOnce.Do(func() {
		r.lifecycleMu.Lock()
		r.closed.Store(true)
		started := r.started.Load()
		snapshotActive := r.snapshotActive.Load()
		if snapshotActive {
			close(r.snapshotStopC)
		}
		r.lifecycleMu.Unlock()
		if snapshotActive {
			<-r.snapshotDoneC
		}
		if started {
			close(r.stopC)
			<-r.doneC
		} else if r.db != nil {
			r.flush()
		}
		if r.db != nil {
			_ = r.db.Close()
		}
		if r.spoolRoot != nil {
			_ = r.spoolRoot.Close()
		}
	})
}

// Report durably enqueues an entry and returns its stable incident ULID.
func (r *Reporter) Report(entry ErrorEntry) string {
	if r == nil || r.db == nil {
		return ""
	}
	r.lifecycleMu.Lock()
	defer r.lifecycleMu.Unlock()
	if r.closed.Load() {
		return ""
	}
	if !validIncidentID.MatchString(entry.IncidentID) {
		entry.IncidentID = r.id.next(time.Now())
	}
	if entry.Timestamp == "" {
		entry.Timestamp = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if entry.Level == "" {
		entry.Level = "error"
	}
	entry.Message = r.safeText(entry.Message)
	entry.Stack = r.safeText(entry.Stack)
	entry.Source = r.safeText(entry.Source)
	entry.WorkspaceID = r.safeText(entry.WorkspaceID)
	safeContext, _ := sanitizeValue(entry.Context, r.config)
	contextJSON, err := json.Marshal(safeContext)
	if err != nil {
		contextJSON = []byte("{}")
	}
	if safeMap, ok := safeContext.(map[string]any); ok {
		entry.Context = safeMap
	} else {
		entry.Context = nil
	}

	err = r.insertEntry(entry, string(contextJSON))
	if err != nil {
		slog.Warn("errorreport: durable enqueue failed", "incidentId", entry.IncidentID, "error", boundedError(err, r.config.StoredErrorBytes))
		return entry.IncidentID
	}
	if entry.Level == "error" {
		r.signalSnapshot()
	}
	r.signalFlush()
	return entry.IncidentID
}

func (r *Reporter) safeText(value string) string {
	value = sanitizeString(value)
	if len(value) > r.config.MaxStringBytes {
		return truncateUTF8(value, r.config.MaxStringBytes) + "[TRUNCATED]"
	}
	return value
}

func (r *Reporter) ReportError(err error, source, workspaceID string, ctx map[string]interface{}) {
	if r == nil {
		return
	}
	message := "unknown error"
	if err != nil {
		message = err.Error()
	}
	r.Report(ErrorEntry{
		Level: "error", Message: message, Source: source, Stack: message,
		WorkspaceID: workspaceID, Context: ctx,
	})
}

func (r *Reporter) ReportInfo(message, source, workspaceID string, ctx map[string]interface{}) {
	if r == nil {
		return
	}
	r.Report(ErrorEntry{Level: "info", Message: message, Source: source, WorkspaceID: workspaceID, Context: ctx})
}

func (r *Reporter) ReportWarn(message, source, workspaceID string, ctx map[string]interface{}) {
	if r == nil {
		return
	}
	r.Report(ErrorEntry{Level: "warn", Message: message, Source: source, WorkspaceID: workspaceID, Context: ctx})
}

func (r *Reporter) signalFlush() {
	if r == nil || !r.started.Load() || r.closed.Load() {
		return
	}
	select {
	case r.wakeC <- struct{}{}:
	default:
	}
}

func (r *Reporter) flushLoop() {
	defer close(r.doneC)
	timer := time.NewTimer(r.config.FlushInterval)
	defer timer.Stop()
	resetTimer := func() {
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(r.nextFlushDelay())
	}
	for {
		select {
		case <-r.stopC:
			r.flush()
			return
		case <-r.wakeC:
			r.flush()
			resetTimer()
		case <-timer.C:
			r.flush()
			resetTimer()
		}
	}
}

func (r *Reporter) flush() {
	if r == nil || r.db == nil {
		return
	}
	if err := r.terminalizeExpired(); err != nil {
		slog.Warn("errorreport: expiry terminalization failed", "error", boundedError(err, r.config.StoredErrorBytes))
	}
	if err := r.flushReports(); err != nil {
		slog.Warn("errorreport: structured incident flush failed", "error", boundedError(err, r.config.StoredErrorBytes))
		return
	}
	if err := r.flushArtifacts(); err != nil {
		slog.Warn("errorreport: evidence flush failed", "error", boundedError(err, r.config.StoredErrorBytes))
	}
	if err := r.deleteAcknowledged(); err != nil {
		slog.Warn("errorreport: acknowledged cleanup failed", "error", boundedError(err, r.config.StoredErrorBytes))
	}
}

func (r *Reporter) flushReports() error {
	rows, err := r.readReportCandidates()
	if err != nil || len(rows) == 0 {
		return err
	}
	token := r.token()
	if token == "" {
		return fmt.Errorf("callback token is not available")
	}
	batch, body, err := r.buildReportBatch(rows)
	if err != nil {
		_ = r.markAttempt(rows[:1], err, true)
		return err
	}
	status, response, err := r.doRequest(context.Background(), http.MethodPost,
		r.apiBaseURL+"/api/nodes/"+url.PathEscape(r.nodeID)+"/errors", token,
		"application/json", bytes.NewReader(body), int64(len(body)), "")
	if err == nil && status >= 200 && status < 300 {
		return r.markReportAcknowledged(batch)
	}
	deliveryErr := fmt.Errorf("status=%d response=%s transport=%v", status, response, err)
	permanent := status == http.StatusBadRequest || status == http.StatusForbidden || status == http.StatusRequestEntityTooLarge
	_ = r.markAttempt(batch, deliveryErr, permanent)
	return deliveryErr
}

func (r *Reporter) buildReportBatch(rows []outboxRow) ([]outboxRow, []byte, error) {
	batch := make([]outboxRow, 0, len(rows))
	var body []byte
	for _, row := range rows {
		var contextValue map[string]interface{}
		_ = json.Unmarshal([]byte(row.contextJSON), &contextValue)
		row.entry.Context = contextValue
		candidate := append(append([]outboxRow(nil), batch...), row)
		entries := make([]ErrorEntry, 0, len(candidate))
		for _, item := range candidate {
			entries = append(entries, item.entry)
		}
		encoded, err := json.Marshal(map[string]any{"errors": entries})
		if err != nil {
			return nil, nil, err
		}
		if len(batch) > 0 && len(encoded) > r.config.MaxBatchBytes {
			break
		}
		batch = candidate
		body = encoded
	}
	if len(body) > r.config.MaxBatchBytes {
		return batch, nil, fmt.Errorf("single structured incident exceeds %d bytes", r.config.MaxBatchBytes)
	}
	return batch, body, nil
}

func (r *Reporter) flushArtifacts() error {
	rows, err := r.readDeliverableArtifacts()
	if err != nil {
		return err
	}
	for _, row := range rows {
		if err := r.deliverArtifact(row); err != nil {
			return err
		}
	}
	return nil
}

func (r *Reporter) deliverArtifact(row outboxRow) error {
	token := r.token()
	if token == "" {
		return fmt.Errorf("callback token is not available")
	}
	var file *os.File
	if row.artifactState == "ready" {
		var err error
		file, err = r.openReadyArtifact(row)
		if err != nil {
			if markErr := r.markArtifactUnavailable(row, err); markErr != nil {
				return markErr
			}
			row.artifactState = "failed"
			row.spoolPath = ""
			row.manifestJSON = `{"version":1,"collectors":[],"unavailable":true}`
			row.previewJSON = `{}`
			row.checksum = ""
			row.sizeBytes = 0
		}
	}
	if file != nil {
		defer file.Close()
	}

	artifactID := row.entry.IncidentID + "-safe"
	registration, err := json.Marshal(map[string]any{
		"artifactId":     artifactID,
		"kind":           "safe-vm-incident-v1",
		"contentType":    "application/gzip",
		"sizeBytes":      row.sizeBytes,
		"checksumSha256": row.checksum,
		"manifest":       json.RawMessage(row.manifestJSON),
		"preview":        json.RawMessage(row.previewJSON),
		"status":         row.artifactState,
	})
	if err != nil {
		return err
	}
	base := r.apiBaseURL + "/api/nodes/" + url.PathEscape(r.nodeID) + "/diagnostic-incidents/" + url.PathEscape(row.entry.IncidentID) + "/artifacts"
	status, response, requestErr := r.doRequest(context.Background(), http.MethodPost, base, token,
		"application/json", bytes.NewReader(registration), int64(len(registration)), "")
	if requestErr != nil || !success(status) {
		return r.handleArtifactFailure(row, status, response, requestErr)
	}
	if row.artifactState == "failed" {
		return r.markArtifactAcknowledged(row)
	}
	status, response, requestErr = r.doRequest(context.Background(), http.MethodPut,
		base+"/"+url.PathEscape(artifactID)+"/content", token, "application/gzip",
		file, row.sizeBytes, row.checksum)
	if requestErr != nil || !successOrConflict(status) {
		return r.handleArtifactFailure(row, status, response, requestErr)
	}
	return r.markArtifactAcknowledged(row)
}

func (r *Reporter) openReadyArtifact(row outboxRow) (*os.File, error) {
	if r.spoolRoot == nil || !r.isPrivateSpoolPath(row.spoolPath) {
		return nil, fmt.Errorf("artifact path is outside the private spool")
	}
	name := filepath.Base(row.spoolPath)
	pathInfo, err := r.spoolRoot.Lstat(name)
	if err != nil || !pathInfo.Mode().IsRegular() {
		if err == nil {
			err = fmt.Errorf("spooled artifact is not a regular file")
		}
		return nil, err
	}
	file, err := r.spoolRoot.Open(name)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != row.sizeBytes {
		_ = file.Close()
		if err == nil {
			err = fmt.Errorf("spooled artifact changed before upload")
		}
		return nil, err
	}
	return file, nil
}

func successOrConflict(status int) bool {
	return success(status) || status == http.StatusConflict
}

func success(status int) bool { return status >= 200 && status < 300 }

func (r *Reporter) handleArtifactFailure(row outboxRow, status int, response string, requestErr error) error {
	deliveryErr := fmt.Errorf("status=%d response=%s transport=%v", status, response, requestErr)
	permanent := status == http.StatusBadRequest || status == http.StatusForbidden ||
		status == http.StatusNotFound || status == http.StatusRequestEntityTooLarge
	_ = r.markAttempt([]outboxRow{row}, deliveryErr, permanent)
	return deliveryErr
}

func (r *Reporter) token() string {
	r.stateMu.RLock()
	defer r.stateMu.RUnlock()
	return r.authToken
}

func (r *Reporter) doRequest(
	ctx context.Context,
	method, endpoint, token, contentType string,
	body io.Reader,
	contentLength int64,
	checksum string,
) (int, string, error) {
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", contentType)
	if contentLength >= 0 {
		req.ContentLength = contentLength
	}
	if checksum != "" {
		req.Header.Set("X-Content-SHA256", checksum)
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	response, readErr := io.ReadAll(io.LimitReader(resp.Body, int64(r.config.ResponseMaxBytes)))
	if readErr != nil {
		return resp.StatusCode, "", readErr
	}
	return resp.StatusCode, string(response), nil
}

func (r *Reporter) pendingCount() int {
	if r == nil || r.db == nil {
		return 0
	}
	var count int
	_ = r.db.QueryRow(`SELECT COUNT(*) FROM error_report_outbox`).Scan(&count)
	return count
}

var validIncidentID = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}$`)
