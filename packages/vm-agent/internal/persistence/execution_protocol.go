package persistence

import (
	"database/sql"
	"fmt"
	"time"
)

const (
	PromptReceiptAccepted  = "accepted"
	PromptReceiptInFlight  = "in_flight"
	PromptReceiptCompleted = "completed"
	PromptReceiptAmbiguous = "ambiguous"
)

// PromptDeliveryReceipt is the durable VM acknowledgement for one stable
// control-plane delivery ID. It never contains prompt content.
type PromptDeliveryReceipt struct {
	DeliveryID      string `json:"deliveryId"`
	State           string `json:"state"`
	RuntimeIdentity string `json:"runtimeIdentity"`
	AcceptedAt      *int64 `json:"acceptedAt"`
	CompletedAt     *int64 `json:"completedAt"`
	workspaceID     string
	sessionID       string
	protocolVersion int
	requestHash     string
	stopReason      string
	errorCode       string
	updatedAt       int64
}

// AcceptPromptDelivery records durable acceptance. A matching replay returns
// the existing receipt; reusing an ID for different content is a conflict.
func (s *Store) AcceptPromptDelivery(workspaceID, sessionID, deliveryID string, protocolVersion int, requestHash string) (PromptDeliveryReceipt, bool, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing, err := s.getPromptDeliveryLocked(workspaceID, sessionID, deliveryID)
	if err != nil && err != sql.ErrNoRows {
		return PromptDeliveryReceipt{}, false, false, err
	}
	if err == nil {
		conflict := existing.requestHash != requestHash || existing.protocolVersion != protocolVersion
		return existing, false, conflict, nil
	}

	now := time.Now().UnixMilli()
	_, err = s.db.Exec(`INSERT INTO prompt_delivery_receipts
		(workspace_id, session_id, delivery_id, protocol_version, request_hash, state, accepted_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, workspaceID, sessionID, deliveryID,
		protocolVersion, requestHash, PromptReceiptAccepted, now, now)
	if err != nil {
		return PromptDeliveryReceipt{}, false, false, fmt.Errorf("accept prompt delivery: %w", err)
	}
	receipt, err := s.getPromptDeliveryLocked(workspaceID, sessionID, deliveryID)
	return receipt, true, false, err
}

// ClaimPromptDelivery atomically crosses the durable boundary immediately
// before agent invocation. A non-accepted receipt is never claimable again.
func (s *Store) ClaimPromptDelivery(workspaceID, sessionID, deliveryID, runtimeID string) (PromptDeliveryReceipt, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UnixMilli()
	result, err := s.db.Exec(`UPDATE prompt_delivery_receipts
		SET state = ?, runtime_id = ?, updated_at = ?
		WHERE workspace_id = ? AND session_id = ? AND delivery_id = ? AND state = ?`,
		PromptReceiptInFlight, runtimeID, now, workspaceID, sessionID, deliveryID, PromptReceiptAccepted)
	if err != nil {
		return PromptDeliveryReceipt{}, false, fmt.Errorf("claim prompt delivery: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return PromptDeliveryReceipt{}, false, fmt.Errorf("claim prompt delivery rows: %w", err)
	}
	receipt, err := s.getPromptDeliveryLocked(workspaceID, sessionID, deliveryID)
	return receipt, rows == 1, err
}

// CompletePromptDelivery records the single terminal result for the runtime
// that performed the invocation. Late or foreign-runtime updates are ignored.
func (s *Store) CompletePromptDelivery(workspaceID, sessionID, deliveryID, runtimeID, stopReason, errorCode string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UnixMilli()
	_, err := s.db.Exec(`UPDATE prompt_delivery_receipts
		SET state = ?, stop_reason = ?, error_code = ?, completed_at = ?, updated_at = ?
		WHERE workspace_id = ? AND session_id = ? AND delivery_id = ?
		AND state = ? AND runtime_id = ?`, PromptReceiptCompleted, stopReason,
		errorCode, now, now, workspaceID, sessionID, deliveryID, PromptReceiptInFlight, runtimeID)
	if err != nil {
		return fmt.Errorf("complete prompt delivery: %w", err)
	}
	return nil
}

// GetPromptDelivery reconciles an in-flight receipt owned by an earlier VM
// runtime to explicit ambiguity. Such a delivery is never automatically replayed.
func (s *Store) GetPromptDelivery(workspaceID, sessionID, deliveryID, runtimeID string) (PromptDeliveryReceipt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	receipt, err := s.getPromptDeliveryLocked(workspaceID, sessionID, deliveryID)
	if err != nil {
		return PromptDeliveryReceipt{}, err
	}
	if receipt.State == PromptReceiptInFlight && receipt.RuntimeIdentity != "" && receipt.RuntimeIdentity != runtimeID {
		now := time.Now().UnixMilli()
		_, err = s.db.Exec(`UPDATE prompt_delivery_receipts SET state = ?, error_code = ?, updated_at = ?
			WHERE workspace_id = ? AND session_id = ? AND delivery_id = ? AND state = ?`,
			PromptReceiptAmbiguous, "runtime_changed_after_invocation_claim", now,
			workspaceID, sessionID, deliveryID, PromptReceiptInFlight)
		if err != nil {
			return PromptDeliveryReceipt{}, fmt.Errorf("mark prompt delivery ambiguous: %w", err)
		}
		receipt, err = s.getPromptDeliveryLocked(workspaceID, sessionID, deliveryID)
	}
	return receipt, err
}

func (s *Store) getPromptDeliveryLocked(workspaceID, sessionID, deliveryID string) (PromptDeliveryReceipt, error) {
	var receipt PromptDeliveryReceipt
	err := s.db.QueryRow(`SELECT workspace_id, session_id, delivery_id, protocol_version,
		request_hash, state, runtime_id, stop_reason, error_code, accepted_at, completed_at, updated_at
		FROM prompt_delivery_receipts WHERE workspace_id = ? AND session_id = ? AND delivery_id = ?`,
		workspaceID, sessionID, deliveryID).Scan(&receipt.workspaceID, &receipt.sessionID,
		&receipt.DeliveryID, &receipt.protocolVersion, &receipt.requestHash, &receipt.State,
		&receipt.RuntimeIdentity, &receipt.stopReason, &receipt.errorCode, &receipt.AcceptedAt,
		&receipt.CompletedAt, &receipt.updatedAt)
	if err != nil {
		return PromptDeliveryReceipt{}, err
	}
	return receipt, nil
}

const (
	RolloverAccepted   = "accepted"
	RolloverInProgress = "in_progress"
	RolloverCompleted  = "completed"
	RolloverSuperseded = "superseded"
	RolloverFailed     = "failed"
)

// CheckpointRolloverOperation is the durable status returned by the versioned
// rollover endpoint and its lost-response lookup.
type CheckpointRolloverOperation struct {
	WorkspaceID     string `json:"workspaceId"`
	SessionID       string `json:"sessionId"`
	OperationID     string `json:"operationId"`
	ProtocolVersion int    `json:"protocolVersion"`
	State           string `json:"state"`
	Forced          bool   `json:"forced"`
	ACPSessionID    string `json:"acpSessionId,omitempty"`
	ErrorCode       string `json:"errorCode,omitempty"`
	ErrorMessage    string `json:"errorMessage,omitempty"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
	requestHash     string
	runtimeID       string
}

func (s *Store) AcceptCheckpointRollover(workspaceID, sessionID, operationID string, protocolVersion int, requestHash string) (CheckpointRolloverOperation, bool, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, err := s.getCheckpointRolloverLocked(workspaceID, sessionID, operationID)
	if err != nil && err != sql.ErrNoRows {
		return CheckpointRolloverOperation{}, false, false, err
	}
	if err == nil {
		return existing, false, existing.requestHash != requestHash || existing.ProtocolVersion != protocolVersion, nil
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err = s.db.Exec(`INSERT INTO checkpoint_rollover_operations
		(workspace_id, session_id, operation_id, protocol_version, request_hash, state, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, workspaceID, sessionID, operationID,
		protocolVersion, requestHash, RolloverAccepted, now, now)
	if err != nil {
		return CheckpointRolloverOperation{}, false, false, fmt.Errorf("accept checkpoint rollover: %w", err)
	}
	op, err := s.getCheckpointRolloverLocked(workspaceID, sessionID, operationID)
	return op, true, false, err
}

func (s *Store) StartCheckpointRollover(workspaceID, sessionID, operationID, runtimeID string) (CheckpointRolloverOperation, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := s.db.Exec(`UPDATE checkpoint_rollover_operations SET state = ?, runtime_id = ?, updated_at = ?
		WHERE workspace_id = ? AND session_id = ? AND operation_id = ? AND state = ?`,
		RolloverInProgress, runtimeID, now, workspaceID, sessionID, operationID, RolloverAccepted)
	if err != nil {
		return CheckpointRolloverOperation{}, false, fmt.Errorf("start checkpoint rollover: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return CheckpointRolloverOperation{}, false, err
	}
	op, err := s.getCheckpointRolloverLocked(workspaceID, sessionID, operationID)
	return op, rows == 1, err
}

func (s *Store) CompleteCheckpointRollover(workspaceID, sessionID, operationID, runtimeID, state string, forced bool, acpSessionID, errorCode, errorMessage string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if state != RolloverCompleted && state != RolloverSuperseded && state != RolloverFailed {
		return fmt.Errorf("invalid terminal rollover state %q", state)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.Exec(`UPDATE checkpoint_rollover_operations SET state = ?, forced = ?,
		acp_session_id = ?, error_code = ?, error_message = ?, updated_at = ?
		WHERE workspace_id = ? AND session_id = ? AND operation_id = ? AND state = ? AND runtime_id = ?`,
		state, forced, acpSessionID, errorCode, errorMessage, now, workspaceID, sessionID,
		operationID, RolloverInProgress, runtimeID)
	if err != nil {
		return fmt.Errorf("complete checkpoint rollover: %w", err)
	}
	return nil
}

func (s *Store) GetCheckpointRollover(workspaceID, sessionID, operationID, runtimeID string) (CheckpointRolloverOperation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	op, err := s.getCheckpointRolloverLocked(workspaceID, sessionID, operationID)
	if err != nil {
		return CheckpointRolloverOperation{}, err
	}
	if op.State == RolloverInProgress && op.runtimeID != "" && op.runtimeID != runtimeID {
		now := time.Now().UTC().Format(time.RFC3339Nano)
		_, err = s.db.Exec(`UPDATE checkpoint_rollover_operations SET state = ?, error_code = ?,
			error_message = ?, updated_at = ? WHERE workspace_id = ? AND session_id = ? AND operation_id = ? AND state = ?`,
			RolloverFailed, "vm_runtime_interrupted", "VM agent restarted before rollover completed", now,
			workspaceID, sessionID, operationID, RolloverInProgress)
		if err != nil {
			return CheckpointRolloverOperation{}, err
		}
		op, err = s.getCheckpointRolloverLocked(workspaceID, sessionID, operationID)
	}
	return op, err
}

func (s *Store) getCheckpointRolloverLocked(workspaceID, sessionID, operationID string) (CheckpointRolloverOperation, error) {
	var op CheckpointRolloverOperation
	var forced int
	err := s.db.QueryRow(`SELECT workspace_id, session_id, operation_id, protocol_version,
		request_hash, state, runtime_id, forced, acp_session_id, error_code, error_message, created_at, updated_at
		FROM checkpoint_rollover_operations WHERE workspace_id = ? AND session_id = ? AND operation_id = ?`,
		workspaceID, sessionID, operationID).Scan(&op.WorkspaceID, &op.SessionID, &op.OperationID,
		&op.ProtocolVersion, &op.requestHash, &op.State, &op.runtimeID, &forced, &op.ACPSessionID,
		&op.ErrorCode, &op.ErrorMessage, &op.CreatedAt, &op.UpdatedAt)
	op.Forced = forced != 0
	return op, err
}

// DeleteWorkspaceExecutionProtocol removes receipt and rollover ledgers once
// their workspace is deleted. The ledgers are intentionally durable across
// process restarts, but have no reconciliation value after workspace teardown.
func (s *Store) DeleteWorkspaceExecutionProtocol(workspaceID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin workspace execution protocol cleanup: %w", err)
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`DELETE FROM prompt_delivery_receipts WHERE workspace_id = ?`, workspaceID); err != nil {
		return fmt.Errorf("delete workspace prompt receipts: %w", err)
	}
	if _, err = tx.Exec(`DELETE FROM checkpoint_rollover_operations WHERE workspace_id = ?`, workspaceID); err != nil {
		return fmt.Errorf("delete workspace checkpoint rollovers: %w", err)
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace execution protocol cleanup: %w", err)
	}
	return nil
}
