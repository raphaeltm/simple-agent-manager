package server

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// maxBootLogEntries is the maximum number of boot log entries buffered for
	// catch-up when a new client connects.
	maxBootLogEntries = 200

	// bootLogWriteTimeout is the per-message write deadline for boot-log WebSocket clients.
	bootLogWriteTimeout = 5 * time.Second
)

// BootLogWSEntry is a single boot log entry sent over WebSocket.
type BootLogWSEntry struct {
	Type      string `json:"type"`                // "log" or "complete"
	Step      string `json:"step,omitempty"`       // e.g., "git_clone", "devcontainer_up", "build_output"
	Status    string `json:"status,omitempty"`     // e.g., "started", "completed", "failed", "streaming"
	Message   string `json:"message,omitempty"`    // human-readable message or build output lines
	Detail    string `json:"detail,omitempty"`     // optional error detail
	Timestamp string `json:"timestamp,omitempty"`  // RFC3339
}

// BootLogBroadcaster manages boot log WebSocket clients and buffers recent entries.
// It is safe for concurrent use from multiple goroutines.
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

// Broadcast implements bootlog.Broadcaster. It appends the entry to the buffer
// and sends it to all connected WebSocket clients.
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
	// Trim buffer if it exceeds max entries.
	if len(b.entries) >= maxBootLogEntries {
		b.entries = b.entries[1:]
	}
	b.entries = append(b.entries, entry)

	// Snapshot clients under lock.
	clients := make([]*websocket.Conn, 0, len(b.clients))
	for c := range b.clients {
		clients = append(clients, c)
	}
	b.mu.Unlock()

	// Send to all clients outside the lock to avoid blocking.
	data, err := json.Marshal(entry)
	if err != nil {
		log.Printf("bootlog-ws: failed to marshal entry: %v", err)
		return
	}

	for _, conn := range clients {
		_ = conn.SetWriteDeadline(time.Now().Add(bootLogWriteTimeout))
		if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
			log.Printf("bootlog-ws: write failed, removing client: %v", err)
			b.mu.Lock()
			delete(b.clients, conn)
			b.mu.Unlock()
			_ = conn.Close()
		}
	}
}

// AddClient registers a WebSocket connection and sends all buffered entries as catch-up.
func (b *BootLogBroadcaster) AddClient(conn *websocket.Conn) {
	b.mu.Lock()
	b.clients[conn] = struct{}{}
	// Copy buffered entries under lock.
	buffered := make([]BootLogWSEntry, len(b.entries))
	copy(buffered, b.entries)
	isComplete := b.complete
	b.mu.Unlock()

	// Send buffered entries to the new client.
	for _, entry := range buffered {
		data, err := json.Marshal(entry)
		if err != nil {
			continue
		}
		_ = conn.SetWriteDeadline(time.Now().Add(bootLogWriteTimeout))
		if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
			log.Printf("bootlog-ws: catch-up write failed: %v", err)
			b.mu.Lock()
			delete(b.clients, conn)
			b.mu.Unlock()
			_ = conn.Close()
			return
		}
	}

	// If bootstrap already completed, send complete event immediately.
	if isComplete {
		b.sendComplete(conn)
	}
}

// RemoveClient unregisters a WebSocket connection.
func (b *BootLogBroadcaster) RemoveClient(conn *websocket.Conn) {
	b.mu.Lock()
	delete(b.clients, conn)
	b.mu.Unlock()
}

// MarkComplete signals that bootstrap has finished. It sends a "complete" event
// to all connected clients and sets a flag so late-joining clients also receive it.
func (b *BootLogBroadcaster) MarkComplete() {
	b.mu.Lock()
	b.complete = true
	clients := make([]*websocket.Conn, 0, len(b.clients))
	for c := range b.clients {
		clients = append(clients, c)
	}
	b.mu.Unlock()

	for _, conn := range clients {
		b.sendComplete(conn)
	}
}

// sendComplete sends the "complete" message to a single client.
func (b *BootLogBroadcaster) sendComplete(conn *websocket.Conn) {
	entry := BootLogWSEntry{Type: "complete"}
	data, err := json.Marshal(entry)
	if err != nil {
		return
	}
	_ = conn.SetWriteDeadline(time.Now().Add(bootLogWriteTimeout))
	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		log.Printf("bootlog-ws: complete write failed: %v", err)
	}
}

// handleBootLogWS handles WebSocket connections for boot log streaming.
// It authenticates the client using the same JWT mechanism as terminal WebSocket,
// sends buffered boot log history, and streams new entries in real time.
func (s *Server) handleBootLogWS(w http.ResponseWriter, r *http.Request) {
	workspaceID := s.resolveWorkspaceIDForWebsocket(r)
	if workspaceID == "" {
		http.Error(w, "Missing workspace route", http.StatusBadRequest)
		return
	}

	_, ok := s.authenticateWorkspaceWebsocket(w, r, workspaceID)
	if !ok {
		return
	}

	if s.bootLogBroadcaster == nil {
		http.Error(w, "Boot log streaming not available", http.StatusServiceUnavailable)
		return
	}

	upgrader := s.createUpgrader()
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("bootlog-ws: upgrade failed: %v", err)
		return
	}
	defer func() {
		s.bootLogBroadcaster.RemoveClient(conn)
		_ = conn.Close()
	}()

	log.Printf("bootlog-ws: client connected for workspace %s", workspaceID)
	s.bootLogBroadcaster.AddClient(conn)

	// Read loop — keeps the connection alive until the client disconnects.
	// We don't expect any meaningful messages from the client, but we need
	// to read to detect disconnections and handle control frames (ping/pong).
	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			break
		}
	}
	log.Printf("bootlog-ws: client disconnected for workspace %s", workspaceID)
}
