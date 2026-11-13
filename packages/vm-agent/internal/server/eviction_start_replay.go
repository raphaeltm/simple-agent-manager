package server

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/persistence"
)

func evictionStartFingerprint(request any) string {
	data, _ := json.Marshal(request) // The start request contains only JSON values.
	return fmt.Sprintf("%x", sha256.Sum256(data))
}

// A lost start response must not turn an eviction-owned prompt into a failed
// task. Acknowledge only the identical previously admitted request, without
// changing settings, credentials, routing, receipts or admitting another prompt.
func (s *Server) respondToEvictionOwnedStart(w http.ResponseWriter, workspaceID, sessionID, fingerprint string, protocol int, deliveryID, deliveryHash string) bool {
	key := workspaceID + ":" + sessionID
	s.sessionHostMu.Lock()
	finalizing := s.isEvictionFinalizing(workspaceID)
	host := s.sessionHosts[key]
	original := s.sessionProfileOvr[key].StartFingerprint
	s.sessionHostMu.Unlock()
	if !finalizing {
		return false
	}
	if host == nil || host.Status() != acp.HostPrompting || original == "" || original != fingerprint {
		writeError(w, http.StatusConflict, "workspace eviction owns the current runtime")
		return true
	}
	if deliveryID != "" {
		if s.store == nil {
			writeError(w, http.StatusConflict, "prompt receipt unavailable")
			return true
		}
		receipt, err := s.store.GetPromptDelivery(workspaceID, sessionID, deliveryID, s.executionRuntimeID)
		if err != nil || receipt.State == persistence.PromptReceiptAccepted {
			writeError(w, http.StatusConflict, "prompt delivery was not previously invoked")
			return true
		}
		receipt, created, conflict, err := s.store.AcceptPromptDelivery(workspaceID, sessionID, deliveryID, protocol, deliveryHash)
		if err != nil || created || conflict {
			writeError(w, http.StatusConflict, "prompt delivery does not match the active start")
			return true
		}
		writeJSON(w, http.StatusOK, versionedPromptResponse{Status: "duplicate", SessionID: sessionID, Receipt: receipt})
		return true
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "starting", "sessionId": sessionID})
	return true
}

// Bind the immutable request only after AcceptPrompt wins, before ACP invocation.
// Concurrent HTTP starts cannot overwrite the identity of the actual prompt owner.
func (s *Server) rememberSessionStartFingerprint(key, fingerprint string) {
	s.sessionHostMu.Lock()
	defer s.sessionHostMu.Unlock()
	profile := s.sessionProfileOvr[key]
	profile.StartFingerprint = fingerprint
	s.sessionProfileOvr[key] = profile
}
