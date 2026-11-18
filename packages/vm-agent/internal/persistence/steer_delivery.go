package persistence

import (
	"database/sql"
	"fmt"
	"time"
)

// Steer receipts are kept apart from prompt receipts so a steer that was not
// consumed can be delivered later as an ordinary prompt under the same
// control-plane delivery ID.
const (
	SteerReceiptAccepted    = "accepted"
	SteerReceiptInFlight    = "in_flight"
	SteerReceiptInjected    = "injected"
	SteerReceiptNotConsumed = "not_consumed"
	SteerReceiptAmbiguous   = "ambiguous"
)

// SteerDeliveryReceipt is the durable VM record of one live-steer delivery.
// It never contains prompt content.
type SteerDeliveryReceipt struct {
	DeliveryID      string `json:"deliveryId"`
	State           string `json:"state"`
	Reason          string `json:"reason,omitempty"`
	RuntimeIdentity string `json:"runtimeIdentity"`
	PromptEpoch     *int64 `json:"promptEpoch"`
	AcceptedAt      *int64 `json:"acceptedAt"`
	CompletedAt     *int64 `json:"completedAt"`
	protocolVersion int
	requestHash     string
}

// migrateV21 adds the live-steer receipt ledger.
func migrateV21(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS steer_delivery_receipts (
			workspace_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			delivery_id TEXT NOT NULL,
			protocol_version INTEGER NOT NULL,
			request_hash TEXT NOT NULL,
			state TEXT NOT NULL,
			runtime_id TEXT NOT NULL,
			reason TEXT NOT NULL DEFAULT '',
			prompt_epoch INTEGER,
			accepted_at INTEGER NOT NULL,
			completed_at INTEGER,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (workspace_id, session_id, delivery_id)
		);
	`)
	return err
}

// AcceptSteerDelivery records a steer before any adapter contact. A matching
// replay returns the existing receipt; reusing an ID for other content conflicts.
func (s *Store) AcceptSteerDelivery(workspaceID, sessionID, deliveryID string, protocolVersion int, requestHash, runtimeID string) (SteerDeliveryReceipt, bool, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, err := s.getSteerDeliveryLocked(workspaceID, sessionID, deliveryID)
	if err != nil && err != sql.ErrNoRows {
		return SteerDeliveryReceipt{}, false, false, err
	}
	if err == nil {
		conflict := existing.requestHash != requestHash || existing.protocolVersion != protocolVersion
		return existing, false, conflict, nil
	}
	now := time.Now().UnixMilli()
	if _, err = s.db.Exec(`INSERT INTO steer_delivery_receipts
		(workspace_id, session_id, delivery_id, protocol_version, request_hash, state, runtime_id, accepted_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, workspaceID, sessionID, deliveryID, protocolVersion,
		requestHash, SteerReceiptAccepted, runtimeID, now, now); err != nil {
		return SteerDeliveryReceipt{}, false, false, fmt.Errorf("accept steer delivery: %w", err)
	}
	receipt, err := s.getSteerDeliveryLocked(workspaceID, sessionID, deliveryID)
	return receipt, true, false, err
}

// ClaimSteerDelivery crosses the possible-send boundary immediately before the
// adapter request. Only an accepted receipt from this runtime is claimable.
func (s *Store) ClaimSteerDelivery(workspaceID, sessionID, deliveryID, runtimeID string, promptEpoch int64) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result, err := s.db.Exec(`UPDATE steer_delivery_receipts SET state = ?, prompt_epoch = ?, updated_at = ?
		WHERE workspace_id = ? AND session_id = ? AND delivery_id = ? AND state = ? AND runtime_id = ?`,
		SteerReceiptInFlight, promptEpoch, time.Now().UnixMilli(), workspaceID, sessionID, deliveryID,
		SteerReceiptAccepted, runtimeID)
	if err != nil {
		return false, fmt.Errorf("claim steer delivery: %w", err)
	}
	rows, err := result.RowsAffected()
	return rows == 1, err
}

// CompleteSteerDelivery records the single outcome for this runtime's attempt.
// An unclaimed receipt may only finish as not consumed.
func (s *Store) CompleteSteerDelivery(workspaceID, sessionID, deliveryID, runtimeID, state, reason string) (SteerDeliveryReceipt, error) {
	switch state {
	case SteerReceiptInjected, SteerReceiptNotConsumed, SteerReceiptAmbiguous:
	default:
		return SteerDeliveryReceipt{}, fmt.Errorf("invalid terminal steer state %q", state)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UnixMilli()
	if _, err := s.db.Exec(`UPDATE steer_delivery_receipts SET state = ?, reason = ?, completed_at = ?, updated_at = ?
		WHERE workspace_id = ? AND session_id = ? AND delivery_id = ? AND runtime_id = ?
		AND (state = ? OR (state = ? AND ? = ?))`, state, reason, now, now, workspaceID, sessionID,
		deliveryID, runtimeID, SteerReceiptInFlight, SteerReceiptAccepted, state, SteerReceiptNotConsumed); err != nil {
		return SteerDeliveryReceipt{}, fmt.Errorf("complete steer delivery: %w", err)
	}
	return s.getSteerDeliveryLocked(workspaceID, sessionID, deliveryID)
}

// GetSteerDelivery reconciles receipts left by an earlier VM runtime: one that
// never crossed the claim boundary was never sent; one that did is ambiguous.
// Neither is ever replayed by the VM.
func (s *Store) GetSteerDelivery(workspaceID, sessionID, deliveryID, runtimeID string) (SteerDeliveryReceipt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	receipt, err := s.getSteerDeliveryLocked(workspaceID, sessionID, deliveryID)
	if err != nil || receipt.RuntimeIdentity == runtimeID {
		return receipt, err
	}
	next, reason := "", ""
	switch receipt.State {
	case SteerReceiptAccepted:
		next, reason = SteerReceiptNotConsumed, "runtime_changed_before_invocation"
	case SteerReceiptInFlight:
		next, reason = SteerReceiptAmbiguous, "runtime_changed_after_invocation_claim"
	default:
		return receipt, nil
	}
	now := time.Now().UnixMilli()
	if _, err = s.db.Exec(`UPDATE steer_delivery_receipts SET state = ?, reason = ?, completed_at = ?, updated_at = ?
		WHERE workspace_id = ? AND session_id = ? AND delivery_id = ? AND state = ?`, next, reason, now, now,
		workspaceID, sessionID, deliveryID, receipt.State); err != nil {
		return SteerDeliveryReceipt{}, fmt.Errorf("reconcile steer delivery: %w", err)
	}
	return s.getSteerDeliveryLocked(workspaceID, sessionID, deliveryID)
}

func (s *Store) getSteerDeliveryLocked(workspaceID, sessionID, deliveryID string) (SteerDeliveryReceipt, error) {
	var receipt SteerDeliveryReceipt
	err := s.db.QueryRow(`SELECT delivery_id, protocol_version, request_hash, state, runtime_id, reason,
		prompt_epoch, accepted_at, completed_at
		FROM steer_delivery_receipts WHERE workspace_id = ? AND session_id = ? AND delivery_id = ?`,
		workspaceID, sessionID, deliveryID).Scan(&receipt.DeliveryID, &receipt.protocolVersion,
		&receipt.requestHash, &receipt.State, &receipt.RuntimeIdentity, &receipt.Reason,
		&receipt.PromptEpoch, &receipt.AcceptedAt, &receipt.CompletedAt)
	return receipt, err
}
