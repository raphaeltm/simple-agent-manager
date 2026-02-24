package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/gorilla/websocket"
)

// testWSPair creates a connected client+server WebSocket pair using httptest.
func testWSPair(t *testing.T) (serverConn *websocket.Conn, clientConn *websocket.Conn) {
	t.Helper()

	upgrader := websocket.Upgrader{CheckOrigin: func(_ *http.Request) bool { return true }}
	var serverOnce sync.Once
	serverReady := make(chan *websocket.Conn, 1)

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Logf("test ws upgrade: %v", err)
			return
		}
		serverOnce.Do(func() { serverReady <- c })
	}))
	t.Cleanup(ts.Close)

	url := "ws" + strings.TrimPrefix(ts.URL, "http")
	client, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial ws: %v", err)
	}
	t.Cleanup(func() { client.Close() })

	select {
	case server := <-serverReady:
		return server, client
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for server websocket")
		return nil, nil
	}
}

func newTestSessionHost(t *testing.T) *SessionHost {
	t.Helper()
	return NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:   "test-session",
			WorkspaceID: "test-workspace",
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
}

func TestNewSessionHost_Defaults(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{})
	if host.Status() != HostIdle {
		t.Fatalf("initial status = %s, want %s", host.Status(), HostIdle)
	}
	if host.ViewerCount() != 0 {
		t.Fatalf("initial viewer count = %d, want 0", host.ViewerCount())
	}
	if host.AgentType() != "" {
		t.Fatalf("initial agent type = %q, want empty", host.AgentType())
	}
	if host.config.MessageBufferSize != DefaultMessageBufferSize {
		t.Fatalf("default MessageBufferSize = %d, want %d", host.config.MessageBufferSize, DefaultMessageBufferSize)
	}
	if host.config.ViewerSendBuffer != DefaultViewerSendBuffer {
		t.Fatalf("default ViewerSendBuffer = %d, want %d", host.config.ViewerSendBuffer, DefaultViewerSendBuffer)
	}
	host.Stop()
}

func TestSessionHost_AttachDetachViewer(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	serverConn, clientConn := testWSPair(t)

	viewer := host.AttachViewer("v1", serverConn)
	if viewer == nil {
		t.Fatal("AttachViewer returned nil")
	}
	if host.ViewerCount() != 1 {
		t.Fatalf("viewer count = %d, want 1", host.ViewerCount())
	}

	// The attach sends initial session_state + session_replay_complete + post-replay session_state
	// Read session_state
	_, msg1, err := clientConn.ReadMessage()
	if err != nil {
		t.Fatalf("read session_state: %v", err)
	}
	var stateMsg SessionStateMessage
	if err := json.Unmarshal(msg1, &stateMsg); err != nil {
		t.Fatalf("unmarshal session_state: %v", err)
	}
	if stateMsg.Type != MsgSessionState {
		t.Fatalf("first message type = %s, want %s", stateMsg.Type, MsgSessionState)
	}
	if stateMsg.Status != string(HostIdle) {
		t.Fatalf("session state status = %s, want %s", stateMsg.Status, HostIdle)
	}

	// Read session_replay_complete
	_, msg2, err := clientConn.ReadMessage()
	if err != nil {
		t.Fatalf("read session_replay_complete: %v", err)
	}
	var replayDone map[string]interface{}
	if err := json.Unmarshal(msg2, &replayDone); err != nil {
		t.Fatalf("unmarshal replay_complete: %v", err)
	}
	if replayDone["type"] != string(MsgSessionReplayDone) {
		t.Fatalf("second message type = %v, want %s", replayDone["type"], MsgSessionReplayDone)
	}

	// Read post-replay authoritative session_state — must have replayCount=0
	_, msg3, err := clientConn.ReadMessage()
	if err != nil {
		t.Fatalf("read post-replay session_state: %v", err)
	}
	var postStateMsg SessionStateMessage
	if err := json.Unmarshal(msg3, &postStateMsg); err != nil {
		t.Fatalf("unmarshal post-replay session_state: %v", err)
	}
	if postStateMsg.Type != MsgSessionState {
		t.Fatalf("third message type = %s, want %s", postStateMsg.Type, MsgSessionState)
	}
	if postStateMsg.ReplayCount != 0 {
		t.Fatalf("post-replay session_state replayCount = %d, want 0", postStateMsg.ReplayCount)
	}

	// Detach viewer
	host.DetachViewer("v1")
	if host.ViewerCount() != 0 {
		t.Fatalf("viewer count after detach = %d, want 0", host.ViewerCount())
	}
}

func TestSessionHost_AttachViewerWhenStopped(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	host.Stop()

	serverConn, _ := testWSPair(t)
	viewer := host.AttachViewer("v1", serverConn)
	if viewer != nil {
		t.Fatal("AttachViewer should return nil for stopped host")
	}
}

func TestSessionHost_BroadcastToMultipleViewers(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	// Attach two viewers
	server1, client1 := testWSPair(t)
	server2, client2 := testWSPair(t)

	host.AttachViewer("v1", server1)
	host.AttachViewer("v2", server2)

	if host.ViewerCount() != 2 {
		t.Fatalf("viewer count = %d, want 2", host.ViewerCount())
	}

	// Drain the initial session_state + replay_complete messages
	drainAttachMessages := func(client *websocket.Conn) {
		for i := 0; i < 3; i++ {
			client.SetReadDeadline(time.Now().Add(2 * time.Second))
			_, _, err := client.ReadMessage()
			if err != nil {
				t.Fatalf("drain message %d: %v", i, err)
			}
		}
	}
	drainAttachMessages(client1)
	drainAttachMessages(client2)

	// Broadcast a message
	testMsg := []byte(`{"test":"broadcast"}`)
	host.broadcastMessage(testMsg)

	// Both viewers should receive it
	readMsg := func(client *websocket.Conn, name string) []byte {
		client.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, msg, err := client.ReadMessage()
		if err != nil {
			t.Fatalf("%s read: %v", name, err)
		}
		return msg
	}

	got1 := readMsg(client1, "viewer1")
	got2 := readMsg(client2, "viewer2")

	if string(got1) != string(testMsg) {
		t.Fatalf("viewer1 got %q, want %q", got1, testMsg)
	}
	if string(got2) != string(testMsg) {
		t.Fatalf("viewer2 got %q, want %q", got2, testMsg)
	}
}

func TestSessionHost_MessageBuffer(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:   "test-session",
			WorkspaceID: "test-workspace",
		},
		MessageBufferSize: 5,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	// Add 8 messages (exceeds buffer of 5)
	for i := 0; i < 8; i++ {
		msg, _ := json.Marshal(map[string]int{"seq": i})
		host.broadcastMessage(msg)
	}

	// Buffer should only contain the last 5
	host.bufMu.RLock()
	bufLen := len(host.messageBuf)
	host.bufMu.RUnlock()

	if bufLen != 5 {
		t.Fatalf("buffer length = %d, want 5", bufLen)
	}

	// First message in buffer should be seq 3 (0,1,2 were evicted)
	host.bufMu.RLock()
	firstMsg := host.messageBuf[0]
	host.bufMu.RUnlock()

	var parsed map[string]int
	if err := json.Unmarshal(firstMsg.Data, &parsed); err != nil {
		t.Fatalf("unmarshal first buffered message: %v", err)
	}
	if parsed["seq"] != 3 {
		t.Fatalf("first buffered message seq = %d, want 3", parsed["seq"])
	}
}

func TestSessionHost_LateJoinReplay(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	// Pre-fill some messages before any viewer connects
	for i := 0; i < 3; i++ {
		msg, _ := json.Marshal(map[string]int{"seq": i})
		host.broadcastMessage(msg)
	}

	// Now attach a viewer — it should get session_state, 3 replayed messages,
	// replay_complete, then post-replay session_state.
	serverConn, clientConn := testWSPair(t)
	host.AttachViewer("late-v1", serverConn)

	readAndParse := func(desc string) map[string]interface{} {
		clientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, msg, err := clientConn.ReadMessage()
		if err != nil {
			t.Fatalf("read %s: %v", desc, err)
		}
		var parsed map[string]interface{}
		if err := json.Unmarshal(msg, &parsed); err != nil {
			t.Fatalf("parse %s: %v", desc, err)
		}
		return parsed
	}

	// 1. session_state
	state := readAndParse("session_state")
	if state["type"] != string(MsgSessionState) {
		t.Fatalf("expected session_state, got type=%v", state["type"])
	}
	replayCount := int(state["replayCount"].(float64))
	if replayCount != 3 {
		t.Fatalf("replayCount = %d, want 3", replayCount)
	}

	// 2-4. replayed messages
	for i := 0; i < 3; i++ {
		msg := readAndParse("replay message")
		if int(msg["seq"].(float64)) != i {
			t.Fatalf("replay message %d: seq = %v, want %d", i, msg["seq"], i)
		}
	}

	// 5. session_replay_complete
	done := readAndParse("session_replay_complete")
	if done["type"] != string(MsgSessionReplayDone) {
		t.Fatalf("expected session_replay_complete, got type=%v", done["type"])
	}

	// 6. post-replay session_state — must have replayCount=0
	postState := readAndParse("post-replay session_state")
	if postState["type"] != string(MsgSessionState) {
		t.Fatalf("expected session_state, got type=%v", postState["type"])
	}
	postReplayCount := int(postState["replayCount"].(float64))
	if postReplayCount != 0 {
		t.Fatalf("post-replay session_state replayCount = %d, want 0 (non-zero would trigger double-clear on browser)", postReplayCount)
	}
}

// TestSessionHost_ReplayDoesNotDropMessages verifies that replay delivers all
// buffered messages even when the buffer exceeds the viewer's send channel
// capacity (previously messages were silently dropped by non-blocking sends).
func TestSessionHost_ReplayDoesNotDropMessages(t *testing.T) {
	t.Parallel()

	// Use a small send buffer to test the blocking replay path
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:   "test-session",
			WorkspaceID: "test-workspace",
		},
		MessageBufferSize: 500,
		ViewerSendBuffer:  8, // Much smaller than message count
	})
	defer host.Stop()

	// Fill buffer with more messages than the send channel capacity
	const messageCount = 50
	for i := 0; i < messageCount; i++ {
		msg, _ := json.Marshal(map[string]int{"seq": i})
		host.broadcastMessage(msg)
	}

	serverConn, clientConn := testWSPair(t)
	host.AttachViewer("replay-v1", serverConn)

	clientConn.SetReadDeadline(time.Now().Add(10 * time.Second))

	// Read session_state (pre-replay)
	_, raw, err := clientConn.ReadMessage()
	if err != nil {
		t.Fatalf("read session_state: %v", err)
	}
	var stateMsg SessionStateMessage
	if err := json.Unmarshal(raw, &stateMsg); err != nil {
		t.Fatalf("unmarshal session_state: %v", err)
	}
	if stateMsg.ReplayCount != messageCount {
		t.Fatalf("pre-replay replayCount = %d, want %d", stateMsg.ReplayCount, messageCount)
	}

	// Read all replay messages
	receivedCount := 0
	for {
		_, raw, err = clientConn.ReadMessage()
		if err != nil {
			t.Fatalf("read replay message: %v", err)
		}
		var parsed map[string]interface{}
		if err := json.Unmarshal(raw, &parsed); err != nil {
			t.Fatalf("parse message: %v", err)
		}
		// Check if this is the replay_complete control message
		if parsed["type"] == string(MsgSessionReplayDone) {
			break
		}
		// Check if this is a control message (session_state, etc.) — skip
		if _, isType := parsed["type"]; isType {
			continue
		}
		receivedCount++
	}

	if receivedCount != messageCount {
		t.Fatalf("received %d replay messages, want %d (messages were dropped)", receivedCount, messageCount)
	}
}

func TestSessionHost_StopDisconnectsViewers(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)

	serverConn, clientConn := testWSPair(t)
	host.AttachViewer("v1", serverConn)

	// Drain attach messages
	for i := 0; i < 3; i++ {
		clientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, _, _ = clientConn.ReadMessage()
	}

	// Stop the host
	host.Stop()

	if host.Status() != HostStopped {
		t.Fatalf("status after Stop = %s, want %s", host.Status(), HostStopped)
	}
	if host.ViewerCount() != 0 {
		t.Fatalf("viewer count after Stop = %d, want 0", host.ViewerCount())
	}

	// Client should get a close frame or error on next read
	clientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err := clientConn.ReadMessage()
	if err == nil {
		t.Fatal("expected error reading from client after stop, got nil")
	}
}

func TestSessionHost_StopIsIdempotent(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)

	host.Stop()
	host.Stop() // should not panic
	host.Stop() // should not panic

	if host.Status() != HostStopped {
		t.Fatalf("status = %s, want %s", host.Status(), HostStopped)
	}
}

func TestSessionHost_DetachNonexistentViewer(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	// Should not panic
	host.DetachViewer("nonexistent")

	if host.ViewerCount() != 0 {
		t.Fatalf("viewer count = %d, want 0", host.ViewerCount())
	}
}

func TestSessionHost_SequenceNumbers(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	// Broadcast several messages
	for i := 0; i < 5; i++ {
		msg, _ := json.Marshal(map[string]int{"i": i})
		host.broadcastMessage(msg)
	}

	host.bufMu.RLock()
	defer host.bufMu.RUnlock()

	if len(host.messageBuf) != 5 {
		t.Fatalf("buffer length = %d, want 5", len(host.messageBuf))
	}

	// Sequence numbers should be monotonically increasing
	for i := 1; i < len(host.messageBuf); i++ {
		if host.messageBuf[i].SeqNum <= host.messageBuf[i-1].SeqNum {
			t.Fatalf("sequence numbers not monotonically increasing: %d <= %d at index %d",
				host.messageBuf[i].SeqNum, host.messageBuf[i-1].SeqNum, i)
		}
	}

	// First should be 1
	if host.messageBuf[0].SeqNum != 1 {
		t.Fatalf("first sequence number = %d, want 1", host.messageBuf[0].SeqNum)
	}
}

func TestSessionHost_ConcurrentBroadcast(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:   "test-session",
			WorkspaceID: "test-workspace",
		},
		MessageBufferSize: 1000,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	// Broadcast from many goroutines concurrently
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				msg, _ := json.Marshal(map[string]int{"goroutine": n, "seq": j})
				host.broadcastMessage(msg)
			}
		}(i)
	}
	wg.Wait()

	host.bufMu.RLock()
	bufLen := len(host.messageBuf)
	host.bufMu.RUnlock()

	if bufLen != 1000 {
		t.Fatalf("buffer length = %d, want 1000", bufLen)
	}

	// Verify all sequence numbers are unique and increasing
	host.bufMu.RLock()
	for i := 1; i < len(host.messageBuf); i++ {
		if host.messageBuf[i].SeqNum <= host.messageBuf[i-1].SeqNum {
			host.bufMu.RUnlock()
			t.Fatalf("sequence numbers not monotonic at index %d: %d <= %d",
				i, host.messageBuf[i].SeqNum, host.messageBuf[i-1].SeqNum)
		}
	}
	host.bufMu.RUnlock()
}

func TestSessionHost_SetStatus(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	host.setStatus(HostReady, "")
	if host.Status() != HostReady {
		t.Fatalf("status = %s, want %s", host.Status(), HostReady)
	}

	host.setStatus(HostError, "something broke")
	if host.Status() != HostError {
		t.Fatalf("status = %s, want %s", host.Status(), HostError)
	}
}

func TestSessionHost_MarshalSessionState(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	// Add some messages to the buffer
	for i := 0; i < 7; i++ {
		msg, _ := json.Marshal(map[string]int{"i": i})
		host.broadcastMessage(msg)
	}

	data := host.marshalSessionState(HostReady, "claude-code", "")
	var state SessionStateMessage
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if state.Type != MsgSessionState {
		t.Fatalf("type = %s, want %s", state.Type, MsgSessionState)
	}
	if state.Status != string(HostReady) {
		t.Fatalf("status = %s, want %s", state.Status, HostReady)
	}
	if state.AgentType != "claude-code" {
		t.Fatalf("agentType = %s, want claude-code", state.AgentType)
	}
	if state.ReplayCount != 7 {
		t.Fatalf("replayCount = %d, want 7", state.ReplayCount)
	}
}

func TestSessionHost_MarshalJSONRPCError(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	reqID := json.RawMessage(`"req-123"`)
	data := host.marshalJSONRPCError(reqID, -32603, "test error")

	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if parsed["jsonrpc"] != "2.0" {
		t.Fatalf("jsonrpc = %v, want 2.0", parsed["jsonrpc"])
	}
	if parsed["id"] != "req-123" {
		t.Fatalf("id = %v, want req-123", parsed["id"])
	}
	errObj := parsed["error"].(map[string]interface{})
	if errObj["message"] != "test error" {
		t.Fatalf("error message = %v, want 'test error'", errObj["message"])
	}
}

func TestSessionHost_BroadcastAgentStatus(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	host.broadcastAgentStatus(StatusReady, "claude-code", "")

	host.bufMu.RLock()
	defer host.bufMu.RUnlock()

	if len(host.messageBuf) != 1 {
		t.Fatalf("buffer length = %d, want 1", len(host.messageBuf))
	}

	var status AgentStatusMessage
	if err := json.Unmarshal(host.messageBuf[0].Data, &status); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if status.Type != MsgAgentStatus {
		t.Fatalf("type = %s, want %s", status.Type, MsgAgentStatus)
	}
	if status.Status != StatusReady {
		t.Fatalf("status = %s, want %s", status.Status, StatusReady)
	}
	if status.AgentType != "claude-code" {
		t.Fatalf("agentType = %s, want claude-code", status.AgentType)
	}
}

func TestSessionHost_ViewerDisconnectDoesNotStopAgent(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	// Simulate agent is ready
	host.setStatus(HostReady, "")

	serverConn, clientConn := testWSPair(t)
	host.AttachViewer("v1", serverConn)

	// Drain attach messages
	for i := 0; i < 3; i++ {
		clientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, _, _ = clientConn.ReadMessage()
	}

	// Close the client connection (simulates browser closing)
	clientConn.Close()

	// Detach the viewer (this is what the server does when WS closes)
	host.DetachViewer("v1")

	// Agent should still be "ready" — NOT stopped
	if host.Status() != HostReady {
		t.Fatalf("status after viewer disconnect = %s, want %s", host.Status(), HostReady)
	}
	if host.ViewerCount() != 0 {
		t.Fatalf("viewer count = %d, want 0", host.ViewerCount())
	}
}

func TestSessionHost_CancelPrompt_NoPromptInFlight(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	// CancelPrompt when no prompt is running should be a no-op (not panic)
	host.CancelPrompt()

	// Status should remain idle
	if host.Status() != HostIdle {
		t.Fatalf("status = %s, want %s", host.Status(), HostIdle)
	}
}

func TestSessionHost_CancelPrompt_CancelsContext(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	// Simulate a prompt in flight by manually setting up the cancel state
	// (we can't easily start a real ACP prompt without a full agent process,
	// but we can test the cancel mechanism directly).
	ctx, cancel := context.WithCancel(context.Background())

	host.promptCancelMu.Lock()
	host.promptCancel = cancel
	host.promptCancelMu.Unlock()

	// Verify context is not yet cancelled
	select {
	case <-ctx.Done():
		t.Fatal("context should not be cancelled yet")
	default:
		// good
	}

	// Cancel the prompt
	host.CancelPrompt()

	// Context should now be cancelled
	select {
	case <-ctx.Done():
		// good — context was cancelled
	default:
		t.Fatal("context should be cancelled after CancelPrompt")
	}
}

func TestSessionHost_CancelPrompt_ConcurrentSafety(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	// Set up a cancel function
	_, cancel := context.WithCancel(context.Background())
	host.promptCancelMu.Lock()
	host.promptCancel = cancel
	host.promptCancelMu.Unlock()

	// Call CancelPrompt from many goroutines concurrently — should not race or panic
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			host.CancelPrompt()
		}()
	}
	wg.Wait()
}

func TestSessionHost_CancelPrompt_ClearedAfterPromptDone(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	// Simulate: promptCancel is set, then cleared (as HandlePrompt does after Prompt() returns)
	_, cancel := context.WithCancel(context.Background())
	host.promptCancelMu.Lock()
	host.promptCancel = cancel
	host.promptCancelMu.Unlock()

	// Simulate prompt completion clearing the cancel
	host.promptCancelMu.Lock()
	host.promptCancel = nil
	host.promptCancelMu.Unlock()

	// CancelPrompt should now be a no-op
	host.CancelPrompt()
	// No panic, no side effects — just verifying safety
}

func TestSessionHost_SendToViewerPriority_EvictsQueuedMessage(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	viewer := &Viewer{
		ID:     "v1",
		sendCh: make(chan []byte, 1),
		done:   make(chan struct{}),
	}

	viewer.sendCh <- []byte(`{"old":true}`)
	host.sendToViewerPriority(viewer, []byte(`{"priority":true}`))

	select {
	case msg := <-viewer.sendCh:
		if string(msg) != `{"priority":true}` {
			t.Fatalf("priority message not delivered, got %s", string(msg))
		}
	default:
		t.Fatal("expected a priority message in viewer channel")
	}
}

func TestSessionHost_Suspend(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)

	// Set up some state to verify it's preserved
	host.mu.Lock()
	host.agentType = "claude-code"
	host.sessionID = "acp-session-xyz"
	host.status = HostReady
	host.mu.Unlock()

	acpSessionID, agentType := host.Suspend()

	if acpSessionID != "acp-session-xyz" {
		t.Fatalf("acpSessionID = %q, want 'acp-session-xyz'", acpSessionID)
	}
	if agentType != "claude-code" {
		t.Fatalf("agentType = %q, want 'claude-code'", agentType)
	}
	if host.Status() != HostStopped {
		t.Fatalf("status after suspend = %s, want %s", host.Status(), HostStopped)
	}
}

func TestSessionHost_SuspendDisconnectsViewers(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)

	serverConn, clientConn := testWSPair(t)
	host.AttachViewer("v1", serverConn)

	// Drain attach messages
	for i := 0; i < 3; i++ {
		clientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, _, _ = clientConn.ReadMessage()
	}

	host.Suspend()

	if host.ViewerCount() != 0 {
		t.Fatalf("viewer count after suspend = %d, want 0", host.ViewerCount())
	}

	// Client should get a close frame or error
	clientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err := clientConn.ReadMessage()
	if err == nil {
		t.Fatal("expected error reading from client after suspend")
	}
}

func TestSessionHost_SuspendWhenStopped(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	host.Stop()

	acpSessionID, agentType := host.Suspend()
	if acpSessionID != "" {
		t.Fatalf("acpSessionID = %q, want empty for already-stopped host", acpSessionID)
	}
	if agentType != "" {
		t.Fatalf("agentType = %q, want empty for already-stopped host", agentType)
	}
}

func TestSessionHost_IsPrompting(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	if host.IsPrompting() {
		t.Fatal("expected IsPrompting=false for idle host")
	}

	host.setStatus(HostReady, "")
	if host.IsPrompting() {
		t.Fatal("expected IsPrompting=false for ready host")
	}

	host.setStatus(HostPrompting, "")
	if !host.IsPrompting() {
		t.Fatal("expected IsPrompting=true for prompting host")
	}
}

func TestSessionHost_AutoSuspendTimerStartsOnLastViewerDetach(t *testing.T) {
	t.Parallel()

	suspendCalled := make(chan struct{}, 1)
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:          "test-session",
			WorkspaceID:        "test-workspace",
			IdleSuspendTimeout: 50 * time.Millisecond,
			OnSuspend: func(wsID, sessID string) {
				suspendCalled <- struct{}{}
			},
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})

	// Attach and detach a viewer to trigger the timer
	serverConn, _ := testWSPair(t)
	host.AttachViewer("v1", serverConn)
	host.DetachViewer("v1")

	// Timer should fire and call OnSuspend
	select {
	case <-suspendCalled:
		// good
	case <-time.After(2 * time.Second):
		t.Fatal("expected OnSuspend to be called after idle timeout")
	}
}

func TestSessionHost_AutoSuspendCancelledByViewerAttach(t *testing.T) {
	t.Parallel()

	suspendCalled := make(chan struct{}, 1)
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:          "test-session",
			WorkspaceID:        "test-workspace",
			IdleSuspendTimeout: 100 * time.Millisecond,
			OnSuspend: func(wsID, sessID string) {
				suspendCalled <- struct{}{}
			},
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	// Attach, detach (starts timer), then re-attach (should cancel timer)
	server1, _ := testWSPair(t)
	host.AttachViewer("v1", server1)
	host.DetachViewer("v1")

	// Re-attach before timer fires
	time.Sleep(30 * time.Millisecond) // well before 100ms timeout
	server2, _ := testWSPair(t)
	host.AttachViewer("v2", server2)

	// Wait past the original timeout — suspend should NOT fire
	select {
	case <-suspendCalled:
		t.Fatal("OnSuspend should NOT have been called — viewer re-attached")
	case <-time.After(300 * time.Millisecond):
		// good — timer was cancelled
	}
}

func TestSessionHost_AutoSuspendDisabledWhenTimeoutZero(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:          "test-session",
			WorkspaceID:        "test-workspace",
			IdleSuspendTimeout: 0, // disabled
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	serverConn, _ := testWSPair(t)
	host.AttachViewer("v1", serverConn)
	host.DetachViewer("v1")

	// Verify no timer was set
	host.viewerMu.RLock()
	hasTimer := host.suspendTimer != nil
	host.viewerMu.RUnlock()

	if hasTimer {
		t.Fatal("suspendTimer should be nil when IdleSuspendTimeout is 0")
	}
}

// --- Message reporter integration tests (T025) ---

// mockMessageReporter captures enqueued messages for testing.
type mockMessageReporter struct {
	mu       sync.Mutex
	messages []MessageReportEntry
	errOnce  error // if set, return this error on first Enqueue call
}

func (m *mockMessageReporter) Enqueue(msg MessageReportEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.errOnce != nil {
		err := m.errOnce
		m.errOnce = nil
		return err
	}
	m.messages = append(m.messages, msg)
	return nil
}

func (m *mockMessageReporter) Messages() []MessageReportEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := make([]MessageReportEntry, len(m.messages))
	copy(cp, m.messages)
	return cp
}

func TestSessionUpdate_NilReporter_StillBroadcasts(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:       "test-session",
			WorkspaceID:     "test-workspace",
			MessageReporter: nil, // no reporter
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	client := &sessionHostClient{host: host}

	notif := acpsdk.SessionNotification{
		SessionId: "acp-sess",
		Update: acpsdk.SessionUpdate{
			AgentMessageChunk: &acpsdk.SessionUpdateAgentMessageChunk{
				Content: acpsdk.ContentBlock{
					Text: &acpsdk.ContentBlockText{Text: "hello"},
				},
			},
		},
	}

	if err := client.SessionUpdate(context.Background(), notif); err != nil {
		t.Fatalf("SessionUpdate: %v", err)
	}

	// Message should be in the broadcast buffer.
	host.bufMu.RLock()
	bufLen := len(host.messageBuf)
	host.bufMu.RUnlock()
	if bufLen != 1 {
		t.Fatalf("expected 1 buffered message, got %d", bufLen)
	}
}

func TestSessionUpdate_WithReporter_EnqueuesMessages(t *testing.T) {
	t.Parallel()

	reporter := &mockMessageReporter{}
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:       "test-session",
			WorkspaceID:     "test-workspace",
			MessageReporter: reporter,
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	client := &sessionHostClient{host: host}

	notif := acpsdk.SessionNotification{
		SessionId: "acp-sess",
		Update: acpsdk.SessionUpdate{
			AgentMessageChunk: &acpsdk.SessionUpdateAgentMessageChunk{
				Content: acpsdk.ContentBlock{
					Text: &acpsdk.ContentBlockText{Text: "assistant response"},
				},
			},
		},
	}

	if err := client.SessionUpdate(context.Background(), notif); err != nil {
		t.Fatalf("SessionUpdate: %v", err)
	}

	msgs := reporter.Messages()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 enqueued message, got %d", len(msgs))
	}
	if msgs[0].Role != "assistant" {
		t.Fatalf("role = %q, want assistant", msgs[0].Role)
	}
	if msgs[0].Content != "assistant response" {
		t.Fatalf("content = %q, want 'assistant response'", msgs[0].Content)
	}
	if msgs[0].MessageID == "" {
		t.Fatal("expected non-empty messageId")
	}
}

func TestSessionUpdate_EnqueueError_NonBlocking(t *testing.T) {
	t.Parallel()

	reporter := &mockMessageReporter{
		errOnce: fmt.Errorf("outbox full"),
	}
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:       "test-session",
			WorkspaceID:     "test-workspace",
			MessageReporter: reporter,
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	client := &sessionHostClient{host: host}

	notif := acpsdk.SessionNotification{
		SessionId: "acp-sess",
		Update: acpsdk.SessionUpdate{
			UserMessageChunk: &acpsdk.SessionUpdateUserMessageChunk{
				Content: acpsdk.ContentBlock{
					Text: &acpsdk.ContentBlockText{Text: "user msg"},
				},
			},
		},
	}

	// SessionUpdate should return nil even if Enqueue fails.
	if err := client.SessionUpdate(context.Background(), notif); err != nil {
		t.Fatalf("SessionUpdate should not fail on Enqueue error: %v", err)
	}

	// Broadcast should still have worked.
	host.bufMu.RLock()
	bufLen := len(host.messageBuf)
	host.bufMu.RUnlock()
	if bufLen != 1 {
		t.Fatalf("expected broadcast to still work, got %d buffered messages", bufLen)
	}
}

func TestSessionUpdate_EmptyUpdate_NoEnqueue(t *testing.T) {
	t.Parallel()

	reporter := &mockMessageReporter{}
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:       "test-session",
			WorkspaceID:     "test-workspace",
			MessageReporter: reporter,
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	client := &sessionHostClient{host: host}

	// Send an update type that ExtractMessages ignores (AgentThoughtChunk).
	// Note: ACP SDK's SessionUpdate requires at least one union field to be
	// set for MarshalJSON to succeed, so we can't use a truly empty update.
	notif := acpsdk.SessionNotification{
		SessionId: "acp-sess",
		Update: acpsdk.SessionUpdate{
			AgentThoughtChunk: &acpsdk.SessionUpdateAgentThoughtChunk{
				Content: acpsdk.ContentBlock{
					Text: &acpsdk.ContentBlockText{Text: "thinking..."},
				},
			},
		},
	}

	if err := client.SessionUpdate(context.Background(), notif); err != nil {
		t.Fatalf("SessionUpdate: %v", err)
	}

	msgs := reporter.Messages()
	if len(msgs) != 0 {
		t.Fatalf("expected 0 enqueued messages for empty update, got %d", len(msgs))
	}
}

func TestSessionHost_CancelPrompt_ForceStopsAfterGracePeriod(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:               "test-session",
			WorkspaceID:             "test-workspace",
			PromptCancelGracePeriod: 10 * time.Millisecond,
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	host.mu.Lock()
	host.status = HostPrompting
	host.agentType = "claude-code"
	host.mu.Unlock()

	host.promptMu.Lock()
	host.promptInFlight = true
	host.promptMu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	host.promptCancelMu.Lock()
	host.promptCancel = cancel
	host.activePromptID = 42
	host.promptCancelMu.Unlock()

	host.CancelPrompt()

	select {
	case <-ctx.Done():
	case <-time.After(500 * time.Millisecond):
		t.Fatal("expected prompt context to be cancelled")
	}

	deadline := time.Now().Add(1 * time.Second)
	for host.Status() != HostError {
		if time.Now().After(deadline) {
			t.Fatal("expected host to transition to error after cancel grace elapsed")
		}
		time.Sleep(10 * time.Millisecond)
	}

	host.mu.RLock()
	statusErr := host.statusErr
	host.mu.RUnlock()
	if !strings.Contains(statusErr, "Prompt cancel grace elapsed") {
		t.Fatalf("statusErr = %q, expected cancel grace reason", statusErr)
	}

	host.promptCancelMu.Lock()
	if host.activePromptID != 0 {
		t.Fatalf("activePromptID = %d, want 0", host.activePromptID)
	}
	if host.promptCancel != nil {
		t.Fatal("promptCancel should be cleared after force-stop")
	}
	host.promptCancelMu.Unlock()

	host.promptMu.Lock()
	if host.promptInFlight {
		t.Fatal("promptInFlight should be false after force-stop")
	}
	host.promptMu.Unlock()

	bufferDeadline := time.Now().Add(500 * time.Millisecond)
	for {
		host.bufMu.RLock()
		buffered := len(host.messageBuf)
		host.bufMu.RUnlock()
		if buffered >= 2 {
			break
		}
		if time.Now().After(bufferDeadline) {
			t.Fatalf("expected prompt_done + error status messages, buffered=%d", buffered)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
