package messagereport

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Message is the unit of work enqueued into the outbox.
type Message struct {
	MessageID    string `json:"messageId"`
	SessionID    string `json:"sessionId"`
	Role         string `json:"role"`
	Content      string `json:"content"`
	ToolMetadata string `json:"toolMetadata,omitempty"` // JSON string
	Timestamp    string `json:"timestamp"`
}

// Reporter batches chat messages from the SQLite outbox and POSTs them to
// the control plane. All methods are nil-safe: a nil *Reporter is a no-op.
type Reporter struct {
	cfg    Config
	db     *sql.DB
	client *http.Client

	mu        sync.Mutex
	authToken string

	stopC chan struct{}
	doneC chan struct{}
}

// New creates a Reporter backed by the given SQLite database.
// It runs the outbox migration and starts the background flush goroutine.
//
// Returns (nil, nil) if cfg.ProjectID or cfg.SessionID is empty — this
// means the workspace has no linked project and persistence is a no-op.
func New(db *sql.DB, cfg Config) (*Reporter, error) {
	if db == nil {
		return nil, fmt.Errorf("messagereport: db must not be nil")
	}
	if cfg.ProjectID == "" || cfg.SessionID == "" {
		// No project or session — reporter is intentionally disabled.
		return nil, nil
	}

	// Apply defaults for any zero-value config fields.
	defaults := DefaultConfig()
	if cfg.BatchMaxWait <= 0 {
		cfg.BatchMaxWait = defaults.BatchMaxWait
	}
	if cfg.BatchMaxSize <= 0 {
		cfg.BatchMaxSize = defaults.BatchMaxSize
	}
	if cfg.BatchMaxBytes <= 0 {
		cfg.BatchMaxBytes = defaults.BatchMaxBytes
	}
	if cfg.OutboxMaxSize <= 0 {
		cfg.OutboxMaxSize = defaults.OutboxMaxSize
	}
	if cfg.RetryInitial <= 0 {
		cfg.RetryInitial = defaults.RetryInitial
	}
	if cfg.RetryMax <= 0 {
		cfg.RetryMax = defaults.RetryMax
	}
	if cfg.RetryMaxElapsed <= 0 {
		cfg.RetryMaxElapsed = defaults.RetryMaxElapsed
	}
	if cfg.HTTPTimeout <= 0 {
		cfg.HTTPTimeout = defaults.HTTPTimeout
	}

	if err := migrateOutbox(db); err != nil {
		return nil, fmt.Errorf("messagereport: migrate outbox: %w", err)
	}

	r := &Reporter{
		cfg:    cfg,
		db:     db,
		client: &http.Client{Timeout: cfg.HTTPTimeout},
		stopC:  make(chan struct{}),
		doneC:  make(chan struct{}),
	}

	go r.flushLoop()
	return r, nil
}

// SetToken updates the authorization token used for HTTP POSTs.
// Call this after bootstrap when the callback JWT becomes available.
func (r *Reporter) SetToken(token string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.authToken = token
	r.mu.Unlock()
}

// Enqueue inserts a message into the SQLite outbox for eventual delivery.
// It is non-blocking and safe to call from any goroutine.
// Returns an error if the outbox is at capacity.
func (r *Reporter) Enqueue(msg Message) error {
	if r == nil {
		return nil
	}

	// Check outbox size.
	var count int
	if err := r.db.QueryRow("SELECT COUNT(*) FROM message_outbox").Scan(&count); err != nil {
		return fmt.Errorf("messagereport: count outbox: %w", err)
	}
	if count >= r.cfg.OutboxMaxSize {
		slog.Warn("messagereport: outbox full, dropping message",
			"outboxSize", count, "maxSize", r.cfg.OutboxMaxSize, "messageId", msg.MessageID)
		return fmt.Errorf("messagereport: outbox full (%d/%d)", count, r.cfg.OutboxMaxSize)
	}

	if msg.Timestamp == "" {
		msg.Timestamp = time.Now().UTC().Format(time.RFC3339Nano)
	}

	// Always use the reporter's configured session ID.
	sessionID := r.cfg.SessionID

	// INSERT OR IGNORE for crash-recovery dedup on message_id UNIQUE constraint.
	_, err := r.db.Exec(
		`INSERT OR IGNORE INTO message_outbox
			(message_id, session_id, role, content, tool_metadata, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		msg.MessageID, sessionID, msg.Role, msg.Content, msg.ToolMetadata, msg.Timestamp,
	)
	if err != nil {
		return fmt.Errorf("messagereport: insert outbox: %w", err)
	}
	return nil
}

// Shutdown signals the background goroutine to stop, performs a final flush,
// and blocks until the goroutine exits.
func (r *Reporter) Shutdown() {
	if r == nil {
		return
	}
	close(r.stopC)
	<-r.doneC
}

// --- background flush loop ---

func (r *Reporter) flushLoop() {
	defer close(r.doneC)

	ticker := time.NewTicker(r.cfg.BatchMaxWait)
	defer ticker.Stop()

	for {
		select {
		case <-r.stopC:
			r.flush() // final flush
			return
		case <-ticker.C:
			r.flush()
		}
	}
}

// flush reads the oldest batch from the outbox and sends it.
// On success the sent rows are deleted; on transient failure they remain
// (attempts counter is bumped) for retry on the next tick.
func (r *Reporter) flush() {
	for {
		batch, err := r.readBatch()
		if err != nil {
			slog.Error("messagereport: read batch", "error", err)
			return
		}
		if len(batch) == 0 {
			return
		}

		if err := r.sendBatch(batch); err != nil {
			// sendBatch handles retry internally; if it returns an error the
			// batch was NOT sent and remains in the outbox for the next tick.
			slog.Warn("messagereport: send batch failed", "error", err, "count", len(batch))
			r.bumpAttempts(batch)
			return
		}

		// Success — delete sent messages from the outbox.
		r.deleteBatch(batch)
	}
}

type outboxRow struct {
	id           int64
	messageID    string
	sessionID    string
	role         string
	content      string
	toolMetadata sql.NullString
	createdAt    string
}

func (r *Reporter) readBatch() ([]outboxRow, error) {
	rows, err := r.db.Query(
		`SELECT id, message_id, session_id, role, content, tool_metadata, created_at
		 FROM message_outbox
		 ORDER BY created_at ASC
		 LIMIT ?`,
		r.cfg.BatchMaxSize,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var batch []outboxRow
	var totalBytes int
	for rows.Next() {
		var row outboxRow
		if err := rows.Scan(&row.id, &row.messageID, &row.sessionID, &row.role, &row.content, &row.toolMetadata, &row.createdAt); err != nil {
			return nil, err
		}
		rowBytes := len(row.content)
		if row.toolMetadata.Valid {
			rowBytes += len(row.toolMetadata.String)
		}
		// Respect byte limit (but always include at least one message).
		if len(batch) > 0 && totalBytes+rowBytes > r.cfg.BatchMaxBytes {
			break
		}
		batch = append(batch, row)
		totalBytes += rowBytes
	}
	return batch, rows.Err()
}

// sendBatch POSTs the batch to the control plane with exponential backoff.
func (r *Reporter) sendBatch(batch []outboxRow) error {
	r.mu.Lock()
	token := r.authToken
	r.mu.Unlock()

	if token == "" {
		// No token yet — leave messages in outbox for later.
		return fmt.Errorf("no auth token")
	}

	// Build the request body matching the API contract.
	type apiMessage struct {
		MessageID    string `json:"messageId"`
		SessionID    string `json:"sessionId"`
		Role         string `json:"role"`
		Content      string `json:"content"`
		ToolMetadata string `json:"toolMetadata,omitempty"`
		Timestamp    string `json:"timestamp"`
	}
	messages := make([]apiMessage, 0, len(batch))
	for _, row := range batch {
		m := apiMessage{
			MessageID: row.messageID,
			SessionID: row.sessionID,
			Role:      row.role,
			Content:   row.content,
			Timestamp: row.createdAt,
		}
		if row.toolMetadata.Valid {
			m.ToolMetadata = row.toolMetadata.String
		}
		messages = append(messages, m)
	}

	payload := map[string]interface{}{
		"messages": messages,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	url := strings.TrimRight(r.cfg.Endpoint, "/") +
		"/api/workspaces/" + r.cfg.WorkspaceID + "/messages"

	// Retry with exponential backoff + jitter.
	delay := r.cfg.RetryInitial
	start := time.Now()

	for {
		statusCode, err := r.doPost(url, token, body)
		if err == nil && statusCode >= 200 && statusCode < 300 {
			return nil // success
		}

		// Permanent client errors — discard the batch.
		if statusCode == 400 || statusCode == 401 || statusCode == 403 {
			slog.Warn("messagereport: permanent error, discarding batch",
				"statusCode", statusCode, "count", len(batch))
			// Delete from outbox so we don't retry forever.
			r.deleteBatch(batch)
			return nil
		}

		// Check elapsed time.
		if time.Since(start) > r.cfg.RetryMaxElapsed {
			return fmt.Errorf("retries exhausted after %v (last status=%d, err=%v)",
				time.Since(start), statusCode, err)
		}

		// Check if we should stop.
		select {
		case <-r.stopC:
			return fmt.Errorf("shutdown during retry")
		default:
		}

		// Backoff with jitter.
		jitter := time.Duration(rand.Int63n(int64(delay) / 2))
		sleepDur := delay + jitter
		slog.Info("messagereport: retrying after backoff",
			"delay", sleepDur, "statusCode", statusCode, "err", err)

		timer := time.NewTimer(sleepDur)
		select {
		case <-timer.C:
		case <-r.stopC:
			timer.Stop()
			return fmt.Errorf("shutdown during backoff")
		}

		// Exponential increase capped at RetryMax.
		delay = time.Duration(math.Min(float64(delay*2), float64(r.cfg.RetryMax)))
	}
}

func (r *Reporter) doPost(url, token string, body []byte) (int, error) {
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := r.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, nil
}

func (r *Reporter) bumpAttempts(batch []outboxRow) {
	now := time.Now().UTC().Format(time.RFC3339)
	for _, row := range batch {
		_, err := r.db.Exec(
			"UPDATE message_outbox SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ?",
			now, row.id,
		)
		if err != nil {
			slog.Error("messagereport: bump attempts", "id", row.id, "error", err)
		}
	}
}

func (r *Reporter) deleteBatch(batch []outboxRow) {
	for _, row := range batch {
		if _, err := r.db.Exec("DELETE FROM message_outbox WHERE id = ?", row.id); err != nil {
			slog.Error("messagereport: delete outbox row", "id", row.id, "error", err)
		}
	}
}
