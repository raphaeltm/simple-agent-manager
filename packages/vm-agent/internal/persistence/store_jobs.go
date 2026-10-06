package persistence

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"
	"time"
)

type JobRecord struct {
	ID           string
	Kind         string
	ScopeID      string
	Status       string
	CurrentStep  string
	StartedAt    string
	UpdatedAt    string
	CompletedAt  string
	ErrorMessage string
	ResultJSON   string
}

type JobEventRecord struct {
	ID           int64
	JobID        string
	Level        string
	EventType    string
	CurrentStep  string
	Message      string
	ErrorMessage string
	DetailJSON   string
	CreatedAt    string
}

func migrateV8(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS vm_jobs (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			scope_id TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL,
			current_step TEXT NOT NULL DEFAULT '',
			started_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			completed_at TEXT NOT NULL DEFAULT '',
			error_message TEXT NOT NULL DEFAULT '',
			result_json TEXT NOT NULL DEFAULT ''
		);
		CREATE INDEX IF NOT EXISTS idx_vm_jobs_kind_scope ON vm_jobs(kind, scope_id);
		CREATE INDEX IF NOT EXISTS idx_vm_jobs_status ON vm_jobs(status);

		CREATE TABLE IF NOT EXISTS vm_job_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			job_id TEXT NOT NULL,
			level TEXT NOT NULL DEFAULT 'info',
			event_type TEXT NOT NULL DEFAULT '',
			current_step TEXT NOT NULL DEFAULT '',
			message TEXT NOT NULL DEFAULT '',
			error_message TEXT NOT NULL DEFAULT '',
			detail_json TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			FOREIGN KEY(job_id) REFERENCES vm_jobs(id) ON DELETE CASCADE
		);
		CREATE INDEX IF NOT EXISTS idx_vm_job_events_job_id ON vm_job_events(job_id, id);
	`)
	return err
}

func (s *Store) UpsertJob(job JobRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UTC().Format(time.RFC3339Nano)
	if job.StartedAt == "" {
		job.StartedAt = now
	}
	job.UpdatedAt = now
	job.ErrorMessage = redactPersistedText(job.ErrorMessage)
	job.ResultJSON = redactPersistedText(job.ResultJSON)

	_, err := s.db.Exec(
		`INSERT INTO vm_jobs (id, kind, scope_id, status, current_step, started_at, updated_at, completed_at, error_message, result_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			kind = excluded.kind,
			scope_id = excluded.scope_id,
			status = excluded.status,
			current_step = excluded.current_step,
			updated_at = excluded.updated_at,
			completed_at = excluded.completed_at,
			error_message = excluded.error_message,
			result_json = excluded.result_json`,
		job.ID, job.Kind, job.ScopeID, job.Status, job.CurrentStep, job.StartedAt, job.UpdatedAt, job.CompletedAt, job.ErrorMessage, job.ResultJSON,
	)
	if err != nil {
		return fmt.Errorf("upsert vm job: %w", err)
	}
	return nil
}

func (s *Store) CompleteJob(jobID, status, currentStep, errorMessage, resultJSON string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.Exec(
		`UPDATE vm_jobs
		SET status = ?, current_step = ?, updated_at = ?, completed_at = ?, error_message = ?, result_json = ?
		WHERE id = ?`,
		status, currentStep, now, now, redactPersistedText(errorMessage), redactPersistedText(resultJSON), jobID,
	)
	if err != nil {
		return fmt.Errorf("complete vm job: %w", err)
	}
	return nil
}

func (s *Store) AddJobEvent(jobID string, event JobEventRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if event.CreatedAt == "" {
		event.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	event.Message = redactPersistedText(event.Message)
	event.ErrorMessage = redactPersistedText(event.ErrorMessage)
	event.DetailJSON = redactPersistedText(event.DetailJSON)

	_, err := s.db.Exec(
		`INSERT INTO vm_job_events (job_id, level, event_type, current_step, message, error_message, detail_json, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		jobID, firstNonEmpty(event.Level, "info"), event.EventType, event.CurrentStep, event.Message, event.ErrorMessage, event.DetailJSON, event.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("add vm job event: %w", err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := s.db.Exec(
		`UPDATE vm_jobs SET current_step = ?, updated_at = ? WHERE id = ?`,
		event.CurrentStep, now, jobID,
	); err != nil {
		return fmt.Errorf("touch vm job after event: %w", err)
	}
	return nil
}

func (s *Store) GetJob(jobID string) (*JobRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var job JobRecord
	err := s.db.QueryRow(
		`SELECT id, kind, scope_id, status, current_step, started_at, updated_at, completed_at, error_message, result_json
		FROM vm_jobs WHERE id = ?`,
		jobID,
	).Scan(&job.ID, &job.Kind, &job.ScopeID, &job.Status, &job.CurrentStep, &job.StartedAt, &job.UpdatedAt, &job.CompletedAt, &job.ErrorMessage, &job.ResultJSON)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get vm job: %w", err)
	}
	return &job, nil
}

func (s *Store) ListJobEvents(jobID string) ([]JobEventRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rows, err := s.db.Query(
		`SELECT id, job_id, level, event_type, current_step, message, error_message, detail_json, created_at
		FROM vm_job_events WHERE job_id = ? ORDER BY id ASC`,
		jobID,
	)
	if err != nil {
		return nil, fmt.Errorf("list vm job events: %w", err)
	}
	defer rows.Close()

	events := []JobEventRecord{}
	for rows.Next() {
		var event JobEventRecord
		if err := rows.Scan(&event.ID, &event.JobID, &event.Level, &event.EventType, &event.CurrentStep, &event.Message, &event.ErrorMessage, &event.DetailJSON, &event.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan vm job event: %w", err)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate vm job events: %w", err)
	}
	return events, nil
}

func (s *Store) MarkActiveJobsInterrupted() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.Exec(
		`UPDATE vm_jobs
		SET status = 'interrupted', current_step = 'interrupted', updated_at = ?, completed_at = ?, error_message = 'vm-agent restarted before job reached a terminal state'
		WHERE completed_at = '' AND status NOT IN ('succeeded', 'failed', 'canceled', 'interrupted')`,
		now, now,
	)
	if err != nil {
		return fmt.Errorf("mark active vm jobs interrupted: %w", err)
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func marshalRedactedDetail(detail map[string]any) string {
	if len(detail) == 0 {
		return ""
	}
	raw, err := json.Marshal(detail)
	if err != nil {
		return ""
	}
	return redactPersistedText(string(raw))
}

func redactPersistedText(value string) string {
	if value == "" {
		return ""
	}
	redacted := bearerTokenPattern.ReplaceAllString(value, "Bearer [REDACTED]")
	for _, pattern := range secretValuePatterns {
		redacted = pattern.ReplaceAllString(redacted, "${1}[REDACTED]")
	}
	return redacted
}

var (
	bearerTokenPattern  = regexp.MustCompile(`(?i)Bearer\s+[^&\s"',}\]]+`)
	secretValuePatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)(X-Amz-Signature=)[^&\s"',}\]]+`),
		regexp.MustCompile(`(?i)(X-Amz-Credential=)[^&\s"',}\]]+`),
		regexp.MustCompile(`(?i)(X-Amz-Security-Token=)[^&\s"',}\]]+`),
		regexp.MustCompile(`(?i)((?:callbackToken|authorization|jwt|token|password|secret)["']?\s*[:=]\s*["']?)[^&\s"',}\]]+`),
	}
)
