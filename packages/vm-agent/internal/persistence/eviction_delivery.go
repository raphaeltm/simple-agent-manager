package persistence

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

// EvictionDelivery is the allowlisted durable callback payload. Credentials,
// command output, snapshot errors, and other free-form diagnostics are excluded.
// Authorization is resolved at delivery time so token rotation does not strand it.
type EvictionDelivery struct {
	ID               string
	WorkspaceID      string
	ProjectID        string
	NodeID           string
	ContainerID      string
	Generation       string
	Reason           string
	SnapshotCaptured bool
	ContainerStopped bool
	OccurredAt       time.Time
	Attempts         int
	PayloadRevision  int
	NextAttemptAt    time.Time
}

func EvictionDeliveryID(workspaceID, generation, containerID string) string {
	sum := sha256.Sum256([]byte(workspaceID + "\x00" + generation + "\x00" + containerID))
	return hex.EncodeToString(sum[:])
}

func migrateV15(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS eviction_deliveries (
		id TEXT PRIMARY KEY,
		workspace_id TEXT NOT NULL,
		project_id TEXT NOT NULL,
		node_id TEXT NOT NULL,
		container_id TEXT NOT NULL,
		generation TEXT NOT NULL,
		reason TEXT NOT NULL CHECK(reason IN ('memory_pressure', 'oom_kill')),
		snapshot_captured INTEGER NOT NULL,
		container_stopped INTEGER NOT NULL CHECK(container_stopped IN (0, 1)),
		occurred_at INTEGER NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 0,
		next_attempt_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS eviction_deliveries_due ON eviction_deliveries(next_attempt_at, id);`)
	return err
}

func migrateV17(db *sql.DB) error {
	_, err := db.Exec(`ALTER TABLE eviction_deliveries ADD COLUMN payload_revision INTEGER NOT NULL DEFAULT 0`)
	return err
}

// RecordWorkspaceEviction atomically fences recovery as evicted and queues the
// callback. A stale generation cannot enqueue or overwrite a successor's state.
func (s *Store) RecordWorkspaceEviction(ctx context.Context, delivery EvictionDelivery) (bool, error) {
	if delivery.WorkspaceID == "" || delivery.ProjectID == "" || delivery.NodeID == "" || delivery.ContainerID == "" {
		return false, errors.New("incomplete workspace eviction delivery")
	}
	delivery.ID = EvictionDeliveryID(delivery.WorkspaceID, delivery.Generation, delivery.ContainerID)
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() {
		_ = tx.Rollback()
	}()
	result, err := tx.ExecContext(ctx, `UPDATE workspace_metadata SET evicted=1 WHERE workspace_id=? AND eviction_generation=?`, delivery.WorkspaceID, delivery.Generation)
	if err != nil {
		return false, fmt.Errorf("mark persisted workspace evicted: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	if count != 1 {
		return false, nil
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO eviction_deliveries
		(id, workspace_id, project_id, node_id, container_id, generation, reason, snapshot_captured, container_stopped, occurred_at, next_attempt_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
		container_stopped=MAX(eviction_deliveries.container_stopped, excluded.container_stopped),
		snapshot_captured=MAX(eviction_deliveries.snapshot_captured, excluded.snapshot_captured),
		payload_revision=eviction_deliveries.payload_revision + CASE
			WHEN excluded.container_stopped > eviction_deliveries.container_stopped
			  OR excluded.snapshot_captured > eviction_deliveries.snapshot_captured
			THEN 1 ELSE 0 END,
		next_attempt_at=CASE
			WHEN excluded.container_stopped > eviction_deliveries.container_stopped
			  OR excluded.snapshot_captured > eviction_deliveries.snapshot_captured
			THEN MIN(eviction_deliveries.next_attempt_at, excluded.next_attempt_at)
			ELSE eviction_deliveries.next_attempt_at END`,
		delivery.ID, delivery.WorkspaceID, delivery.ProjectID, delivery.NodeID, delivery.ContainerID, delivery.Generation,
		delivery.Reason, delivery.SnapshotCaptured, delivery.ContainerStopped, delivery.OccurredAt.UnixMilli(), delivery.OccurredAt.UnixMilli())
	if err != nil {
		return false, fmt.Errorf("queue workspace eviction: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

// ClaimEvictionDelivery leases one due callback before HTTP starts. Optional id
// targets an immediate delivery; the empty ID claims the oldest due row.
func (s *Store) ClaimEvictionDelivery(ctx context.Context, id string, now time.Time, retryBase, retryMax, leaseMinimum time.Duration) (*EvictionDelivery, error) {
	if retryBase <= 0 || retryMax <= 0 || leaseMinimum <= 0 {
		return nil, errors.New("invalid eviction retry durations")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = tx.Rollback()
	}()
	var d EvictionDelivery
	var occurredAt, nextAt int64
	err = tx.QueryRowContext(ctx, `SELECT id, workspace_id, project_id, node_id, container_id, generation, reason,
		snapshot_captured, container_stopped, occurred_at, attempts, payload_revision, next_attempt_at
		FROM eviction_deliveries WHERE next_attempt_at <= ? AND (? = '' OR id = ?) ORDER BY next_attempt_at, id LIMIT 1`,
		now.UnixMilli(), id, id).Scan(&d.ID, &d.WorkspaceID, &d.ProjectID, &d.NodeID, &d.ContainerID, &d.Generation, &d.Reason,
		&d.SnapshotCaptured, &d.ContainerStopped, &occurredAt, &d.Attempts, &d.PayloadRevision, &nextAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	d.OccurredAt = time.UnixMilli(occurredAt).UTC()
	delay := evictionRetryDelay(d.Attempts, retryBase, retryMax)
	if delay < leaseMinimum {
		delay = leaseMinimum
	}
	d.NextAttemptAt = now.Add(delay)
	_, err = tx.ExecContext(ctx, `UPDATE eviction_deliveries SET attempts=attempts+1, next_attempt_at=? WHERE id=? AND payload_revision=?`, d.NextAttemptAt.UnixMilli(), d.ID, d.PayloadRevision)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	d.Attempts++
	return &d, nil
}

func evictionRetryDelay(attempts int, base, maximum time.Duration) time.Duration {
	delay := base
	for i := 0; i < attempts && delay < maximum; i++ {
		if delay > maximum/2 {
			return maximum
		}
		delay *= 2
	}
	if delay > maximum {
		return maximum
	}
	return delay
}

// CompleteEvictionDelivery retires acknowledged/terminal callbacks. Attempts and
// payload revision are fenced so a slow expired lease cannot delete a newer
// retry or a payload upgraded after the delivery was claimed.
func (s *Store) CompleteEvictionDelivery(ctx context.Context, id string, attempts int, payloadRevision int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `DELETE FROM eviction_deliveries WHERE id=? AND attempts=? AND payload_revision=?`, id, attempts, payloadRevision)
	return err
}
