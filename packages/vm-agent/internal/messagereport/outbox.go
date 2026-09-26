package messagereport

import (
	"database/sql"
	"fmt"
	"log/slog"
	"time"
)

// The SQLite outbox: rows are appended by Enqueue and settled by flush, oldest
// first. A row leaves the outbox once it is delivered or the control plane has
// refused it for good.

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

func (row outboxRow) message() Message {
	return Message{
		MessageID:    row.messageID,
		SessionID:    row.sessionID,
		Role:         row.role,
		Content:      row.content,
		ToolMetadata: row.toolMetadata.String,
		Timestamp:    row.createdAt,
		Origin:       row.origin.String,
	}
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
		// The control plane accepts one session per request, so a batch is a
		// run of consecutive rows from the oldest row's session. Rows left over
		// from an earlier session go on their own and cannot sink a batch of
		// the current session's messages.
		if len(batch) > 0 && row.sessionID != batch[0].sessionID {
			break
		}
		candidate := append(append([]outboxRow(nil), batch...), row)
		payloadBytes, err := marshaledBatchSize(candidate)
		if err != nil {
			return nil, err
		}
		// Respect the marshaled payload limit. Enqueue sized every row to fit
		// on its own, so the first row is always taken.
		if len(batch) > 0 && payloadBytes > r.cfg.BatchMaxBytes {
			break
		}
		batch = append(batch, row)
	}
	return batch, rows.Err()
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
