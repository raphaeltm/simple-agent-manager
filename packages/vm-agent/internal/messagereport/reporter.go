package messagereport

import (
	"database/sql"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	_ "modernc.org/sqlite"
)

// truncationMarker is appended to content that was truncated.
const truncationMarker = "\n\n[truncated]"

const omittedMessageMarker = "[message omitted: exceeded message transport limit]"

// Message is the unit of work enqueued into the outbox.
type Message struct {
	MessageID    string `json:"messageId"`
	SessionID    string `json:"sessionId"`
	Role         string `json:"role"`
	Content      string `json:"content"`
	ToolMetadata string `json:"toolMetadata,omitempty"` // JSON string
	Timestamp    string `json:"timestamp"`
	// Origin is "system" for SAM-injected messages the UI collapses; empty otherwise.
	Origin string `json:"origin,omitempty"`
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
	// messageLimitReached disables persistence for the current chat session
	// once the control plane reports SESSION_MESSAGE_LIMIT_EXCEEDED. Retrying
	// cannot succeed until a new session is selected, so the reporter drops
	// later messages instead of growing an unwinnable outbox.
	messageLimitReached bool
	// terminalPersistenceFailure disables persistence after the control plane
	// reports that this callback resource is no longer valid. Retrying with
	// the same workspace/session token cannot succeed, so later messages are
	// dropped instead of creating permanent-failure storms.
	terminalPersistenceFailure bool
	terminalPersistenceReason  string
	terminalWakeC              chan struct{}

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
	if cfg.MaxMessageContentBytes <= 0 {
		cfg.MaxMessageContentBytes = defaults.MaxMessageContentBytes
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
	if cfg.ResponseMaxBytes <= 0 {
		cfg.ResponseMaxBytes = defaults.ResponseMaxBytes
	}

	if err := migrateOutbox(db); err != nil {
		return nil, fmt.Errorf("messagereport: migrate outbox: %w", err)
	}

	r := &Reporter{
		cfg:           cfg,
		db:            db,
		client:        config.NewControlPlaneClient(cfg.HTTPTimeout),
		workspaceID:   cfg.WorkspaceID,
		sessionID:     cfg.SessionID,
		terminalWakeC: make(chan struct{}, 1),
		stopC:         make(chan struct{}),
		doneC:         make(chan struct{}),
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

	// Acquire flushMu FIRST to block any concurrent flush, then hold mu through
	// the outbox clear and session update. Enqueue also holds mu through its
	// insert, so a concurrent enqueue either lands before the clear and is
	// removed with the old session, or waits and uses the new session ID.
	r.flushMu.Lock()
	defer r.flushMu.Unlock()

	r.mu.Lock()
	defer r.mu.Unlock()
	oldSessionID := r.sessionID

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

		slog.Info("messagereport: session ID updated",
			"sessionId", id, "previousSessionId", oldSessionID)
	}

	if oldSessionID != id {
		r.messageLimitReached = false
	}
	r.sessionID = id
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

	if msg.Timestamp == "" {
		msg.Timestamp = time.Now().UTC().Format(time.RFC3339Nano)
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if r.messageLimitReached {
		return nil
	}
	if r.terminalPersistenceFailure {
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

	// Use the dynamically updatable session ID (updated via SetSessionID
	// when a warm node is reused for a new task).
	sessionID := r.sessionID
	workspaceID := r.workspaceID

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

	// Truncate oversized content to match the API's individual-message limit.
	// sendBatch still has a size fallback for JSON overhead and tool metadata.
	maxBytes := r.cfg.MaxMessageContentBytes
	if len(msg.Content) > maxBytes {
		slog.Warn("messagereport: truncating oversized message content",
			"messageId", msg.MessageID,
			"originalBytes", len(msg.Content),
			"maxBytes", maxBytes,
			"workspaceId", workspaceID,
		)
		msg.Content = truncateContentToLimit(msg.Content, maxBytes)
	}

	// INSERT OR IGNORE for crash-recovery dedup on message_id UNIQUE constraint.
	_, err := r.db.Exec(
		`INSERT OR IGNORE INTO message_outbox
			(message_id, session_id, role, content, tool_metadata, created_at, origin)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		msg.MessageID, sessionID, msg.Role, msg.Content, msg.ToolMetadata, msg.Timestamp, msg.Origin,
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
	origin       sql.NullString
}

func (r *Reporter) readBatch() ([]outboxRow, error) {
	rows, err := r.db.Query(
		`SELECT id, message_id, session_id, role, content, tool_metadata, created_at, origin
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
	for rows.Next() {
		var row outboxRow
		if err := rows.Scan(&row.id, &row.messageID, &row.sessionID, &row.role, &row.content, &row.toolMetadata, &row.createdAt, &row.origin); err != nil {
			return nil, err
		}
		candidate := append(append([]outboxRow(nil), batch...), row)
		payloadBytes, err := marshaledBatchSize(candidate)
		if err != nil {
			return nil, err
		}
		// Respect marshaled payload limit, but always include at least one
		// message so an oversized row can progress to fallback handling.
		if len(batch) > 0 && payloadBytes > r.cfg.BatchMaxBytes {
			break
		}
		batch = append(batch, row)
	}
	return batch, rows.Err()
}

func (r *Reporter) markMessageLimitReached(batch []outboxRow, responseBody string) {
	r.mu.Lock()
	r.messageLimitReached = true
	wsID := r.workspaceID
	sessionID := r.sessionID
	r.mu.Unlock()

	slog.Warn("messagereport: session message limit reached, disabling reporter for session",
		"count", len(batch),
		"workspaceId", wsID,
		"sessionId", sessionID,
		"responseBody", responseBody,
	)
	r.deleteBatch(batch)
}

// MarkTerminal disables future sends for this reporter after an owner outside
// the reporter observes a terminal control-plane callback response.
func (r *Reporter) MarkTerminal(reason string) {
	if r == nil {
		return
	}
	if !r.setTerminalPersistenceFailure(reason) {
		return
	}
	r.flushMu.Lock()
	defer r.flushMu.Unlock()
	r.clearAndLogTerminalOutbox(reason, 0, "")
}

func (r *Reporter) markTerminalPersistenceFailure(batch []outboxRow, statusCode int, responseBody string) {
	reason := fmt.Sprintf("message persistence returned terminal status %d", statusCode)
	if r.setTerminalPersistenceFailure(reason) {
		r.clearAndLogTerminalOutbox(reason, statusCode, responseBody)
	} else if len(batch) > 0 {
		r.deleteBatch(batch)
	}
}

func (r *Reporter) setTerminalPersistenceFailure(reason string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.terminalPersistenceFailure {
		return false
	}
	r.terminalPersistenceFailure = true
	r.terminalPersistenceReason = reason
	select {
	case r.terminalWakeC <- struct{}{}:
	default:
	}
	return true
}

func (r *Reporter) terminalPersistenceStopped() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.terminalPersistenceFailure
}

func (r *Reporter) clearAndLogTerminalOutbox(reason string, statusCode int, responseBody string) {
	r.mu.Lock()
	wsID := r.workspaceID
	sessionID := r.sessionID
	r.mu.Unlock()

	var cleared int64
	if sessionID != "" {
		var err error
		cleared, err = r.clearOutboxForSession(sessionID)
		if err != nil {
			slog.Warn("messagereport: failed to clear outbox after terminal persistence response",
				"workspaceId", wsID,
				"sessionId", sessionID,
				"error", err)
		}
	}

	slog.Warn("messagereport: terminal persistence response, disabling reporter",
		"workspaceId", wsID,
		"sessionId", sessionID,
		"statusCode", statusCode,
		"responseBody", responseBody,
		"cleared", cleared,
		"reason", reason,
	)
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
