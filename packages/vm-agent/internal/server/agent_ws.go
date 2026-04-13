package server

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/config"
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
		created, _, err := s.agentSessions.Create(workspaceID, requestedSessionID, "", idempotencyKey)
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
						if updateErr := s.agentSessions.UpdateAcpSessionID(workspaceID, requestedSessionID, tab.AcpSessionID, tab.AgentID); updateErr != nil {
							slog.Error("Failed to hydrate AcpSessionID in session manager", "workspace", workspaceID, "sessionId", requestedSessionID, "error", updateErr)
						}
						slog.Info("Hydrated AcpSessionID from SQLite",
							"workspace", workspaceID, "acpSessionId", tab.AcpSessionID, "agentType", tab.AgentID, "sessionId", requestedSessionID)
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

	// Auto-resume suspended sessions on WebSocket attach. This handles the case
	// where the control plane's resumeAgentSessionOnNode() call failed (best-effort)
	// but the browser is now trying to connect via WebSocket.
	if session.Status == agentsessions.StatusSuspended {
		resumed, resumeErr := s.agentSessions.Resume(workspaceID, requestedSessionID)
		if resumeErr != nil {
			// A concurrent WebSocket may have already resumed. Re-read and continue
			// if the session is now running.
			refreshed, exists := s.agentSessions.Get(workspaceID, requestedSessionID)
			if exists && refreshed.Status == agentsessions.StatusRunning {
				session = refreshed
				slog.Info("Session already resumed by concurrent connection", "workspace", workspaceID, "session", requestedSessionID)
			} else {
				slog.Warn("Auto-resume on WebSocket attach failed", "workspace", workspaceID, "session", requestedSessionID, "error", resumeErr)
				writeSessionError(w, http.StatusConflict, "session_not_running", "Requested session is suspended and could not be resumed")
				return
			}
		} else {
			session = resumed
			slog.Info("Auto-resumed suspended session on WebSocket attach", "workspace", workspaceID, "session", requestedSessionID)
		}
	}

	if session.Status != agentsessions.StatusRunning {
		writeSessionError(w, http.StatusConflict, "session_not_running", "Requested session is not running")
		return
	}

	// Get or create SessionHost for this session.
	// The SessionHost persists independently of any WebSocket connection.
	hostKey := workspaceID + ":" + requestedSessionID
	requestedWorktree := strings.TrimSpace(r.URL.Query().Get("worktree"))
	host := s.getOrCreateSessionHost(hostKey, workspaceID, requestedSessionID, session, runtime, requestedWorktree)

	upgrader := s.createUpgrader()
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("ACP WebSocket upgrade failed", "error", err)
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
	gateway := acp.NewGateway(host, conn, viewerID, viewer.Done())

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
func (s *Server) getOrCreateSessionHost(hostKey, workspaceID, sessionID string, session agentsessions.Session, runtime *WorkspaceRuntime, requestedWorktree string) *acp.SessionHost {
	// Fast path: check if host already exists.
	s.sessionHostMu.Lock()
	if host, ok := s.sessionHosts[hostKey]; ok {
		s.sessionHostMu.Unlock()
		return host
	}
	s.sessionHostMu.Unlock()

	// Pre-fetch MCP servers from SQLite outside the lock to avoid holding
	// sessionHostMu during I/O (Go specialist review finding).
	var prefetchedMcpServers []acp.McpServerEntry
	if s.store != nil {
		if persisted, err := s.store.GetSessionMcpServers(workspaceID, sessionID); err == nil && len(persisted) > 0 {
			prefetchedMcpServers = make([]acp.McpServerEntry, len(persisted))
			for i, p := range persisted {
				prefetchedMcpServers[i] = acp.McpServerEntry{URL: p.URL, Token: p.Token}
			}
		} else if err != nil {
			slog.Warn("Failed to read MCP servers from SQLite",
				"workspace", workspaceID, "sessionId", sessionID, "error", err)
		}
	}

	s.sessionHostMu.Lock()
	defer s.sessionHostMu.Unlock()

	// Re-check after re-acquiring lock (double-checked locking).
	if host, ok := s.sessionHosts[hostKey]; ok {
		return host
	}

	cfg := s.acpConfig
	cfg.WorkspaceID = workspaceID
	cfg.SessionID = sessionID

	// Override GitTokenFetcher per-session so it targets the correct workspace's
	// git-token endpoint. The callback token is resolved at call time via
	// callbackTokenForWorkspace(), so token rotations are automatically picked up.
	// Without this override, the server-level default (nil) would leave GH_TOKEN
	// unset; the previous bug had a server-level s.fetchGitToken that silently
	// used s.config.WorkspaceID (the node-level ID) instead.
	cfg.GitTokenFetcher = func(ctx context.Context) (string, error) {
		return s.fetchGitTokenForWorkspace(ctx, workspaceID, "")
	}

	// Use per-workspace message reporter to prevent cross-workspace contamination.
	// Lock ordering: sessionHostMu → messageReportersMu → Reporter.mu
	// and: callbackTokenMu → messageReportersMu → Reporter.mu
	// Never acquire sessionHostMu while holding messageReportersMu.
	s.messageReportersMu.Lock()
	if r, ok := s.messageReporters[workspaceID]; ok {
		cfg.MessageReporter = &messageReporterAdapter{r: r}
	}
	s.messageReportersMu.Unlock()
	cfg.SessionManager = s.agentSessions
	cfg.TabStore = s.store
	cfg.TabLastPromptStore = s.store
	cfg.SessionLastPromptManager = s.agentSessions
	cfg.EventAppender = &serverEventAppender{server: s}
	cfg.CredentialSyncer = s
	// Conversation-mode sessions should NOT be auto-suspended when the viewer
	// disconnects. The 2-hour workspace idle timeout is the only kill mechanism.
	// Task-mode sessions keep the default 30-min auto-suspend.
	if s.config.TaskMode == config.TaskModeConversation {
		cfg.IdleSuspendTimeout = 0
	} else {
		cfg.IdleSuspendTimeout = s.config.ACPIdleSuspendTimeout
	}
	cfg.OnSuspend = func(wsID, sessID string) {
		s.handleAutoSuspend(wsID, sessID)
	}

	if session.AcpSessionID != "" {
		cfg.PreviousAcpSessionID = session.AcpSessionID
		cfg.PreviousAgentType = session.AgentType
		slog.Info("SessionHost created with previous ACP session ID",
			"workspace", workspaceID, "acpSessionId", session.AcpSessionID, "agentType", session.AgentType)
	}
	if callbackToken := s.callbackTokenForWorkspace(workspaceID); callbackToken != "" {
		cfg.CallbackToken = callbackToken
	}
	if runtime != nil {
		if resolver := s.ptyManagerContainerResolverForLabel(runtime.ContainerLabelValue); resolver != nil {
			if _, resolveErr := resolver(); isContainerUnavailableError(resolveErr) {
				slog.Warn("SessionHost detected unavailable container, attempting recovery", "workspace", workspaceID, "error", resolveErr)
				if recoverErr := s.recoverWorkspaceRuntime(context.Background(), runtime); recoverErr != nil {
					slog.Error("SessionHost recovery failed", "workspace", workspaceID, "error", recoverErr)
				}
			}
		}
		if workDir := strings.TrimSpace(runtime.ContainerWorkDir); workDir != "" {
			cfg.ContainerWorkDir = workDir
		}
		if user := strings.TrimSpace(runtime.ContainerUser); user != "" {
			cfg.ContainerUser = user
		}
		if requestedWorktree != "" {
			containerID, defaultWorkDir, user, resolveErr := s.resolveContainerForWorkspace(workspaceID)
			if resolveErr == nil {
				if effectiveWorkDir, err := s.resolveExplicitWorktreeWorkDir(context.Background(), workspaceID, containerID, user, defaultWorkDir, requestedWorktree); err == nil {
					cfg.ContainerWorkDir = effectiveWorkDir
				}
			}
		}
		if resolver := s.ptyManagerContainerResolverForLabel(runtime.ContainerLabelValue); resolver != nil {
			cfg.ContainerResolver = resolver
		}
	}

	// Inject per-session MCP servers. Check in-memory map first (fast path),
	// then use pre-fetched SQLite data (survives VM agent restart / race conditions).
	if mcpServers, ok := s.sessionMcpServers[hostKey]; ok && len(mcpServers) > 0 {
		cfg.McpServers = mcpServers
	} else if len(prefetchedMcpServers) > 0 {
		cfg.McpServers = prefetchedMcpServers
		// Backfill in-memory map so subsequent lookups are fast
		s.sessionMcpServers[hostKey] = prefetchedMcpServers
		slog.Info("MCP servers recovered from SQLite",
			"workspace", workspaceID, "sessionId", sessionID, "count", len(prefetchedMcpServers))
	}

	// Inject per-session profile overrides (model/permissionMode/opencode from agent profiles).
	if ovr, ok := s.sessionProfileOvr[hostKey]; ok {
		cfg.ModelOverride = ovr.Model
		cfg.PermissionModeOverride = ovr.PermissionMode
		cfg.OpencodeProviderOverride = ovr.OpencodeProvider
		cfg.OpencodeBaseUrlOverride = ovr.OpencodeBaseUrl
	}

	hostCfg := acp.SessionHostConfig{
		GatewayConfig:         cfg,
		MessageBufferSize:     s.config.ACPMessageBufferSize,
		ViewerSendBuffer:      s.config.ACPViewerSendBuffer,
		NotifSerializeTimeout: s.config.ACPNotifSerializeTimeout,
	}
	host := acp.NewSessionHost(hostCfg)
	s.sessionHosts[hostKey] = host

	slog.Info("SessionHost created", "workspace", workspaceID, "sessionId", sessionID,
		"mcpServers", len(cfg.McpServers),
		"modelOverride", cfg.ModelOverride, "permissionModeOverride", cfg.PermissionModeOverride)
	return host
}
