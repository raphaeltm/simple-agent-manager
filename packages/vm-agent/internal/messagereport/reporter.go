package messagereport

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"math/rand"
	"net/http"
	"strings"
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

	// flushMu serializes flush() calls with outbox mutations in SetSessionID.
	// Lock ordering: flushMu must always be acquired BEFORE mu when both
	// are held. Acquiring mu first would risk deadlock with flush().
	flushMu sync.Mutex

	stopC chan struct{}
	doneC chan struct{}

	shutdownOnce sync.Once
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

	if err := migrateOutbox(db); err != nil {
		return nil, fmt.Errorf("messagereport: migrate outbox: %w", err)
	}

	r := &Reporter{
		cfg:         cfg,
		db:          db,
		client:      config.NewControlPlaneClient(cfg.HTTPTimeout),
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
	r.shutdownOnce.Do(func() {
		close(r.stopC)
	})
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
	for rows.Next() {
		var row outboxRow
		if err := rows.Scan(&row.id, &row.messageID, &row.sessionID, &row.role, &row.content, &row.toolMetadata, &row.createdAt); err != nil {
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

type apiMessage struct {
	MessageID    string `json:"messageId"`
	SessionID    string `json:"sessionId"`
	Role         string `json:"role"`
	Content      string `json:"content"`
	ToolMetadata string `json:"toolMetadata,omitempty"`
	Timestamp    string `json:"timestamp"`
	Sequence     int64  `json:"sequence"`
}

func rowToAPIMessage(row outboxRow) apiMessage {
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
	return m
}

func buildBatchPayload(messages []apiMessage) ([]byte, error) {
	return json.Marshal(map[string]interface{}{"messages": messages})
}

func buildBatchBody(batch []outboxRow) ([]byte, error) {
	messages := make([]apiMessage, 0, len(batch))
	for _, row := range batch {
		messages = append(messages, rowToAPIMessage(row))
	}
	return buildBatchPayload(messages)
}

func marshaledBatchSize(batch []outboxRow) (int, error) {
	body, err := buildBatchBody(batch)
	if err != nil {
		return 0, err
	}
	return len(body), nil
}

// sendBatch POSTs the batch to the control plane with exponential backoff.
func (r *Reporter) sendBatch(batch []outboxRow) error {
	token, wsID, messageLimitReached := r.senderState()
	if messageLimitReached {
		r.deleteBatch(batch)
		return nil
	}
	if token == "" {
		// No token yet — leave messages in outbox for later.
		return fmt.Errorf("no auth token")
	}
	if wsID == "" {
		// No workspace yet — leave messages in outbox for later.
		return fmt.Errorf("no workspace ID")
	}

	body, err := buildBatchBody(batch)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	url := strings.TrimRight(r.cfg.Endpoint, "/") +
		"/api/workspaces/" + wsID + "/messages"
	return r.sendBatchWithRetry(batch, url, token, wsID, body)
}

func (r *Reporter) senderState() (token, workspaceID string, messageLimitReached bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.authToken, r.workspaceID, r.messageLimitReached
}

func (r *Reporter) sendBatchWithRetry(batch []outboxRow, url, token, wsID string, body []byte) error {
	// Retry with exponential backoff + jitter.
	delay := r.cfg.RetryInitial
	start := time.Now()

	for {
		statusCode, responseBody, err := r.doPost(url, token, body)
		handled, handleErr := r.handleBatchResponse(batch, url, token, wsID, statusCode, responseBody, err)
		if handled {
			return handleErr
		}

		if time.Since(start) > r.cfg.RetryMaxElapsed {
			return fmt.Errorf("retries exhausted after %v (last status=%d, err=%v)",
				time.Since(start), statusCode, err)
		}

		if err := r.waitForRetry(delay, statusCode, err); err != nil {
			return err
		}
		delay = r.nextRetryDelay(delay)
	}
}

func (r *Reporter) handleBatchResponse(batch []outboxRow, url, token, wsID string, statusCode int, responseBody string, postErr error) (bool, error) {
	if postErr == nil && statusCode >= 200 && statusCode < 300 {
		return true, nil
	}
	if statusCode == http.StatusBadRequest && isPayloadSizeError(responseBody) {
		return true, r.sendSizeFallback(url, token, batch)
	}
	if statusCode == http.StatusConflict && isSessionMessageLimitError(responseBody) {
		r.markMessageLimitReached(batch, responseBody)
		return true, nil
	}
	if isPermanentBatchError(statusCode) {
		slog.Warn("messagereport: permanent error, discarding batch",
			"statusCode", statusCode,
			"count", len(batch),
			"workspaceId", wsID,
			"responseBody", responseBody,
		)
		r.deleteBatch(batch)
		return true, nil
	}
	return false, nil
}

func isPermanentBatchError(statusCode int) bool {
	return statusCode == http.StatusBadRequest ||
		statusCode == http.StatusUnauthorized ||
		statusCode == http.StatusForbidden
}

func (r *Reporter) waitForRetry(delay time.Duration, statusCode int, err error) error {
	select {
	case <-r.stopC:
		return fmt.Errorf("shutdown during retry")
	default:
	}

	jitter := time.Duration(rand.Int63n(int64(delay) / 2))
	sleepDur := delay + jitter
	slog.Info("messagereport: retrying after backoff",
		"delay", sleepDur, "statusCode", statusCode, "err", err)

	timer := time.NewTimer(sleepDur)
	select {
	case <-timer.C:
		return nil
	case <-r.stopC:
		timer.Stop()
		return fmt.Errorf("shutdown during backoff")
	}
}

func (r *Reporter) nextRetryDelay(delay time.Duration) time.Duration {
	return time.Duration(math.Min(float64(delay*2), float64(r.cfg.RetryMax)))
}

func isPayloadSizeError(responseBody string) bool {
	body := strings.ToLower(responseBody)
	return strings.Contains(body, "payload exceeds") ||
		strings.Contains(body, "individual message content exceeds") ||
		strings.Contains(body, "byte limit")
}

func isSessionMessageLimitError(responseBody string) bool {
	return strings.Contains(responseBody, "SESSION_MESSAGE_LIMIT_EXCEEDED")
}

type sessionMessageLimitError struct {
	responseBody string
}

func (e sessionMessageLimitError) Error() string {
	return "session message limit reached"
}

type fallbackPermanentError struct {
	statusCode   int
	responseBody string
}

func (e fallbackPermanentError) Error() string {
	return fmt.Sprintf("fallback permanent error status=%d body=%s", e.statusCode, e.responseBody)
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

func (r *Reporter) sendSizeFallback(url, token string, batch []outboxRow) error {
	ctx, cancel := r.contextUntilStop()
	defer cancel()

	for _, row := range batch {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("shutdown during fallback: %w", err)
		}

		if err := r.sendSingleWithSizeFallback(ctx, url, token, row); err != nil {
			if limitErr, ok := err.(sessionMessageLimitError); ok {
				r.markMessageLimitReached(batch, limitErr.responseBody)
				return nil
			}
			if permanentErr, ok := err.(fallbackPermanentError); ok {
				slog.Warn("messagereport: fallback permanent error, discarding batch",
					"statusCode", permanentErr.statusCode,
					"count", len(batch),
					"messageId", row.messageID,
					"responseBody", permanentErr.responseBody,
				)
				return nil
			}
			return err
		}
	}
	return nil
}

func (r *Reporter) sendSingleWithSizeFallback(ctx context.Context, url, token string, row outboxRow) error {
	candidates := r.sizeFallbackCandidates(row)
	for i, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("shutdown during fallback: %w", err)
		}

		statusCode, responseBody, postErr, err := r.postFallbackCandidate(ctx, url, token, candidate)
		if err != nil {
			return err
		}
		tryNext, resultErr := fallbackCandidateResult(row, i, statusCode, responseBody, postErr)
		if tryNext {
			continue
		}
		return resultErr
	}
	return fmt.Errorf("fallback candidates exhausted for message %s", row.messageID)
}

func (r *Reporter) postFallbackCandidate(ctx context.Context, url, token string, candidate apiMessage) (int, string, error, error) {
	body, err := buildBatchPayload([]apiMessage{candidate})
	if err != nil {
		return 0, "", nil, fmt.Errorf("marshal fallback payload: %w", err)
	}
	statusCode, responseBody, postErr := r.doPostWithContext(ctx, url, token, body)
	return statusCode, responseBody, postErr, nil
}

func fallbackCandidateResult(row outboxRow, candidateIndex int, statusCode int, responseBody string, postErr error) (tryNext bool, err error) {
	if postErr == nil && statusCode >= 200 && statusCode < 300 {
		logFallbackSuccess(row, candidateIndex)
		return false, nil
	}
	if statusCode == http.StatusBadRequest && isPayloadSizeError(responseBody) {
		return true, nil
	}
	if statusCode == http.StatusConflict && isSessionMessageLimitError(responseBody) {
		return false, sessionMessageLimitError{responseBody: responseBody}
	}
	if isPermanentBatchError(statusCode) {
		return false, fallbackPermanentError{statusCode: statusCode, responseBody: responseBody}
	}
	return false, fmt.Errorf("fallback transient error status=%d err=%v body=%s", statusCode, postErr, responseBody)
}

func logFallbackSuccess(row outboxRow, candidateIndex int) {
	if candidateIndex == 0 {
		return
	}
	slog.Warn("messagereport: delivered oversized message fallback",
		"messageId", row.messageID,
		"role", row.role,
		"fallbackIndex", candidateIndex,
	)
}

func (r *Reporter) contextUntilStop() (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		select {
		case <-r.stopC:
			cancel()
		case <-ctx.Done():
		}
	}()
	return ctx, cancel
}

func (r *Reporter) sizeFallbackCandidates(row outboxRow) []apiMessage {
	trimmed := rowToAPIMessage(row)
	trimmed.Content = truncateContentToLimit(trimmed.Content, r.cfg.MaxMessageContentBytes)

	withoutMetadata := trimmed
	withoutMetadata.ToolMetadata = ""

	omitted := withoutMetadata
	omitted.Content = omittedMessageMarker

	return []apiMessage{trimmed, withoutMetadata, omitted}
}

func truncateContentToLimit(content string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if maxBytes <= len(truncationMarker) {
		return truncationMarker[:maxBytes]
	}
	if len(content) <= maxBytes {
		return content
	}
	keep := maxBytes - len(truncationMarker)
	return content[:keep] + truncationMarker
}

func (r *Reporter) doPost(url, token string, body []byte) (int, string, error) {
	return r.doPostWithContext(context.Background(), url, token, body)
}

func (r *Reporter) doPostWithContext(ctx context.Context, url, token string, body []byte) (int, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := r.client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	responseBody := readBoundedHTTPBody(resp.Body)
	return resp.StatusCode, responseBody, nil
}

const maxLoggedResponseBodyBytes int64 = 2048

func readBoundedHTTPBody(body httpBodyReader) string {
	if body == nil {
		return ""
	}
	data, err := io.ReadAll(io.LimitReader(body, maxLoggedResponseBodyBytes))
	if err != nil {
		return fmt.Sprintf("<read error: %v>", err)
	}
	return strings.TrimSpace(string(data))
}

type httpBodyReader interface {
	Read([]byte) (int, error)
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
