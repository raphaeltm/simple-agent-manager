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

// serverEventAppender adapts the Server's appendNodeEvent method to the
// acp.EventAppender interface so the SessionHost can emit workspace events.
type serverEventAppender struct {
	server *Server
}

func (a *serverEventAppender) AppendEvent(workspaceID, level, eventType, message string, detail map[string]interface{}) {
	a.server.appendNodeEvent(workspaceID, level, eventType, message, detail)
}

func writeSessionError(w http.ResponseWriter, statusCode int, code, message string) {
	writeJSON(w, statusCode, map[string]string{
		"error":   code,
		"message": message,
	})
}

// handleAgentWS handles WebSocket connections for ACP agent communication.
// Multiple viewers can connect to the same session simultaneously.
// The agent process lives in a SessionHost which persists independently of
// any browser connection — it is only stopped via an explicit Stop API call.
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
	autoCreateSession := requestedSessionID == ""

	if autoCreateSession {
		requestedSessionID = "session-" + randomEventID()
	}

	session, exists := s.agentSessions.Get(workspaceID, requestedSessionID)
	if !exists {
		worktreePath := strings.TrimSpace(r.URL.Query().Get("worktree"))
		created, _, err := s.agentSessions.Create(workspaceID, requestedSessionID, "", idempotencyKey, worktreePath)
		if err != nil {
			writeSessionError(w, http.StatusConflict, "session_create_failed", err.Error())
			return
		}
		session = created

		// Hydrate AcpSessionID from SQLite persistence if available.
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

	// Get or create SessionHost for this session.
	// The SessionHost persists independently of any WebSocket connection.
	hostKey := workspaceID + ":" + requestedSessionID
	host := s.getOrCreateSessionHost(hostKey, workspaceID, requestedSessionID, session, runtime)

	upgrader := s.createUpgrader()
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ACP WebSocket upgrade failed: %v", err)
		return
	}

	// Post-upgrade race check: if session was stopped between request and upgrade
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

	// Attach as a viewer — multiple viewers can connect simultaneously.
	// The SessionHost replays all buffered messages to the new viewer.
	viewerID := "viewer-" + randomEventID()
	viewer := host.AttachViewer(viewerID, conn)
	if viewer == nil {
		// Session was stopped between getOrCreate and attach
		_ = conn.WriteJSON(map[string]string{
			"error":   "session_not_running",
			"message": "Session was stopped",
		})
		_ = conn.Close()
		return
	}

	// Create thin Gateway relay (reads WebSocket messages, routes to SessionHost)
	gateway := acp.NewGateway(host, conn, viewerID)

	s.appendNodeEvent(workspaceID, "info", "agent.websocket_connected", "Agent WebSocket connected", map[string]interface{}{
		"sessionId":          requestedSessionID,
		"viewerId":           viewerID,
		"viewerCount":        host.ViewerCount(),
		"hasPreviousSession": session.AcpSessionID != "",
		"previousAcpSession": session.AcpSessionID,
		"previousAgentType":  session.AgentType,
	})

	// Run the gateway read loop (blocks until WebSocket closes)
	gateway.Run(context.Background())

	// Detach the viewer — agent continues running in the SessionHost
	host.DetachViewer(viewerID)

	s.appendNodeEvent(workspaceID, "info", "agent.websocket_disconnected", "Agent WebSocket disconnected", map[string]interface{}{
		"sessionId":   requestedSessionID,
		"viewerId":    viewerID,
		"viewerCount": host.ViewerCount(),
	})
}

// getOrCreateSessionHost returns an existing SessionHost or creates a new one.
func (s *Server) getOrCreateSessionHost(hostKey, workspaceID, sessionID string, session agentsessions.Session, runtime *WorkspaceRuntime) *acp.SessionHost {
	s.sessionHostMu.Lock()
	defer s.sessionHostMu.Unlock()

	if host, ok := s.sessionHosts[hostKey]; ok {
		return host
	}

	cfg := s.acpConfig
	cfg.WorkspaceID = workspaceID
	cfg.SessionID = sessionID
	cfg.SessionManager = s.agentSessions
	cfg.TabStore = s.store
	cfg.EventAppender = &serverEventAppender{server: s}

	if session.AcpSessionID != "" {
		cfg.PreviousAcpSessionID = session.AcpSessionID
		cfg.PreviousAgentType = session.AgentType
		log.Printf("Workspace %s: SessionHost created with previous ACP session ID %s (agentType=%s)",
			workspaceID, session.AcpSessionID, session.AgentType)
	}
	if callbackToken := s.callbackTokenForWorkspace(workspaceID); callbackToken != "" {
		cfg.CallbackToken = callbackToken
	}
	if runtime != nil {
		if resolver := s.ptyManagerContainerResolverForLabel(runtime.ContainerLabelValue); resolver != nil {
			if _, resolveErr := resolver(); isContainerUnavailableError(resolveErr) {
				log.Printf("Workspace %s: SessionHost detected unavailable container, attempting recovery: %v", workspaceID, resolveErr)
				if recoverErr := s.recoverWorkspaceRuntime(context.Background(), runtime); recoverErr != nil {
					log.Printf("Workspace %s: SessionHost recovery failed: %v", workspaceID, recoverErr)
				}
			}
		}
		if workDir := strings.TrimSpace(runtime.ContainerWorkDir); workDir != "" {
			cfg.ContainerWorkDir = workDir
		}
		if resolver := s.ptyManagerContainerResolverForLabel(runtime.ContainerLabelValue); resolver != nil {
			cfg.ContainerResolver = resolver
		}
	}

	hostCfg := acp.SessionHostConfig{
		GatewayConfig:     cfg,
		MessageBufferSize: s.config.ACPMessageBufferSize,
		ViewerSendBuffer:  s.config.ACPViewerSendBuffer,
	}
	host := acp.NewSessionHost(hostCfg)
	s.sessionHosts[hostKey] = host

	log.Printf("Workspace %s: SessionHost created for session %s", workspaceID, sessionID)
	return host
}
