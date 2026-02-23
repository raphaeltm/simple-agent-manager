// Package server provides WebSocket terminal handlers.
package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
	"github.com/workspace/vm-agent/internal/persistence"
)

func (s *Server) createUpgrader() websocket.Upgrader {
	return websocket.Upgrader{
		ReadBufferSize:  s.config.WSReadBufferSize,
		WriteBufferSize: s.config.WSWriteBufferSize,
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			if origin == "" {
				return true
			}
			return s.isOriginAllowed(origin)
		},
	}
}

func (s *Server) isOriginAllowed(origin string) bool {
	for _, allowed := range s.config.AllowedOrigins {
		if allowed == "*" || allowed == origin {
			return true
		}
		if strings.Contains(allowed, "*") && matchWildcardOrigin(origin, allowed) {
			return true
		}
	}
	return false
}

func matchWildcardOrigin(origin, pattern string) bool {
	parts := strings.SplitN(pattern, "*", 2)
	if len(parts) != 2 {
		return false
	}
	prefix := parts[0]
	suffix := parts[1]
	if !strings.HasPrefix(origin, prefix) || !strings.HasSuffix(origin, suffix) {
		return false
	}
	middle := origin[len(prefix) : len(origin)-len(suffix)]
	return !strings.Contains(middle, "/")
}

type wsMessage struct {
	Type      string          `json:"type"`
	SessionID string          `json:"sessionId,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
}

type wsInputData struct {
	Data string `json:"data"`
}

type wsResizeData struct {
	Rows int `json:"rows"`
	Cols int `json:"cols"`
}

type wsCreateSessionData struct {
	SessionID string `json:"sessionId"`
	Rows      int    `json:"rows"`
	Cols      int    `json:"cols"`
	Name      string `json:"name,omitempty"`
	WorkDir   string `json:"workDir,omitempty"`
}

type wsCloseSessionData struct {
	SessionID string `json:"sessionId"`
}

type wsRenameSessionData struct {
	SessionID string `json:"sessionId"`
	Name      string `json:"name"`
}

type wsReattachSessionData struct {
	SessionID string `json:"sessionId"`
	Rows      int    `json:"rows"`
	Cols      int    `json:"cols"`
}

type wsWriter struct {
	conn      *websocket.Conn
	writeMu   *sync.Mutex
	sessionID string
}

func (w *wsWriter) Write(p []byte) (int, error) {
	outputData, _ := json.Marshal(map[string]string{"data": string(p)})
	w.writeMu.Lock()
	err := w.conn.WriteJSON(wsMessage{
		Type:      "output",
		SessionID: w.sessionID,
		Data:      outputData,
	})
	w.writeMu.Unlock()
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

func (s *Server) authenticateWorkspaceWebsocket(w http.ResponseWriter, r *http.Request, workspaceID string) (string, bool) {
	session := s.sessionManager.GetSessionFromRequest(r)
	if session != nil {
		if session.Claims == nil {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return "", false
		}
		if session.Claims.Workspace != "" && session.Claims.Workspace != workspaceID {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return "", false
		}
		if session.Claims.Workspace == "" {
			session.Claims.Workspace = workspaceID
		}
		return session.UserID, true
	}

	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return "", false
	}

	claims, err := s.jwtValidator.ValidateWorkspaceToken(token, workspaceID)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return "", false
	}

	createdSession, err := s.sessionManager.CreateSession(claims)
	if err != nil {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return "", false
	}
	s.sessionManager.SetCookie(w, createdSession)
	return createdSession.UserID, true
}

func (s *Server) resolveWorkspaceIDForWebsocket(r *http.Request) string {
	workspaceID := strings.TrimSpace(s.routedWorkspaceID(r))
	if workspaceID == "" {
		if session := s.sessionManager.GetSessionFromRequest(r); session != nil && session.Claims != nil {
			workspaceID = strings.TrimSpace(session.Claims.Workspace)
		}
	}
	if workspaceID == "" {
		if token := strings.TrimSpace(r.URL.Query().Get("token")); token != "" {
			if claims, err := s.jwtValidator.Validate(token); err == nil {
				workspaceID = strings.TrimSpace(claims.Workspace)
			}
		}
	}
	if workspaceID == "" {
		workspaceID = strings.TrimSpace(s.config.WorkspaceID)
	}
	if workspaceID == "" {
		workspaceID = "default"
	}
	return workspaceID
}

func (s *Server) handleTerminalWS(w http.ResponseWriter, r *http.Request) {
	workspaceID := s.resolveWorkspaceIDForWebsocket(r)
	if workspaceID == "" {
		http.Error(w, "Missing workspace route", http.StatusBadRequest)
		return
	}

	userID, ok := s.authenticateWorkspaceWebsocket(w, r, workspaceID)
	if !ok {
		return
	}

	runtime := s.upsertWorkspaceRuntime(workspaceID, "", "", "running", "")

	upgrader := s.createUpgrader()
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("WebSocket upgrade failed", "error", err)
		return
	}
	defer conn.Close()

	rows := 24
	cols := 80
	if r.URL.Query().Get("rows") != "" {
		if err := json.Unmarshal([]byte(r.URL.Query().Get("rows")), &rows); err != nil {
			rows = 24
		}
	}
	if r.URL.Query().Get("cols") != "" {
		if err := json.Unmarshal([]byte(r.URL.Query().Get("cols")), &cols); err != nil {
			cols = 80
		}
	}

	ptySession, err := runtime.PTY.CreateSession(userID, rows, cols)
	if err != nil && isContainerUnavailableError(err) {
		slog.Warn("Terminal session create failed due to unavailable container, attempting recovery", "workspace", workspaceID, "error", err)
		if recoverErr := s.recoverWorkspaceRuntime(r.Context(), runtime); recoverErr != nil {
			slog.Error("Terminal recovery failed", "workspace", workspaceID, "error", recoverErr)
		} else {
			ptySession, err = runtime.PTY.CreateSession(userID, rows, cols)
		}
	}
	if err != nil {
		_ = conn.WriteJSON(wsMessage{Type: "error", Data: json.RawMessage(`"Failed to create terminal session"`)})
		return
	}
	defer runtime.PTY.CloseSession(ptySession.ID)

	s.idleDetector.RecordActivity()
	s.appendNodeEvent(workspaceID, "info", "terminal.session_open", "Terminal session opened", map[string]interface{}{"sessionId": ptySession.ID})

	sessionData, _ := json.Marshal(map[string]string{"sessionId": ptySession.ID})
	_ = conn.WriteJSON(wsMessage{Type: "session", Data: sessionData})

	var writeMu sync.Mutex
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 4096)
		for {
			n, err := ptySession.Read(buf)
			if err != nil {
				return
			}
			if n > 0 {
				outputData, _ := json.Marshal(map[string]string{"data": string(buf[:n])})
				writeMu.Lock()
				err = conn.WriteJSON(wsMessage{Type: "output", Data: outputData})
				writeMu.Unlock()
				if err != nil {
					return
				}
			}
		}
	}()

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var msg wsMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "input":
			var input wsInputData
			if err := json.Unmarshal(msg.Data, &input); err != nil {
				continue
			}
			s.idleDetector.RecordActivity()
			_, _ = ptySession.Write([]byte(input.Data))
		case "resize":
			var resize wsResizeData
			if err := json.Unmarshal(msg.Data, &resize); err != nil {
				continue
			}
			_ = ptySession.Resize(resize.Rows, resize.Cols)
		case "ping":
			writeMu.Lock()
			_ = conn.WriteJSON(wsMessage{Type: "pong"})
			writeMu.Unlock()
		}
	}

	<-done
}

func (s *Server) handleMultiTerminalWS(w http.ResponseWriter, r *http.Request) {
	workspaceID := s.resolveWorkspaceIDForWebsocket(r)
	if workspaceID == "" {
		http.Error(w, "Missing workspace route", http.StatusBadRequest)
		return
	}

	userID, ok := s.authenticateWorkspaceWebsocket(w, r, workspaceID)
	if !ok {
		return
	}

	runtime := s.upsertWorkspaceRuntime(workspaceID, "", "", "running", "")

	upgrader := s.createUpgrader()
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("WebSocket upgrade failed", "error", err)
		return
	}
	defer conn.Close()

	attachedSessions := make(map[string]struct{})
	var asMu sync.Mutex
	var writeMu sync.Mutex

	defer func() {
		asMu.Lock()
		ids := make([]string, 0, len(attachedSessions))
		for id := range attachedSessions {
			ids = append(ids, id)
		}
		asMu.Unlock()

		if len(ids) > 0 {
			for _, id := range ids {
				if sess := runtime.PTY.GetSession(id); sess != nil {
					sess.SetAttachedWriter(nil)
				}
			}
			runtime.PTY.OrphanSessions(ids)
		}
	}()

	attachWriter := func(sessionID string) {
		sess := runtime.PTY.GetSession(sessionID)
		if sess == nil {
			return
		}
		sess.SetAttachedWriter(&wsWriter{conn: conn, writeMu: &writeMu, sessionID: sessionID})
	}

	sendSessionError := func(sessionID, errMsg string) {
		errorData, _ := json.Marshal(map[string]string{"error": errMsg})
		writeMu.Lock()
		_ = conn.WriteJSON(wsMessage{Type: "error", SessionID: sessionID, Data: errorData})
		writeMu.Unlock()
	}

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var msg wsMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "list_sessions":
			activeSessions := runtime.PTY.GetActiveSessionsForUser(userID)
			sessionInfos := make([]SessionInfo, len(activeSessions))
			for i, si := range activeSessions {
				sessionInfos[i] = SessionInfo{
					SessionID:        si.ID,
					Name:             si.Name,
					Status:           si.Status,
					WorkingDirectory: si.WorkingDirectory,
					CreatedAt:        si.CreatedAt,
					LastActivityAt:   si.LastActivityAt,
				}
			}
			writeMu.Lock()
			_ = conn.WriteMessage(websocket.TextMessage, NewSessionListMessage(sessionInfos))
			writeMu.Unlock()

		case "reattach_session":
			var data wsReattachSessionData
			if err := json.Unmarshal(msg.Data, &data); err != nil {
				continue
			}

			existing := runtime.PTY.GetSession(data.SessionID)
			if existing == nil {
				sendSessionError(data.SessionID, "session not found")
				continue
			}
			if existing.UserID != userID {
				sendSessionError(data.SessionID, "not authorized")
				continue
			}

			ptySession, err := runtime.PTY.ReattachSession(data.SessionID)
			if err != nil {
				sendSessionError(data.SessionID, err.Error())
				continue
			}
			if data.Rows > 0 && data.Cols > 0 {
				_ = ptySession.Resize(data.Rows, data.Cols)
			}

			asMu.Lock()
			attachedSessions[data.SessionID] = struct{}{}
			asMu.Unlock()

			dir := ""
			if ptySession.Cmd != nil {
				dir = ptySession.Cmd.Dir
			}
			writeMu.Lock()
			_ = conn.WriteMessage(websocket.TextMessage, NewSessionReattachedMessage(data.SessionID, dir, ""))
			writeMu.Unlock()

			scrollback := ptySession.OutputBuffer.ReadAll()
			if len(scrollback) > 0 {
				writeMu.Lock()
				_ = conn.WriteMessage(websocket.TextMessage, NewScrollbackMessage(data.SessionID, string(scrollback)))
				writeMu.Unlock()
			}
			attachWriter(data.SessionID)

		case "create_session":
			var data wsCreateSessionData
			if err := json.Unmarshal(msg.Data, &data); err != nil {
				continue
			}
			requestedWorkDir := strings.TrimSpace(data.WorkDir)
			if requestedWorkDir != "" {
				containerID, defaultWorkDir, user, resolveErr := s.resolveContainerForWorkspace(workspaceID)
				if resolveErr != nil {
					sendSessionError(data.SessionID, resolveErr.Error())
					continue
				}
				effectiveWorkDir, resolveErr := s.resolveExplicitWorktreeWorkDir(r.Context(), workspaceID, containerID, user, defaultWorkDir, requestedWorkDir)
				if resolveErr != nil {
					sendSessionError(data.SessionID, resolveErr.Error())
					continue
				}
				requestedWorkDir = effectiveWorkDir
			}

			ptySession, err := runtime.PTY.CreateSessionWithID(data.SessionID, userID, data.Rows, data.Cols, requestedWorkDir)
			if err != nil && isContainerUnavailableError(err) {
				slog.Warn("Multi-terminal session create failed due to unavailable container, attempting recovery", "workspace", workspaceID, "error", err)
				if recoverErr := s.recoverWorkspaceRuntime(r.Context(), runtime); recoverErr != nil {
					slog.Error("Multi-terminal recovery failed", "workspace", workspaceID, "error", recoverErr)
				} else {
					ptySession, err = runtime.PTY.CreateSessionWithID(data.SessionID, userID, data.Rows, data.Cols, requestedWorkDir)
				}
			}
			if err != nil {
				sendSessionError(data.SessionID, err.Error())
				continue
			}
			if data.Name != "" {
				_ = runtime.PTY.SetSessionName(data.SessionID, data.Name)
			}

			// Persist terminal tab for cross-device continuity
			label := data.Name
			if label == "" {
				label = "Terminal"
			}
			if s.store != nil {
				tabCount, _ := s.store.TabCount(workspaceID)
				if err := s.store.InsertTab(persistence.Tab{
					ID:          data.SessionID,
					WorkspaceID: workspaceID,
					Type:        "terminal",
					Label:       label,
					SortOrder:   tabCount,
				}); err != nil {
					slog.Warn("Failed to persist terminal tab", "error", err)
				}
			}

			asMu.Lock()
			attachedSessions[data.SessionID] = struct{}{}
			asMu.Unlock()

			attachWriter(data.SessionID)

			ptySession.StartOutputReader(
				func(sessionID string, payload []byte) {
					sess := runtime.PTY.GetSession(sessionID)
					if sess == nil {
						return
					}
					writer := sess.GetAttachedWriter()
					if writer != nil {
						_, _ = writer.Write(payload)
					}
				},
				func(sessionID string) {},
			)

			createdData, _ := json.Marshal(map[string]interface{}{
				"sessionId":        data.SessionID,
				"workingDirectory": ptySession.Cmd.Dir,
			})
			writeMu.Lock()
			_ = conn.WriteJSON(wsMessage{Type: "session_created", SessionID: data.SessionID, Data: createdData})
			writeMu.Unlock()

		case "close_session":
			var data wsCloseSessionData
			if err := json.Unmarshal(msg.Data, &data); err != nil {
				continue
			}

			ptySession := runtime.PTY.GetSession(data.SessionID)
			if ptySession == nil {
				sendSessionError(data.SessionID, "session not found")
				continue
			}
			if ptySession.UserID != userID {
				sendSessionError(data.SessionID, "not authorized")
				continue
			}

			asMu.Lock()
			delete(attachedSessions, data.SessionID)
			asMu.Unlock()

			if err := runtime.PTY.CloseSession(data.SessionID); err != nil {
				sendSessionError(data.SessionID, err.Error())
				continue
			}

			// Remove persisted terminal tab
			if s.store != nil {
				if err := s.store.DeleteTab(data.SessionID); err != nil {
					slog.Warn("Failed to delete persisted terminal tab", "error", err)
				}
			}

			closedData, _ := json.Marshal(map[string]interface{}{"sessionId": data.SessionID, "reason": "user_requested"})
			writeMu.Lock()
			_ = conn.WriteJSON(wsMessage{Type: "session_closed", SessionID: data.SessionID, Data: closedData})
			writeMu.Unlock()

		case "input":
			sessionID := msg.SessionID
			if sessionID == "" {
				asMu.Lock()
				for id := range attachedSessions {
					sessionID = id
					break
				}
				asMu.Unlock()
			}

			var input wsInputData
			if err := json.Unmarshal(msg.Data, &input); err != nil {
				continue
			}

			ptySession := runtime.PTY.GetSession(sessionID)
			if ptySession != nil {
				if ptySession.UserID != userID {
					sendSessionError(sessionID, "not authorized")
					continue
				}
				s.idleDetector.RecordActivity()
				_, _ = ptySession.Write([]byte(input.Data))
			}

		case "resize":
			sessionID := msg.SessionID
			if sessionID == "" {
				asMu.Lock()
				for id := range attachedSessions {
					sessionID = id
					break
				}
				asMu.Unlock()
			}

			var resize wsResizeData
			if err := json.Unmarshal(msg.Data, &resize); err != nil {
				continue
			}

			ptySession := runtime.PTY.GetSession(sessionID)
			if ptySession != nil {
				if ptySession.UserID != userID {
					sendSessionError(sessionID, "not authorized")
					continue
				}
				_ = ptySession.Resize(resize.Rows, resize.Cols)
			}

		case "rename_session":
			var data wsRenameSessionData
			if err := json.Unmarshal(msg.Data, &data); err != nil {
				continue
			}
			ptySession := runtime.PTY.GetSession(data.SessionID)
			if ptySession == nil {
				sendSessionError(data.SessionID, "session not found")
				continue
			}
			if ptySession.UserID != userID {
				sendSessionError(data.SessionID, "not authorized")
				continue
			}
			if err := runtime.PTY.SetSessionName(data.SessionID, data.Name); err != nil {
				sendSessionError(data.SessionID, err.Error())
				continue
			}

			renamedData, _ := json.Marshal(map[string]interface{}{"sessionId": data.SessionID, "name": data.Name})
			writeMu.Lock()
			_ = conn.WriteJSON(wsMessage{Type: "session_renamed", SessionID: data.SessionID, Data: renamedData})
			writeMu.Unlock()

		case "ping":
			writeMu.Lock()
			_ = conn.WriteJSON(wsMessage{Type: "pong", SessionID: msg.SessionID})
			writeMu.Unlock()
		}
	}
}
