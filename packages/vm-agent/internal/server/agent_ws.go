package server

import (
	"context"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
)

func parseTakeoverParam(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func writeSessionError(w http.ResponseWriter, statusCode int, code, message string) {
	writeJSON(w, statusCode, map[string]string{
		"error":   code,
		"message": message,
	})
}

// handleAgentWS handles WebSocket connections for ACP agent communication.
// Supports optional sessionId query for deterministic attach/takeover semantics.
func (s *Server) handleAgentWS(w http.ResponseWriter, r *http.Request) {
	workspaceID := s.resolveWorkspaceIDForWebsocket(r)
	if workspaceID == "" {
		writeSessionError(w, http.StatusBadRequest, "workspace_required", "Missing workspace route")
		return
	}

	_, ok := s.authenticateWorkspaceWebsocket(w, r, workspaceID)
	if !ok {
		return
	}

	runtime := s.upsertWorkspaceRuntime(workspaceID, "", "", "running", "")

	requestedSessionID := strings.TrimSpace(r.URL.Query().Get("sessionId"))
	idempotencyKey := strings.TrimSpace(r.URL.Query().Get("idempotencyKey"))
	takeover := parseTakeoverParam(r.URL.Query().Get("takeover"))
	autoCreateSession := requestedSessionID == ""

	if autoCreateSession {
		requestedSessionID = "session-" + randomEventID()
	}

	session, exists := s.agentSessions.Get(workspaceID, requestedSessionID)
	if !exists {
		created, _, err := s.agentSessions.Create(workspaceID, requestedSessionID, "", idempotencyKey)
		if err != nil {
			writeSessionError(w, http.StatusConflict, "session_create_failed", err.Error())
			return
		}
		session = created

		// Hydrate AcpSessionID from SQLite persistence if available.
		// The in-memory manager starts empty, but SQLite may have the
		// AcpSessionID from a previous connection (persisted by the gateway).
		if s.store != nil {
			if tabs, tabErr := s.store.ListTabs(workspaceID); tabErr == nil {
				for _, tab := range tabs {
					if tab.ID == requestedSessionID && tab.AcpSessionID != "" {
						session.AcpSessionID = tab.AcpSessionID
						session.AgentType = tab.AgentID
						_ = s.agentSessions.UpdateAcpSessionID(workspaceID, requestedSessionID, tab.AcpSessionID, tab.AgentID)
						log.Printf("Workspace %s: hydrated AcpSessionID=%s agentType=%s from SQLite for session %s",
							workspaceID, tab.AcpSessionID, tab.AgentID, requestedSessionID)
						break
					}
				}
			}
		}

		if autoCreateSession {
			s.appendNodeEvent(workspaceID, "info", "agent.session_created", "Agent session created for websocket attach", map[string]interface{}{
				"sessionId": requestedSessionID,
			})
		} else {
			s.appendNodeEvent(workspaceID, "warn", "agent.session_recovered", "Agent session was missing on node and has been recreated", map[string]interface{}{
				"sessionId": requestedSessionID,
			})
		}
	}

	if session.Status != agentsessions.StatusRunning {
		writeSessionError(w, http.StatusConflict, "session_not_running", "Requested session is not running")
		return
	}

	upgrader := s.createUpgrader()
	gatewayKey := workspaceID + ":" + requestedSessionID

	s.acpMu.Lock()
	if existing := s.acpGateways[gatewayKey]; existing != nil {
		if !takeover {
			s.acpMu.Unlock()
			writeSessionError(w, http.StatusConflict, "session_already_attached", "Session already has an active interactive attachment")
			return
		}
		existing.Close()
		delete(s.acpGateways, gatewayKey)
	}
	s.acpMu.Unlock()

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ACP WebSocket upgrade failed: %v", err)
		return
	}

	// Deterministic attach/stop race handling:
	// If stop wins before websocket attach completes, close with session_not_running.
	postUpgradeSession, postUpgradeExists := s.agentSessions.Get(workspaceID, requestedSessionID)
	if !postUpgradeExists || postUpgradeSession.Status != agentsessions.StatusRunning {
		_ = conn.WriteJSON(map[string]string{
			"error":   "session_not_running",
			"message": "Requested session is not running",
		})
		_ = conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "session_not_running"),
			time.Now().Add(5*time.Second),
		)
		_ = conn.Close()
		return
	}

	gatewayCfg := s.acpConfig
	gatewayCfg.WorkspaceID = workspaceID
	gatewayCfg.SessionID = requestedSessionID
	gatewayCfg.SessionManager = s.agentSessions
	gatewayCfg.TabStore = s.store
	// Pass previous ACP session ID and agent type for LoadSession on reconnection
	if session.AcpSessionID != "" {
		gatewayCfg.PreviousAcpSessionID = session.AcpSessionID
		gatewayCfg.PreviousAgentType = session.AgentType
		log.Printf("Workspace %s: passing previous ACP session ID %s (agentType=%s) for potential LoadSession", workspaceID, session.AcpSessionID, session.AgentType)
	}
	if callbackToken := s.callbackTokenForWorkspace(workspaceID); callbackToken != "" {
		gatewayCfg.CallbackToken = callbackToken
	}
	if runtime != nil {
		if resolver := s.ptyManagerContainerResolverForLabel(runtime.ContainerLabelValue); resolver != nil {
			if _, resolveErr := resolver(); isContainerUnavailableError(resolveErr) {
				log.Printf("Workspace %s: ACP attach detected unavailable container, attempting recovery: %v", workspaceID, resolveErr)
				if recoverErr := s.recoverWorkspaceRuntime(r.Context(), runtime); recoverErr != nil {
					log.Printf("Workspace %s: ACP recovery failed: %v", workspaceID, recoverErr)
				}
			}
		}

		if workDir := strings.TrimSpace(runtime.ContainerWorkDir); workDir != "" {
			gatewayCfg.ContainerWorkDir = workDir
		}
		if resolver := s.ptyManagerContainerResolverForLabel(runtime.ContainerLabelValue); resolver != nil {
			gatewayCfg.ContainerResolver = resolver
		}
	}
	gateway := acp.NewGateway(gatewayCfg, conn)

	s.acpMu.Lock()
	if existing := s.acpGateways[gatewayKey]; existing != nil {
		if !takeover {
			s.acpMu.Unlock()
			_ = conn.WriteJSON(map[string]string{
				"error":   "session_already_attached",
				"message": "Session already has an active interactive attachment",
			})
			_ = conn.Close()
			return
		}
		existing.Close()
		delete(s.acpGateways, gatewayKey)
	}
	s.acpGateways[gatewayKey] = gateway
	s.acpMu.Unlock()

	s.appendNodeEvent(workspaceID, "info", "agent.attach", "Agent session attached", map[string]interface{}{
		"sessionId": requestedSessionID,
		"takeover":  takeover,
	})

	gateway.Run(context.Background())

	s.acpMu.Lock()
	if s.acpGateways[gatewayKey] == gateway {
		delete(s.acpGateways, gatewayKey)
	}
	s.acpMu.Unlock()
}
