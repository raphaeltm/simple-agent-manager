package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/persistence"
)

// steeringCapabilityVersion is advertised under agentCapabilities().steering.
// Version 1: POST .../steer with a stable deliveryId, durable receipts, lookup,
// and prompt_required/unsupported outcomes that guarantee non-consumption.
const steeringCapabilityVersion = 1

type steerPromptRequest struct {
	ProtocolVersion int    `json:"protocolVersion"`
	DeliveryID      string `json:"deliveryId"`
	MessageID       string `json:"messageId"`
	Prompt          string `json:"prompt"`
}

type steerPromptResponse struct {
	Status    string                           `json:"status"`
	SessionID string                           `json:"sessionId"`
	Receipt   persistence.SteerDeliveryReceipt `json:"receipt"`
}

func steeringCapability() map[string]interface{} {
	return map[string]interface{}{
		"supported": true,
		"version":   steeringCapabilityVersion,
		"lookup":    true,
		"states": []string{persistence.SteerReceiptAccepted, persistence.SteerReceiptInFlight,
			persistence.SteerReceiptInjected, persistence.SteerReceiptNotConsumed, persistence.SteerReceiptAmbiguous},
	}
}

// steerSessionHost is the SessionHost steering call. A package variable so
// handler tests can drive the receipt protocol through the real handler.
var steerSessionHost = func(host *acp.SessionHost, text, messageID string, claim func(int64) error) acp.SteerResult {
	return host.Steer(text, messageID, claim)
}

func steerDeliveryFingerprint(protocolVersion int, messageID, prompt string) string {
	return promptDeliveryFingerprint(protocolVersion, messageID, "steer\x00"+prompt)
}

// handleSteerPrompt adds a control-plane message to the session's running turn.
// The response status is the receipt state, so a lost response is recovered by
// repeating the request or reading the receipt; a delivery is never invoked twice.
func (s *Server) handleSteerPrompt(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	sessionID := r.PathValue("sessionId")
	if workspaceID == "" || sessionID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId and sessionId are required")
		return
	}
	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return
	}
	var body steerPromptRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	body.Prompt = strings.TrimSpace(body.Prompt)
	body.MessageID = strings.TrimSpace(body.MessageID)
	body.DeliveryID = strings.TrimSpace(body.DeliveryID)
	if body.Prompt == "" {
		writeError(w, http.StatusBadRequest, "prompt is required")
		return
	}
	if body.ProtocolVersion != steeringCapabilityVersion {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{
			"error":             "unsupported_protocol_version",
			"supportedVersions": []int{steeringCapabilityVersion},
		})
		return
	}
	if !validExecutionProtocolID(body.DeliveryID, maxDeliveryIDLength) {
		writeError(w, http.StatusBadRequest, "deliveryId has an invalid format")
		return
	}

	s.sessionHostMu.Lock()
	host := s.sessionHosts[workspaceID+":"+sessionID]
	s.sessionHostMu.Unlock()
	if host == nil {
		writeError(w, http.StatusNotFound, "no active agent session found")
		return
	}

	hash := steerDeliveryFingerprint(body.ProtocolVersion, body.MessageID, body.Prompt)
	receipt, created, conflict, err := s.store.AcceptSteerDelivery(workspaceID, sessionID,
		body.DeliveryID, body.ProtocolVersion, hash, s.executionRuntimeID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to persist steer receipt")
		return
	}
	if conflict {
		writeJSON(w, http.StatusConflict, steerPromptResponse{Status: "conflict", SessionID: sessionID, Receipt: receipt})
		return
	}
	if !created {
		receipt, err = s.store.GetSteerDelivery(workspaceID, sessionID, body.DeliveryID, s.executionRuntimeID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to reconcile steer receipt")
			return
		}
		writeJSON(w, http.StatusOK, steerPromptResponse{Status: receipt.State, SessionID: sessionID, Receipt: receipt})
		return
	}

	claimed := false
	result := steerSessionHost(host, body.Prompt, body.MessageID, func(promptEpoch int64) error {
		ok, claimErr := s.store.ClaimSteerDelivery(workspaceID, sessionID, body.DeliveryID,
			s.executionRuntimeID, promptEpoch)
		if claimErr != nil {
			return claimErr
		}
		if !ok {
			return errors.New("steer receipt was not claimable")
		}
		claimed = true
		return nil
	})
	state := persistence.SteerReceiptNotConsumed
	switch {
	case result.Outcome == acp.SteerInjected:
		state = persistence.SteerReceiptInjected
	case result.Consumed():
		state = persistence.SteerReceiptAmbiguous
	case result.Outcome == acp.SteerNotClaimed && claimed:
		// Defensive: a claim that succeeded is never reported as unclaimed.
		state = persistence.SteerReceiptAmbiguous
	}
	reason := result.Reason
	if reason == "" && result.Outcome != acp.SteerInjected {
		reason = string(result.Outcome)
	}
	receipt, err = s.store.CompleteSteerDelivery(workspaceID, sessionID, body.DeliveryID,
		s.executionRuntimeID, state, reason)
	if err != nil {
		// The outcome is decided but not durable; the caller reconciles through lookup.
		slog.Error("Failed to complete steer receipt", "workspace", workspaceID, "session", sessionID,
			"deliveryId", body.DeliveryID, "state", state, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to complete steer receipt")
		return
	}
	s.appendNodeEvent(workspaceID, "info", "agent_session.steer", "Live steer "+receipt.State, map[string]interface{}{
		"sessionId":  sessionID,
		"messageId":  body.MessageID,
		"deliveryId": body.DeliveryID,
		"outcome":    string(result.Outcome),
		"reason":     receipt.Reason,
	})
	writeJSON(w, http.StatusOK, steerPromptResponse{Status: receipt.State, SessionID: sessionID, Receipt: receipt})
}

func (s *Server) handleGetSteerReceipt(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	sessionID := r.PathValue("sessionId")
	deliveryID := strings.TrimSpace(r.PathValue("deliveryId"))
	if workspaceID == "" || sessionID == "" || !validExecutionProtocolID(deliveryID, maxDeliveryIDLength) {
		writeError(w, http.StatusBadRequest, "workspaceId, sessionId, and deliveryId are required")
		return
	}
	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return
	}
	receipt, err := s.store.GetSteerDelivery(workspaceID, sessionID, deliveryID, s.executionRuntimeID)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, persistence.SteerDeliveryReceipt{
			DeliveryID: deliveryID, State: "not_found", RuntimeIdentity: s.executionRuntimeID,
		})
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read steer receipt")
		return
	}
	writeJSON(w, http.StatusOK, receipt)
}
