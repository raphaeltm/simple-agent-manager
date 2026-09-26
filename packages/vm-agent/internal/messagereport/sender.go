package messagereport

import (
	"bytes"
	"context"
	cryptorand "crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"math/big"
	"net/http"
	"strings"
	"time"
)

type apiMessage struct {
	MessageID    string `json:"messageId"`
	SessionID    string `json:"sessionId"`
	Role         string `json:"role"`
	Content      string `json:"content"`
	ToolMetadata string `json:"toolMetadata,omitempty"`
	Timestamp    string `json:"timestamp"`
	Sequence     int64  `json:"sequence"`
	Origin       string `json:"origin,omitempty"`
}

func (m Message) toAPIMessage(sequence int64) apiMessage {
	return apiMessage{
		MessageID:    m.MessageID,
		SessionID:    m.SessionID,
		Role:         m.Role,
		Content:      m.Content,
		ToolMetadata: m.ToolMetadata,
		Timestamp:    m.Timestamp,
		Sequence:     sequence,
		Origin:       m.Origin,
	}
}

func rowToAPIMessage(row outboxRow) apiMessage {
	return row.message().toAPIMessage(row.id) // outbox AUTOINCREMENT id is monotonic
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
	token, wsID, messageLimitReached, terminalPersistenceFailure := r.senderState()
	if messageLimitReached {
		r.deleteBatch(batch)
		return nil
	}
	if terminalPersistenceFailure {
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

func (r *Reporter) senderState() (token, workspaceID string, messageLimitReached bool, terminalPersistenceFailure bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.authToken, r.workspaceID, r.messageLimitReached, r.terminalPersistenceFailure
}

func (r *Reporter) sendBatchWithRetry(batch []outboxRow, url, token, wsID string, body []byte) error {
	// Retry with exponential backoff + jitter.
	delay := r.cfg.RetryInitial
	start := time.Now()

	for {
		if r.terminalPersistenceStopped() {
			return nil
		}
		statusCode, responseBody, err := r.doPost(url, token, body)
		handled, handleErr := r.handleBatchResponse(batch, url, token, wsID, statusCode, responseBody, err)
		if handled {
			return handleErr
		}

		if r.terminalPersistenceStopped() {
			return nil
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
	if closed, ok := sessionClosure(statusCode, responseBody, postErr); ok {
		r.discardUndeliverableSession(batch, wsID, closed.reason)
		return true, nil
	}
	if postErr == nil && statusCode >= 200 && statusCode < 300 {
		return true, nil
	}
	if statusCode == http.StatusConflict && isSessionMessageLimitError(responseBody) {
		r.markMessageLimitReached(batch, responseBody)
		return true, nil
	}
	// A rejected batch may hold one oversized or invalid row. Sending each row
	// on its own loses only that row, never its batch-mates.
	if statusCode == http.StatusBadRequest && (len(batch) > 1 || isPayloadSizeError(responseBody)) {
		return true, r.sendRowsIndividually(url, token, wsID, batch)
	}
	if isTerminalBatchResponse(statusCode) {
		r.markTerminalPersistenceFailure(batch, statusCode, responseBody)
		return true, nil
	}
	if statusCode == http.StatusBadRequest {
		r.discardRejectedRow(batch[0], rowRejectedError{statusCode: statusCode, responseBody: responseBody})
		return true, nil
	}
	return false, nil
}

// sessionClosure recognizes a response saying the batch's chat session will
// never accept messages from this workspace: 204 when the workspace or session
// stopped accepting writes, or a session mismatch when the workspace is now
// linked to another session.
func sessionClosure(statusCode int, responseBody string, postErr error) (sessionClosedError, bool) {
	switch {
	case postErr == nil && statusCode == http.StatusNoContent:
		return sessionClosedError{reason: "workspace or session no longer accepts messages"}, true
	case statusCode == http.StatusBadRequest && isSessionMismatchError(responseBody):
		return sessionClosedError{reason: "workspace is linked to another session"}, true
	}
	return sessionClosedError{}, false
}

// discardUndeliverableSession drops every queued row of the batch's session
// once the control plane has said it will never accept them from this
// workspace, instead of sending each only to be refused again. That is not a
// delivery, and not a reason to stop the reporter either — a reused workspace
// may already be linked to a new session.
func (r *Reporter) discardUndeliverableSession(batch []outboxRow, wsID, reason string) {
	sessionID := batch[0].sessionID
	discarded, err := r.clearOutboxForSession(sessionID)
	if err != nil {
		slog.Error("messagereport: failed to discard the queued rows of an undeliverable session",
			"workspaceId", wsID, "sessionId", sessionID, "reason", reason, "error", err)
		return
	}
	slog.Warn("messagereport: control plane will not accept this session's messages, discarded its queued rows",
		"workspaceId", wsID,
		"sessionId", sessionID,
		"reason", reason,
		"firstMessageId", batch[0].messageID,
		"discarded", discarded,
	)
}

// discardRejectedRow drops one row the control plane refuses in every form.
func (r *Reporter) discardRejectedRow(row outboxRow, rejection rowRejectedError) {
	slog.Warn("messagereport: control plane rejected a message, discarding it",
		"messageId", row.messageID,
		"sessionId", row.sessionID,
		"role", row.role,
		"statusCode", rejection.statusCode,
		"responseBody", rejection.responseBody,
	)
	r.deleteBatch([]outboxRow{row})
}

func isTerminalBatchResponse(statusCode int) bool {
	return statusCode == http.StatusUnauthorized ||
		statusCode == http.StatusForbidden ||
		statusCode == http.StatusNotFound ||
		statusCode == http.StatusGone
}

func (r *Reporter) waitForRetry(delay time.Duration, statusCode int, err error) error {
	select {
	case <-r.stopC:
		return fmt.Errorf("shutdown during retry")
	default:
	}

	jitter := retryJitter(delay)
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
	case <-r.terminalWakeC:
		timer.Stop()
		return nil
	}
}

func retryJitter(delay time.Duration) time.Duration {
	maxJitter := int64(delay) / 2
	if maxJitter <= 0 {
		return 0
	}

	n, err := cryptorand.Int(cryptorand.Reader, big.NewInt(maxJitter))
	if err != nil {
		slog.Warn("messagereport: retry jitter unavailable", "err", err)
		return 0
	}

	return time.Duration(n.Int64())
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

func isSessionMismatchError(responseBody string) bool {
	return strings.Contains(responseBody, "Session mismatch")
}

type sessionMessageLimitError struct {
	responseBody string
}

func (e sessionMessageLimitError) Error() string {
	return "session message limit reached"
}

// rowRejectedError is the control plane refusing one row in every form it was
// sent; only that row is lost.
type rowRejectedError struct {
	statusCode   int
	responseBody string
}

func (e rowRejectedError) Error() string {
	return fmt.Sprintf("row rejected status=%d body=%s", e.statusCode, e.responseBody)
}

// sessionClosedError is the control plane refusing every message of the row's
// session; see sessionClosure.
type sessionClosedError struct {
	reason string
}

func (e sessionClosedError) Error() string {
	return "session closed: " + e.reason
}

type terminalPersistenceError struct {
	statusCode   int
	responseBody string
}

func (e terminalPersistenceError) Error() string {
	return fmt.Sprintf("terminal persistence error status=%d body=%s", e.statusCode, e.responseBody)
}

// sendRowsIndividually settles a rejected batch row by row. A row the control
// plane refuses is dropped on its own; a verdict about the whole session or
// workspace settles every row at once.
func (r *Reporter) sendRowsIndividually(url, token, wsID string, batch []outboxRow) error {
	ctx, cancel := r.contextUntilStop()
	defer cancel()

	for _, row := range batch {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("shutdown while sending rows individually: %w", err)
		}

		err := r.sendRow(ctx, url, token, row)
		switch verdict := err.(type) {
		case nil:
		case rowRejectedError:
			r.discardRejectedRow(row, verdict)
		case sessionClosedError:
			r.discardUndeliverableSession(batch, wsID, verdict.reason)
			return nil
		case sessionMessageLimitError:
			r.markMessageLimitReached(batch, verdict.responseBody)
			return nil
		case terminalPersistenceError:
			r.markTerminalPersistenceFailure(batch, verdict.statusCode, verdict.responseBody)
			return nil
		default:
			return err
		}
	}
	return nil
}

// sendRow sends one row on its own and, if the control plane still rejects it
// as too large, sends its omitted form instead.
func (r *Reporter) sendRow(ctx context.Context, url, token string, row outboxRow) error {
	candidates := []apiMessage{
		rowToAPIMessage(row),
		omittedForTransport(row.message()).toAPIMessage(row.id),
	}
	var tooLarge rowRejectedError
	for i, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("shutdown while sending a row: %w", err)
		}

		statusCode, responseBody, postErr, err := r.postFallbackCandidate(ctx, url, token, candidate)
		if err != nil {
			return err
		}
		tryNext, resultErr := fallbackCandidateResult(row, i, statusCode, responseBody, postErr)
		if !tryNext {
			return resultErr
		}
		tooLarge = rowRejectedError{statusCode: statusCode, responseBody: responseBody}
	}
	// Even the omitted form is too large for the control plane: nothing smaller exists.
	return tooLarge
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
	if closed, ok := sessionClosure(statusCode, responseBody, postErr); ok {
		return false, closed
	}
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
	if isTerminalBatchResponse(statusCode) {
		return false, terminalPersistenceError{statusCode: statusCode, responseBody: responseBody}
	}
	if statusCode == http.StatusBadRequest {
		return false, rowRejectedError{statusCode: statusCode, responseBody: responseBody}
	}
	return false, fmt.Errorf("transient error sending a row status=%d err=%v body=%s", statusCode, postErr, responseBody)
}

func logFallbackSuccess(row outboxRow, candidateIndex int) {
	if candidateIndex == 0 {
		return
	}
	slog.Warn("messagereport: control plane limits are below the reporter's; delivered omitted marker",
		"messageId", row.messageID,
		"role", row.role,
	)
}

func (r *Reporter) contextUntilStop() (context.Context, context.CancelFunc) {
	if r == nil || r.stopCtx == nil {
		return context.WithCancel(context.Background())
	}
	return context.WithCancel(r.stopCtx)
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
	responseBody := r.readBoundedHTTPBody(resp.Body)
	return resp.StatusCode, responseBody, nil
}

func (r *Reporter) readBoundedHTTPBody(body httpBodyReader) string {
	if body == nil {
		return ""
	}
	limit := DefaultResponseMaxBytes
	if r != nil && r.cfg.ResponseMaxBytes > 0 {
		limit = r.cfg.ResponseMaxBytes
	}
	data, err := io.ReadAll(io.LimitReader(body, int64(limit)))
	if err != nil {
		return fmt.Sprintf("<read error: %v>", err)
	}
	return strings.TrimSpace(string(data))
}

type httpBodyReader interface {
	Read([]byte) (int, error)
}
