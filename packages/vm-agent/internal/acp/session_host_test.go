package acp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

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

	// The attach sends session_state + session_replay_complete
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
		for i := 0; i < 2; i++ {
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

	// Now attach a viewer — it should get session_state, 3 replayed messages, then replay_complete
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
}

func TestSessionHost_StopDisconnectsViewers(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)

	serverConn, clientConn := testWSPair(t)
	host.AttachViewer("v1", serverConn)

	// Drain attach messages
	for i := 0; i < 2; i++ {
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
	for i := 0; i < 2; i++ {
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
