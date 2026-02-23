package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/workspace/vm-agent/internal/logreader"
)

// handleLogs serves GET /logs — retrieves log entries with filtering and pagination.
func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	if !s.requireNodeEventAuth(w, r) {
		return
	}

	filter := parseLogFilter(r)

	if err := logreader.ValidateFilter(filter); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	resp, err := s.logReader.ReadLogs(r.Context(), filter)
	if err != nil {
		slog.Error("Failed to read logs", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to read logs")
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

// handleLogStream serves GET /logs/stream — real-time log streaming via WebSocket.
func (s *Server) handleLogStream(w http.ResponseWriter, r *http.Request) {
	if !s.requireNodeEventAuth(w, r) {
		return
	}

	filter := parseLogFilter(r)

	if err := logreader.ValidateFilter(filter); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	upgrader := websocket.Upgrader{
		ReadBufferSize:  s.config.WSReadBufferSize,
		WriteBufferSize: s.config.WSWriteBufferSize,
		CheckOrigin: func(r *http.Request) bool {
			return true // Auth is handled by requireNodeEventAuth
		},
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("WebSocket upgrade failed for log stream", "error", err)
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Start ping/pong for keepalive - configurable per constitution principle XI
	pingInterval := s.config.LogStreamPingInterval
	pongTimeout := s.config.LogStreamPongTimeout

	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongTimeout))
	})
	_ = conn.SetReadDeadline(time.Now().Add(pongTimeout))

	// Read pump — detect client disconnect
	go func() {
		defer cancel()
		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				return
			}
		}
	}()

	// Ping ticker
	pingTicker := time.NewTicker(pingInterval)
	defer pingTicker.Stop()

	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-pingTicker.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)); err != nil {
					cancel()
					return
				}
			}
		}
	}()

	// Stream with catch-up
	catchUpCount := 0
	send := func(entry logreader.LogEntry) error {
		msg := logStreamMessage{
			Type:  "log",
			Entry: &entry,
		}
		return conn.WriteJSON(msg)
	}

	// Use StreamLogs which handles catch-up + follow
	err = s.logReader.StreamLogs(ctx, filter, func(entry logreader.LogEntry) error {
		catchUpCount++
		return send(entry)
	})

	if err != nil && ctx.Err() == nil {
		// Send error to client
		errMsg := logStreamMessage{
			Type:    "error",
			Message: "log stream interrupted",
		}
		_ = conn.WriteJSON(errMsg)
	}

	_ = catchUpCount // used for debug logging if needed
}

// logStreamMessage is a WebSocket message sent to clients.
type logStreamMessage struct {
	Type    string              `json:"type"`
	Entry   *logreader.LogEntry `json:"entry,omitempty"`
	Message string              `json:"message,omitempty"`
	Count   int                 `json:"count,omitempty"`
}

// parseLogFilter extracts LogFilter from query parameters.
func parseLogFilter(r *http.Request) logreader.LogFilter {
	q := r.URL.Query()
	filter := logreader.LogFilter{
		Source:    strings.ToLower(q.Get("source")),
		Level:     strings.ToLower(q.Get("level")),
		Container: q.Get("container"),
		Since:     q.Get("since"),
		Until:     q.Get("until"),
		Search:    q.Get("search"),
		Cursor:    q.Get("cursor"),
	}

	if filter.Source == "" {
		filter.Source = "all"
	}
	if filter.Level == "" {
		filter.Level = "info"
	}

	if limitStr := q.Get("limit"); limitStr != "" {
		if limit, err := strconv.Atoi(limitStr); err == nil {
			filter.Limit = limit
		}
	}

	return filter
}

// writeLogJSON is a helper for writing JSON with the correct content type.
// Uses the standard writeJSON from routes.go.
func writeLogJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}
