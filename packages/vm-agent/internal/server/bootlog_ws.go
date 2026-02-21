package server

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const bootLogMaxBuffered = 200

// BootLogWSEntry is the JSON structure sent to WebSocket clients.
type BootLogWSEntry struct {
	Type      string `json:"type"`
	Step      string `json:"step,omitempty"`
	Status    string `json:"status,omitempty"`
	Message   string `json:"message,omitempty"`
	Detail    string `json:"detail,omitempty"`
	Timestamp string `json:"timestamp,omitempty"`
}

// BootLogBroadcaster manages a ring buffer of boot log entries and fans out
// new entries to connected WebSocket clients in real time.
type BootLogBroadcaster struct {
	mu       sync.RWMutex
	entries  []BootLogWSEntry
	clients  map[*websocket.Conn]struct{}
	complete bool
}

// NewBootLogBroadcaster creates a new broadcaster.
func NewBootLogBroadcaster() *BootLogBroadcaster {
	return &BootLogBroadcaster{
		entries: make([]BootLogWSEntry, 0, 64),
		clients: make(map[*websocket.Conn]struct{}),
	}
}

// Broadcast appends a log entry to the buffer and sends it to all connected clients.
// Implements the bootlog.Broadcaster interface.
func (b *BootLogBroadcaster) Broadcast(step, status, message string, detail ...string) {
	entry := BootLogWSEntry{
		Type:      "log",
		Step:      step,
		Status:    status,
		Message:   message,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
	if len(detail) > 0 && detail[0] != "" {
		entry.Detail = detail[0]
	}

	b.mu.Lock()
	// Ring buffer: drop oldest if at capacity.
	if len(b.entries) >= bootLogMaxBuffered {
		b.entries = b.entries[1:]
	}
	b.entries = append(b.entries, entry)

	// Send to all connected clients.
	data, err := json.Marshal(entry)
	if err != nil {
		b.mu.Unlock()
		return
	}
	for conn := range b.clients {
		if writeErr := conn.WriteMessage(websocket.TextMessage, data); writeErr != nil {
			log.Printf("bootlog-ws: write error, removing client: %v", writeErr)
			conn.Close()
			delete(b.clients, conn)
		}
	}
	b.mu.Unlock()
}

// AddClient registers a WebSocket connection and sends all buffered entries as catch-up.
func (b *BootLogBroadcaster) AddClient(conn *websocket.Conn) {
	b.mu.Lock()
	defer b.mu.Unlock()

	// Send buffered history.
	for _, entry := range b.entries {
		data, err := json.Marshal(entry)
		if err != nil {
			continue
		}
		if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
			log.Printf("bootlog-ws: failed to send history to new client: %v", err)
			conn.Close()
			return
		}
	}

	// If bootstrap already completed, send the complete event and close.
	if b.complete {
		completeMsg, _ := json.Marshal(BootLogWSEntry{Type: "complete"})
		conn.WriteMessage(websocket.TextMessage, completeMsg)
		conn.Close()
		return
	}

	b.clients[conn] = struct{}{}
}

// RemoveClient removes a WebSocket connection from the broadcast list.
func (b *BootLogBroadcaster) RemoveClient(conn *websocket.Conn) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.clients, conn)
}

// MarkComplete sends a "complete" event to all connected clients and marks
// the broadcaster as done. Late-joining clients will receive history + complete
// immediately.
func (b *BootLogBroadcaster) MarkComplete() {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.complete = true
	completeMsg, _ := json.Marshal(BootLogWSEntry{Type: "complete"})
	for conn := range b.clients {
		if err := conn.WriteMessage(websocket.TextMessage, completeMsg); err != nil {
			log.Printf("bootlog-ws: failed to send complete to client: %v", err)
		}
		conn.Close()
		delete(b.clients, conn)
	}
}

// handleBootLogWS handles WebSocket connections for real-time boot log streaming.
func (s *Server) handleBootLogWS(w http.ResponseWriter, r *http.Request) {
	if s.bootLogBroadcaster == nil {
		http.Error(w, "boot log streaming not available", http.StatusServiceUnavailable)
		return
	}

	// Authenticate using the same mechanism as terminal WebSocket.
	wsScope := defaultWorkspaceScope(s.config.WorkspaceID, s.config.NodeID)
	_, ok := s.authenticateWorkspaceWebsocket(w, r, wsScope)
	if !ok {
		return // authenticateWorkspaceWebsocket already wrote the HTTP error
	}

	// Upgrade to WebSocket.
	upgrader := websocket.Upgrader{
		ReadBufferSize:  s.config.WSReadBufferSize,
		WriteBufferSize: s.config.WSWriteBufferSize,
		CheckOrigin:     func(_ *http.Request) bool { return true },
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("bootlog-ws: upgrade failed: %v", err)
		return
	}

	s.bootLogBroadcaster.AddClient(conn)

	// Read loop — blocks until client disconnects or context cancelled.
	// We don't expect messages from the client, just keep the connection alive.
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			break
		}
	}

	s.bootLogBroadcaster.RemoveClient(conn)
	conn.Close()
}
