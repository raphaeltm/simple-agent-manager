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

	mu          sync.Mutex
	authToken   string
	workspaceID string // dynamically set after workspace creation
	sessionID   string // dynamically updated when warm node is reused for new task

	// flushMu serializes flush() calls with outbox mutations in SetSessionID.
	// Lock ordering: flushMu must always be acquired BEFORE mu when both
	// are held. Acquiring mu first would risk deadlock with flush().
	flushMu sync.Mutex

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
		cfg:         cfg,
		db:          db,
		client:      &http.Client{Timeout: cfg.HTTPTimeout},
		workspaceID: cfg.WorkspaceID,
		sessionID:   cfg.SessionID,
		stopC:       make(chan struct{}),
		doneC:       make(chan struct{}),
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

// SetWorkspaceID updates the workspace ID used in the batch POST URL.
// Call this after the first workspace is created on the node, since the
// workspace ID is not known at VM boot time (cloud-init only sets NODE_ID).
func (r *Reporter) SetWorkspaceID(id string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.workspaceID = id
	r.mu.Unlock()
	slog.Info("messagereport: workspace ID updated", "workspaceId", id)
}

// SetSessionID updates the chat session ID used for all subsequently enqueued
// messages. Call this when a warm node is reused for a new task so that
// messages are tagged with the correct chat session.
//
// Any unsent messages from the previous session are cleared from the outbox
// to prevent cross-contamination when a warm node is reused. The flushMu
// is held during the clear to ensure no in-progress flush can ship stale
// messages after the outbox is cleared.
func (r *Reporter) SetSessionID(id string) {
	if r == nil {
		return
	}

	// Acquire flushMu FIRST to block any concurrent flush, then read the
	// old session ID under mu. This closes the window where a flush could
	// start between reading oldSessionID and clearing the outbox.
	r.flushMu.Lock()

	r.mu.Lock()
	oldSessionID := r.sessionID
	r.mu.Unlock()

	// Clear stale messages from the previous session BEFORE updating the
	// session ID to prevent a race where Enqueue reads the new sessionID
	// while old messages are still in the outbox.
	if oldSessionID != "" && oldSessionID != id {
		cleared, err := r.clearOutboxForSession(oldSessionID)
		if err != nil {
			slog.Error("messagereport: failed to clear outbox on session switch",
				"error", err, "oldSessionId", oldSessionID, "newSessionId", id)
		} else if cleared > 0 {
			slog.Warn("messagereport: cleared stale outbox messages on session switch",
				"cleared", cleared, "oldSessionId", oldSessionID, "newSessionId", id)
		}

		// Update session ID while still holding flushMu so that no flush
		// can observe the new session ID with stale outbox contents.
		r.mu.Lock()
		r.sessionID = id
		r.mu.Unlock()

		r.flushMu.Unlock()

		slog.Info("messagereport: session ID updated",
			"sessionId", id, "previousSessionId", oldSessionID)
	} else {
		r.mu.Lock()
		r.sessionID = id
		r.mu.Unlock()

		r.flushMu.Unlock()
	}
}

// clearOutboxForSession removes messages for a specific session from the
// outbox. Returns the number of rows deleted. Using a session-scoped delete
// avoids accidentally clearing messages that were already enqueued for the
// new session in a narrow race window.
func (r *Reporter) clearOutboxForSession(sessionID string) (int64, error) {
	result, err := r.db.Exec("DELETE FROM message_outbox WHERE session_id = ?", sessionID)
	if err != nil {
		return 0, fmt.Errorf("messagereport: clear outbox for session: %w", err)
	}
	n, err := result.RowsAffected()
	if err != nil {
		slog.Warn("messagereport: could not determine rows affected by outbox clear", "error", err)
		n = -1
	}
	return n, nil
}

// Enqueue inserts a message into the SQLite outbox for eventual delivery.
// It is non-blocking and safe to call from any goroutine.
// Returns an error if the outbox is at capacity.
func (r *Reporter) Enqueue(msg Message) error {
	if r == nil {
		return nil
	}

	// Check outbox size using a bounded count instead of COUNT(*) over the
	// entire table. LIMIT caps the scan at OutboxMaxSize rows.
	var count int
	if err := r.db.QueryRow(
		"SELECT COUNT(*) FROM (SELECT 1 FROM message_outbox LIMIT ?)",
		r.cfg.OutboxMaxSize+1,
	).Scan(&count); err != nil {
		return fmt.Errorf("messagereport: check outbox capacity: %w", err)
	}
	if count >= r.cfg.OutboxMaxSize {
		slog.Warn("messagereport: outbox full, dropping message",
			"outboxSize", count, "maxSize", r.cfg.OutboxMaxSize, "messageId", msg.MessageID)
		return fmt.Errorf("messagereport: outbox full (%d/%d)", count, r.cfg.OutboxMaxSize)
	}

	if msg.Timestamp == "" {
		msg.Timestamp = time.Now().UTC().Format(time.RFC3339Nano)
	}

	// Use the dynamically updatable session ID (updated via SetSessionID
	// when a warm node is reused for a new task).
	r.mu.Lock()
	sessionID := r.sessionID
	workspaceID := r.workspaceID
	r.mu.Unlock()

	// Principle XIII (Fail-Fast): Reject messages when no session ID is set.
	// This is a defensive check — by construction, a non-nil Reporter should
	// always have sessionID set via New() or SetSessionID(). But during warm
	// node transitions, there's a brief window where sessionID could be empty.
	// Rejecting here prevents unroutable messages from being enqueued.
	if sessionID == "" {
		slog.Error("messagereport: rejected message with empty session ID",
			"workspaceId", workspaceID,
			"messageId", msg.MessageID,
			"role", msg.Role,
			"action", "rejected")
		return fmt.Errorf("messagereport: cannot enqueue message without session ID")
	}

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
//
// flushMu is held for the duration to serialize with SetSessionID's
// outbox clear, preventing stale messages from being shipped after a
// session switch.
func (r *Reporter) flush() {
	r.flushMu.Lock()
	defer r.flushMu.Unlock()

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
		 ORDER BY id ASC
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
	wsID := r.workspaceID
	r.mu.Unlock()

	if token == "" {
		// No token yet — leave messages in outbox for later.
		return fmt.Errorf("no auth token")
	}
	if wsID == "" {
		// No workspace yet — leave messages in outbox for later.
		return fmt.Errorf("no workspace ID")
	}

	// Build the request body matching the API contract.
	type apiMessage struct {
		MessageID    string `json:"messageId"`
		SessionID    string `json:"sessionId"`
		Role         string `json:"role"`
		Content      string `json:"content"`
		ToolMetadata string `json:"toolMetadata,omitempty"`
		Timestamp    string `json:"timestamp"`
		Sequence     int64  `json:"sequence"`
	}
	messages := make([]apiMessage, 0, len(batch))
	for _, row := range batch {
		m := apiMessage{
			MessageID: row.messageID,
			SessionID: row.sessionID,
			Role:      row.role,
			Content:   row.content,
			Timestamp: row.createdAt,
			Sequence:  row.id, // outbox AUTOINCREMENT id is monotonic
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
		"/api/workspaces/" + wsID + "/messages"

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
