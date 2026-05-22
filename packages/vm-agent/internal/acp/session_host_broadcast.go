package acp

import (
	"encoding/json"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// --- Internal: message broadcasting ---

// appendMessage appends a message to the replay buffer.
func (h *SessionHost) appendMessage(data []byte) {
	// Append to buffer — sequence number assigned under lock to ensure
	// buffer ordering matches sequence ordering under concurrent writes.
	h.bufMu.Lock()
	seq := atomic.AddUint64(&h.seqCounter, 1)
	h.messageBuf = append(h.messageBuf, BufferedMessage{
		Data:      data,
		SeqNum:    seq,
		Timestamp: time.Now(),
	})
	// Evict oldest if over limit
	if len(h.messageBuf) > h.config.MessageBufferSize {
		excess := len(h.messageBuf) - h.config.MessageBufferSize
		h.messageBuf = h.messageBuf[excess:]
	}
	h.bufMu.Unlock()
}

// broadcastMessage appends a message to the buffer and sends it to all viewers.
func (h *SessionHost) broadcastMessage(data []byte) {
	h.broadcastMessageWithPriority(data, false)
}

func (h *SessionHost) broadcastMessageWithPriority(data []byte, priority bool) {
	h.appendMessage(data)
	// Fan out to all viewers
	h.viewerMu.RLock()
	for _, viewer := range h.viewers {
		if priority {
			h.sendToViewerPriority(viewer, data)
		} else {
			h.sendToViewer(viewer, data)
		}
	}
	h.viewerMu.RUnlock()
}

// broadcastAgentStatus broadcasts an agent_status control message to all viewers
// and buffers it for late-join replay.
func (h *SessionHost) broadcastAgentStatus(status AgentStatus, agentType, errMsg string) {
	msg := AgentStatusMessage{
		Type:      MsgAgentStatus,
		Status:    status,
		AgentType: agentType,
		Error:     errMsg,
	}
	data, _ := json.Marshal(msg)
	h.broadcastMessageWithPriority(data, true)
}

func (h *SessionHost) broadcastAgentCrashReport(report AgentCrashReportMessage) {
	data, _ := json.Marshal(report)
	h.broadcastMessageWithPriority(data, true)
}

// broadcastControl broadcasts a control message to all viewers and buffers it.
func (h *SessionHost) broadcastControl(msgType ControlMessageType, extra map[string]interface{}) {
	data := h.marshalControl(msgType, extra)
	h.broadcastMessageWithPriority(data, true)
}

// replayToViewer sends all buffered messages to a newly attached viewer.
// Uses a blocking send with timeout to avoid silently dropping messages when
// the viewer's send channel fills faster than the write pump can drain it.
func (h *SessionHost) replayToViewer(viewer *Viewer) {
	h.bufMu.RLock()
	messages := make([]BufferedMessage, len(h.messageBuf))
	copy(messages, h.messageBuf)
	h.bufMu.RUnlock()

	dropped := 0
	for _, msg := range messages {
		if !h.sendToViewerWithTimeout(viewer, msg.Data, 5*time.Second) {
			dropped++
			break // viewer gone or persistently blocked — stop replay
		}
	}
	if dropped > 0 {
		slog.Warn("SessionHost: viewer replay aborted", "sessionID", h.config.SessionID, "viewerID", viewer.ID, "delivered", len(messages)-dropped, "total", len(messages))
	}
}

// sendToViewerWithTimeout sends a message with a blocking timeout.
// Returns true if sent, false if the viewer is gone or the timeout expired.
func (h *SessionHost) sendToViewerWithTimeout(viewer *Viewer, data []byte, timeout time.Duration) bool {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case viewer.sendCh <- data:
		return true
	case <-viewer.done:
		return false
	case <-timer.C:
		slog.Warn("SessionHost: viewer replay send timed out", "sessionID", h.config.SessionID, "viewerID", viewer.ID, "timeout", timeout)
		return false
	}
}

// sendToViewer sends a message to a single viewer via its buffered channel.
// If the channel is full, the message is dropped (viewer can reconnect).
func (h *SessionHost) sendToViewer(viewer *Viewer, data []byte) {
	select {
	case viewer.sendCh <- data:
	case <-viewer.done:
	default:
		// Channel full — drop message for this viewer
		slog.Warn("SessionHost: viewer send buffer full, dropping message", "sessionID", h.config.SessionID, "viewerID", viewer.ID)
	}
}

// sendToViewerPriority sends a high-priority message.
// If the channel is full, we evict one queued message and retry once so
// control/status updates are not silently dropped under replay backpressure.
func (h *SessionHost) sendToViewerPriority(viewer *Viewer, data []byte) {
	select {
	case viewer.sendCh <- data:
		return
	case <-viewer.done:
		return
	default:
	}

	// Make room by dropping one queued item for this viewer.
	select {
	case <-viewer.sendCh:
	default:
	}

	select {
	case viewer.sendCh <- data:
	case <-viewer.done:
	default:
		slog.Warn("SessionHost: viewer priority message dropped (buffer saturated)", "sessionID", h.config.SessionID, "viewerID", viewer.ID)
	}
}

// viewerWritePump drains the viewer's send channel and writes to its WebSocket.
// On write failure, it signals done so the Gateway read loop exits immediately
// instead of waiting for a read deadline timeout.
func (h *SessionHost) viewerWritePump(viewer *Viewer) {
	defer func() {
		// Signal done BEFORE closing the connection so the Gateway read loop
		// can detect the failure immediately via the done channel select case,
		// rather than waiting for the read deadline (40s) to expire.
		viewer.once.Do(func() { close(viewer.done) })
		viewer.conn.Close()
	}()

	for {
		select {
		case data, ok := <-viewer.sendCh:
			if !ok {
				return
			}
			viewer.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := viewer.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				slog.Warn("SessionHost: viewer write failed", "sessionID", h.config.SessionID, "viewerID", viewer.ID, "error", err)
				return
			}
		case <-viewer.done:
			return
		case <-h.ctx.Done():
			return
		}
	}
}

// SendPongToViewer sends an application-level pong response to a specific viewer.
// This does NOT go through the message buffer — keepalive messages are transient.
func (h *SessionHost) SendPongToViewer(viewerID string) {
	data, err := json.Marshal(map[string]string{"type": string(MsgPong)})
	if err != nil {
		slog.Error("SessionHost: failed to marshal pong", "error", err)
		return
	}
	h.viewerMu.RLock()
	viewer, ok := h.viewers[viewerID]
	h.viewerMu.RUnlock()
	if ok {
		h.sendToViewerPriority(viewer, data)
	}
}

// sendJSONRPCErrorToViewer sends a JSON-RPC error to a specific viewer.
func (h *SessionHost) sendJSONRPCErrorToViewer(viewerID string, reqID json.RawMessage, code int, message string) {
	data := h.marshalJSONRPCError(reqID, code, message)

	h.viewerMu.RLock()
	viewer, ok := h.viewers[viewerID]
	h.viewerMu.RUnlock()

	if ok {
		h.sendToViewerPriority(viewer, data)
	}
}

// --- Internal: message marshaling ---

func (h *SessionHost) marshalSessionState(status SessionHostStatus, agentType, errMsg string) []byte {
	return h.marshalSessionStateWithReplayCount(status, agentType, errMsg, -1)
}

// marshalSessionStateWithReplayCount marshals a session_state message.
// If replayCountOverride >= 0, it is used as-is; otherwise the actual buffer length is used.
func (h *SessionHost) marshalSessionStateWithReplayCount(status SessionHostStatus, agentType, errMsg string, replayCountOverride int) []byte {
	replayCount := replayCountOverride
	if replayCount < 0 {
		h.bufMu.RLock()
		replayCount = len(h.messageBuf)
		h.bufMu.RUnlock()
	}

	msg := SessionStateMessage{
		Type:        MsgSessionState,
		Status:      string(status),
		AgentType:   agentType,
		Error:       errMsg,
		ReplayCount: replayCount,
	}
	data, _ := json.Marshal(msg)
	return data
}

func (h *SessionHost) marshalControl(msgType ControlMessageType, extra map[string]interface{}) []byte {
	msg := map[string]interface{}{
		"type": string(msgType),
	}
	for k, v := range extra {
		msg[k] = v
	}
	data, _ := json.Marshal(msg)
	return data
}

func (h *SessionHost) marshalJSONRPCError(reqID json.RawMessage, code int, message string) []byte {
	resp := map[string]interface{}{
		"jsonrpc": "2.0",
		"error": map[string]interface{}{
			"code":    code,
			"message": message,
		},
	}
	if reqID != nil {
		resp["id"] = json.RawMessage(reqID)
	}
	data, _ := json.Marshal(resp)
	return data
}
