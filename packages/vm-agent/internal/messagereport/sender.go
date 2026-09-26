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
	if postErr == nil && statusCode == http.StatusNoContent {
		r.discardDeclinedBatch(batch, wsID)
		return true, nil
	}
	if postErr == nil && statusCode >= 200 && statusCode < 300 {
		return true, nil
	}
	if statusCode == http.StatusBadRequest && isPayloadSizeError(responseBody) {
		return true, r.sendSizeFallback(url, token, wsID, batch)
	}
	if statusCode == http.StatusConflict && isSessionMessageLimitError(responseBody) {
		r.markMessageLimitReached(batch, responseBody)
		return true, nil
	}
	if isTerminalBatchResponse(statusCode) {
		r.markTerminalPersistenceFailure(batch, statusCode, responseBody)
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

// discardDeclinedBatch drops a batch the control plane answered with 204: the
// workspace or its chat session no longer accepts messages, so the rows can
// never be persisted. That is not a delivery, and not a reason to stop the
// reporter either — a reused workspace may already be linked to a new session.
func (r *Reporter) discardDeclinedBatch(batch []outboxRow, wsID string) {
	slog.Warn("messagereport: control plane declined batch for an inactive workspace or session, discarding",
		"count", len(batch),
		"workspaceId", wsID,
		"sessionId", batch[0].sessionID,
		"firstMessageId", batch[0].messageID,
	)
	r.deleteBatch(batch)
}

func isTerminalBatchResponse(statusCode int) bool {
	return statusCode == http.StatusUnauthorized ||
		statusCode == http.StatusForbidden ||
		statusCode == http.StatusNotFound ||
		statusCode == http.StatusGone
}

func isPermanentBatchError(statusCode int) bool {
	return statusCode == http.StatusBadRequest
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

// declinedError reports a 204 from the control plane during the size fallback.
type declinedError struct{}

func (declinedError) Error() string {
	return "control plane declined messages for an inactive workspace or session"
}

type terminalPersistenceError struct {
	statusCode   int
	responseBody string
}

func (e terminalPersistenceError) Error() string {
	return fmt.Sprintf("terminal persistence error status=%d body=%s", e.statusCode, e.responseBody)
}

func (r *Reporter) sendSizeFallback(url, token, wsID string, batch []outboxRow) error {
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
			if terminalErr, ok := err.(terminalPersistenceError); ok {
				r.markTerminalPersistenceFailure(batch, terminalErr.statusCode, terminalErr.responseBody)
				return nil
			}
			if _, ok := err.(declinedError); ok {
				r.discardDeclinedBatch(batch, wsID)
				return nil
			}
			return err
		}
	}
	return nil
}

// sendSingleWithSizeFallback sends one row on its own and, if the control plane
// still rejects it as too large, sends its omitted form instead.
func (r *Reporter) sendSingleWithSizeFallback(ctx context.Context, url, token string, row outboxRow) error {
	candidates := []apiMessage{
		rowToAPIMessage(row),
		omittedForTransport(row.message()).toAPIMessage(row.id),
	}
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
	if postErr == nil && statusCode == http.StatusNoContent {
		return false, declinedError{}
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
	if isPermanentBatchError(statusCode) {
		return false, fallbackPermanentError{statusCode: statusCode, responseBody: responseBody}
	}
	return false, fmt.Errorf("fallback transient error status=%d err=%v body=%s", statusCode, postErr, responseBody)
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
