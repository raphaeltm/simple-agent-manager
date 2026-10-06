package errorreport

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

const outboxDDL = `
CREATE TABLE IF NOT EXISTS error_report_outbox (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	incident_id TEXT NOT NULL UNIQUE,
	level TEXT NOT NULL,
	message TEXT NOT NULL,
	source TEXT NOT NULL,
	stack TEXT NOT NULL DEFAULT '',
	workspace_id TEXT NOT NULL DEFAULT '',
	timestamp TEXT NOT NULL,
	context_json TEXT NOT NULL DEFAULT '{}',
	artifact_required INTEGER NOT NULL DEFAULT 0,
	artifact_state TEXT NOT NULL DEFAULT 'none',
	spool_path TEXT NOT NULL DEFAULT '',
	manifest_json TEXT NOT NULL DEFAULT '',
	preview_json TEXT NOT NULL DEFAULT '',
	checksum TEXT NOT NULL DEFAULT '',
	size_bytes INTEGER NOT NULL DEFAULT 0,
	report_ack INTEGER NOT NULL DEFAULT 0,
	artifact_ack INTEGER NOT NULL DEFAULT 0,
	attempts INTEGER NOT NULL DEFAULT 0,
	last_error TEXT NOT NULL DEFAULT '',
	next_attempt_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_error_outbox_delivery
	ON error_report_outbox(report_ack, artifact_ack, next_attempt_at, id);
CREATE INDEX IF NOT EXISTS idx_error_outbox_snapshot
	ON error_report_outbox(artifact_state, id);
CREATE INDEX IF NOT EXISTS idx_error_outbox_expiry
	ON error_report_outbox(expires_at);
`

type outboxRow struct {
	id               int64
	entry            ErrorEntry
	contextJSON      string
	artifactRequired bool
	artifactState    string
	spoolPath        string
	manifestJSON     string
	previewJSON      string
	checksum         string
	sizeBytes        int64
	attempts         int
}

func openOutbox(path string, busyTimeout time.Duration) (*sql.DB, error) {
	dsn := ":memory:"
	if path != "" {
		absPath, err := filepath.Abs(path)
		if err != nil {
			return nil, fmt.Errorf("resolve outbox path: %w", err)
		}
		if err := prepareOutboxParent(absPath); err != nil {
			return nil, fmt.Errorf("secure outbox directory: %w", err)
		}
		if info, statErr := os.Lstat(absPath); statErr == nil && info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("outbox database path must not be a symlink")
		} else if statErr != nil && !os.IsNotExist(statErr) {
			return nil, fmt.Errorf("inspect outbox path: %w", statErr)
		}
		path = absPath
		dsn = fmt.Sprintf("file:%s?cache=shared&mode=rwc&_journal_mode=WAL", path)
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open outbox: %w", err)
	}
	db.SetMaxOpenConns(1)
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		fmt.Sprintf("PRAGMA busy_timeout=%d", busyTimeout.Milliseconds()),
		"PRAGMA synchronous=NORMAL",
	} {
		if _, err := db.Exec(pragma); err != nil {
			db.Close()
			return nil, fmt.Errorf("configure outbox %s: %w", pragma, err)
		}
	}
	if _, err := db.Exec(outboxDDL); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate outbox: %w", err)
	}
	if path != "" {
		if err := restrictOutboxFiles(path); err != nil {
			db.Close()
			return nil, fmt.Errorf("restrict outbox permissions: %w", err)
		}
	}
	return db, nil
}

func prepareOutboxParent(path string) error {
	parent := filepath.Dir(path)
	for current := parent; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err == nil {
			if info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("outbox path contains a symlink: %s", current)
			}
			if current == parent && !info.IsDir() {
				return fmt.Errorf("outbox parent is not a directory")
			}
		} else if !os.IsNotExist(err) {
			return err
		}
		next := filepath.Dir(current)
		if next == current {
			break
		}
	}
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(parent)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("outbox parent must be a real directory")
	}
	return nil
}

func restrictOutboxFiles(path string) error {
	for _, candidate := range []string{path, path + "-wal", path + "-shm"} {
		info, err := os.Lstat(candidate)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return fmt.Errorf("outbox file is not a regular file: %s", candidate)
		}
		if err := os.Chmod(candidate, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func (r *Reporter) insertEntry(entry ErrorEntry, contextJSON string) error {
	var count int
	if err := r.db.QueryRow(
		"SELECT COUNT(*) FROM (SELECT 1 FROM error_report_outbox LIMIT ?)",
		r.config.MaxQueueSize+1,
	).Scan(&count); err != nil {
		return fmt.Errorf("count outbox: %w", err)
	}
	if count >= r.config.MaxQueueSize {
		return fmt.Errorf("outbox full (%d/%d)", count, r.config.MaxQueueSize)
	}
	artifactRequired := entry.Level == "error"
	artifactState := "none"
	artifactAck := 1
	if artifactRequired {
		artifactState = "pending"
		artifactAck = 0
	}
	createdAt := time.Now().UTC()
	_, err := r.db.Exec(`
		INSERT OR IGNORE INTO error_report_outbox (
			incident_id, level, message, source, stack, workspace_id, timestamp,
			context_json, artifact_required, artifact_state, artifact_ack,
			next_attempt_at, created_at, expires_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		entry.IncidentID, entry.Level, entry.Message, entry.Source, entry.Stack,
		entry.WorkspaceID, entry.Timestamp, contextJSON, boolInt(artifactRequired),
		artifactState, artifactAck, createdAt.Format(time.RFC3339Nano),
		createdAt.Format(time.RFC3339Nano), createdAt.Add(r.config.Retention).Format(time.RFC3339Nano),
	)
	if err != nil {
		return fmt.Errorf("insert outbox: %w", err)
	}
	return nil
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func scanOutboxRow(scanner interface{ Scan(...any) error }) (outboxRow, error) {
	var row outboxRow
	var artifactRequired int
	err := scanner.Scan(
		&row.id, &row.entry.IncidentID, &row.entry.Level, &row.entry.Message,
		&row.entry.Source, &row.entry.Stack, &row.entry.WorkspaceID, &row.entry.Timestamp,
		&row.contextJSON, &artifactRequired, &row.artifactState, &row.spoolPath,
		&row.manifestJSON, &row.previewJSON, &row.checksum, &row.sizeBytes, &row.attempts,
	)
	row.artifactRequired = artifactRequired == 1
	return row, err
}

const (
	outboxSelect = `SELECT id, incident_id, level, message, source, stack,
		workspace_id, timestamp, context_json, artifact_required, artifact_state,
		spool_path, manifest_json, preview_json, checksum, size_bytes, attempts
		FROM error_report_outbox`
	reportCandidatesSelect = outboxSelect + `
		WHERE report_ack = 0 AND attempts < ? AND next_attempt_at <= ?
		ORDER BY id ASC LIMIT ?`
	deliverableArtifactsSelect = outboxSelect + `
		WHERE report_ack = 1 AND artifact_required = 1 AND artifact_ack = 0
			AND artifact_state IN ('ready', 'failed') AND attempts < ? AND next_attempt_at <= ?
		ORDER BY id ASC LIMIT ?`
	pendingSnapshotsSelect = outboxSelect + `
		WHERE artifact_required = 1 AND artifact_state = 'pending'
		ORDER BY id ASC LIMIT ?`
)

func (r *Reporter) readReportCandidates() ([]outboxRow, error) {
	rows, err := r.db.Query(reportCandidatesSelect,
		r.config.MaxAttempts, time.Now().UTC().Format(time.RFC3339Nano), r.config.MaxBatchSize,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (r *Reporter) readDeliverableArtifacts() ([]outboxRow, error) {
	rows, err := r.db.Query(deliverableArtifactsSelect,
		r.config.MaxAttempts, time.Now().UTC().Format(time.RFC3339Nano), r.config.MaxBatchSize,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (r *Reporter) readPendingSnapshots() ([]outboxRow, error) {
	rows, err := r.db.Query(pendingSnapshotsSelect, r.config.MaxQueueSize)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (r *Reporter) nextFlushDelay() time.Duration {
	if r == nil || r.db == nil {
		return DefaultFlushInterval
	}
	if r.token() == "" {
		return r.config.FlushInterval
	}
	var deadline sql.NullString
	err := r.db.QueryRow(
		`SELECT MIN(next_attempt_at) FROM error_report_outbox
		 WHERE attempts < ? AND
		   (report_ack = 0 OR
		    (report_ack = 1 AND artifact_required = 1 AND artifact_ack = 0
		     AND artifact_state IN ('ready', 'failed')))`,
		r.config.MaxAttempts,
	).Scan(&deadline)
	if err != nil || !deadline.Valid {
		return r.config.FlushInterval
	}
	next, err := time.Parse(time.RFC3339Nano, deadline.String)
	if err != nil {
		return r.config.FlushInterval
	}
	delay := time.Until(next)
	if delay <= 0 {
		return r.config.RetryInitial
	}
	if delay > r.config.FlushInterval {
		return r.config.FlushInterval
	}
	return delay
}

func scanRows(rows *sql.Rows) ([]outboxRow, error) {
	result := make([]outboxRow, 0)
	for rows.Next() {
		row, err := scanOutboxRow(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func (r *Reporter) markReportAcknowledged(rows []outboxRow) error {
	return r.updateRows(rows, `UPDATE error_report_outbox SET report_ack = 1,
		attempts = 0, last_error = '', next_attempt_at = ? WHERE id = ?`)
}

func (r *Reporter) markArtifactAcknowledged(row outboxRow) error {
	_, err := r.db.Exec(`UPDATE error_report_outbox SET artifact_ack = 1,
		attempts = 0, last_error = '', next_attempt_at = ? WHERE id = ?`,
		time.Now().UTC().Format(time.RFC3339Nano), row.id)
	return err
}

func (r *Reporter) updateRows(rows []outboxRow, query string) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, row := range rows {
		if _, err := tx.Exec(query, now, row.id); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

func (r *Reporter) markAttempt(rows []outboxRow, reportErr error, permanent bool) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	for _, row := range rows {
		attempts := row.attempts + 1
		delay := retryDelay(r.config.RetryInitial, r.config.RetryMax, attempts)
		reportAck := 0
		artifactAck := 0
		if permanent || attempts >= r.config.MaxAttempts {
			reportAck = 1
			artifactAck = 1
		}
		_, err := tx.Exec(`UPDATE error_report_outbox SET attempts = ?, last_error = ?,
			next_attempt_at = ?, report_ack = MAX(report_ack, ?), artifact_ack = MAX(artifact_ack, ?),
			artifact_state = CASE WHEN ? = 1 AND artifact_required = 1 THEN 'failed' ELSE artifact_state END
			WHERE id = ?`, attempts, boundedError(reportErr, r.config.StoredErrorBytes),
			time.Now().UTC().Add(delay).Format(time.RFC3339Nano), reportAck, artifactAck,
			boolInt(permanent || attempts >= r.config.MaxAttempts), row.id)
		if err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

func retryDelay(initial, maximum time.Duration, attempts int) time.Duration {
	delay := initial
	for i := 1; i < attempts && delay < maximum; i++ {
		delay *= 2
	}
	if delay > maximum {
		return maximum
	}
	return delay
}

func boundedError(err error, maxBytes int) string {
	if err == nil {
		return ""
	}
	message := err.Error()
	if len(message) > maxBytes {
		message = message[:maxBytes]
		for !utf8.ValidString(message) {
			message = message[:len(message)-1]
		}
	}
	return message
}

func (r *Reporter) markSnapshotReady(incidentID, path, manifest, preview, checksum string, size int64) error {
	_, err := r.db.Exec(`UPDATE error_report_outbox SET artifact_state = 'ready',
		spool_path = ?, manifest_json = ?, preview_json = ?, checksum = ?, size_bytes = ?,
		last_error = '' WHERE incident_id = ? AND artifact_state = 'pending'`,
		path, manifest, preview, checksum, size, incidentID)
	return err
}

func (r *Reporter) markSnapshotFailed(incidentID string, snapshotErr error) {
	_, err := r.db.Exec(`UPDATE error_report_outbox SET artifact_state = 'failed',
		last_error = ?, manifest_json = '{"version":1,"collectors":[],"unavailable":true}',
		preview_json = '{}' WHERE incident_id = ? AND artifact_state = 'pending'`,
		boundedError(snapshotErr, r.config.StoredErrorBytes), incidentID)
	if err != nil {
		return
	}
}

func (r *Reporter) markArtifactUnavailable(row outboxRow, artifactErr error) error {
	_, err := r.db.Exec(`UPDATE error_report_outbox SET artifact_state = 'failed',
		spool_path = '', checksum = '', size_bytes = 0, attempts = 0,
		last_error = ?, next_attempt_at = ?,
		manifest_json = '{"version":1,"collectors":[],"unavailable":true}',
		preview_json = '{}' WHERE id = ? AND artifact_ack = 0`,
		boundedError(artifactErr, r.config.StoredErrorBytes), time.Now().UTC().Format(time.RFC3339Nano), row.id)
	if err == nil && r.isPrivateSpoolPath(row.spoolPath) && r.spoolRoot != nil {
		_ = r.spoolRoot.Remove(filepath.Base(row.spoolPath))
	}
	return err
}

func (r *Reporter) terminalizeExpired() error {
	_, err := r.db.Exec(`UPDATE error_report_outbox SET report_ack = 1, artifact_ack = 1,
		artifact_state = CASE WHEN artifact_required = 1 THEN 'failed' ELSE artifact_state END,
		last_error = 'local retention expired'
		WHERE expires_at <= ?`, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

func (r *Reporter) deleteAcknowledged() error {
	rows, err := r.db.Query(`SELECT spool_path FROM error_report_outbox
		WHERE report_ack = 1 AND artifact_ack = 1`)
	if err != nil {
		return err
	}
	var paths []string
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			rows.Close()
			return err
		}
		if path != "" {
			paths = append(paths, path)
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if _, err := r.db.Exec(`DELETE FROM error_report_outbox
		WHERE report_ack = 1 AND artifact_ack = 1`); err != nil {
		return err
	}
	for _, path := range paths {
		if r.isPrivateSpoolPath(path) && r.spoolRoot != nil {
			_ = r.spoolRoot.Remove(filepath.Base(path))
		}
	}
	return nil
}

func (r *Reporter) referencedSpoolPaths() (map[string]struct{}, error) {
	rows, err := r.db.Query(`SELECT spool_path FROM error_report_outbox WHERE spool_path <> ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	paths := make(map[string]struct{})
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			return nil, err
		}
		paths[path] = struct{}{}
	}
	return paths, rows.Err()
}

func (r *Reporter) isPrivateSpoolPath(path string) bool {
	if r.config.SpoolDir == "" || path == "" {
		return false
	}
	cleanDir := filepath.Clean(r.config.SpoolDir)
	cleanPath := filepath.Clean(path)
	return filepath.Dir(cleanPath) == cleanDir && filepath.Base(cleanPath) != "."
}

func spoolContainsPath(spoolDir, path string) bool {
	if spoolDir == "" || path == "" {
		return false
	}
	absSpool, spoolErr := filepath.Abs(spoolDir)
	absPath, pathErr := filepath.Abs(path)
	if spoolErr != nil || pathErr != nil {
		return true
	}
	relative, err := filepath.Rel(absSpool, absPath)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
