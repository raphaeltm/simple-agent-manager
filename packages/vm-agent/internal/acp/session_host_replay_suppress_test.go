package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// TestSessionUpdate_ReplaySuppressedGate verifies the single choke point in
// sessionHostClient.SessionUpdate: when replaySuppressed is set, a session/update
// notification is neither buffered for late-join viewers (broadcastMessage ->
// appendMessage) nor persisted (MessageReporter.Enqueue). When the flag is clear,
// the same notification flows through both paths normally.
func TestSessionUpdate_ReplaySuppressedGate(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name         string
		suppressed   bool
		wantBuffered int
		wantEnqueued int
	}{
		{name: "suppressed drops replay", suppressed: true, wantBuffered: 0, wantEnqueued: 0},
		{name: "not suppressed delivers", suppressed: false, wantBuffered: 1, wantEnqueued: 1},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
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

			host.replaySuppressed.Store(tc.suppressed)

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

			host.bufMu.RLock()
			bufLen := len(host.messageBuf)
			host.bufMu.RUnlock()
			if bufLen != tc.wantBuffered {
				t.Fatalf("buffered messages = %d, want %d", bufLen, tc.wantBuffered)
			}

			if got := len(reporter.Messages()); got != tc.wantEnqueued {
				t.Fatalf("enqueued messages = %d, want %d", got, tc.wantEnqueued)
			}
		})
	}
}

// loadReplayFakeAgent is a minimal JSON-RPC peer that answers a single
// session/load request by first emitting a configurable number of session/update
// notifications (the transcript replay) and then sending the load response.
//
// Emitting the replay notifications BEFORE the response is deliberate: the ACP
// SDK's notification barrier captures the last-enqueued notification sequence at
// response-match time and blocks the LoadSession call until every notification up
// to that watermark has been processed by the client handler. That makes the
// suppression assertion deterministic without any release channel — by the time
// tryLoadPreviousACPSession returns, every replayed update handler has already
// run (while replaySuppressed was true).
//
// The determinism of the zero-buffer/zero-enqueue assertions depends on this
// barrier, which is provided by github.com/coder/acp-go-sdk (pinned v0.13.5).
// If a future SDK upgrade makes notification dispatch asynchronous relative to
// the response, this test would need an explicit synchronization point.
type loadReplayFakeAgent struct {
	t           *testing.T
	reader      *bufio.Reader
	writer      io.Writer
	sessionID   acpsdk.SessionId
	replayCount int
}

func (a *loadReplayFakeAgent) Serve() {
	for {
		line, err := a.reader.ReadString('\n')
		if errors.Is(err, io.EOF) {
			return
		}
		if err != nil {
			if strings.Contains(err.Error(), "closed pipe") {
				return
			}
			a.t.Errorf("read load request: %v", err)
			return
		}

		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			a.t.Errorf("unmarshal load request: %v", err)
			return
		}
		if req.Method != "session/load" {
			a.t.Errorf("method = %q, want session/load", req.Method)
			return
		}

		// Replay the transcript as session/update notifications first, then the
		// response. See the type comment for why ordering matters.
		for i := 0; i < a.replayCount; i++ {
			a.writeReplayNotification(i)
		}
		a.writeJSON(map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      json.RawMessage(req.ID),
			"result":  map[string]interface{}{},
		})
	}
}

func (a *loadReplayFakeAgent) writeReplayNotification(seq int) {
	notif := acpsdk.SessionNotification{
		SessionId: a.sessionID,
		Update: acpsdk.SessionUpdate{
			AgentMessageChunk: &acpsdk.SessionUpdateAgentMessageChunk{
				Content: acpsdk.ContentBlock{
					Text: &acpsdk.ContentBlockText{Text: fmt.Sprintf("replayed-%d", seq)},
				},
			},
		},
	}
	params, err := json.Marshal(notif)
	if err != nil {
		a.t.Errorf("marshal replay notification: %v", err)
		return
	}
	a.writeJSON(map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "session/update",
		"params":  json.RawMessage(params),
	})
}

func (a *loadReplayFakeAgent) writeJSON(v interface{}) {
	data, err := json.Marshal(v)
	if err != nil {
		a.t.Errorf("marshal response: %v", err)
		return
	}
	if _, err := a.writer.Write(append(data, '\n')); err != nil {
		if strings.Contains(err.Error(), "closed pipe") {
			return
		}
		a.t.Errorf("write response: %v", err)
	}
}

// TestTryLoadPreviousACPSession_SuppressesReplayThenResumes is the capability /
// regression test for the cancel-replay bug. It drives the production
// tryLoadPreviousACPSession path against an in-process fake ACP agent that emits
// session/update notifications during LoadSession, and asserts:
//
//  1. Every replayed update is suppressed (not broadcast to viewers, not
//     persisted) while the load is in flight.
//  2. The replaySuppressed flag is cleared once the function returns.
//  3. A post-load session/update (real agent output) still broadcasts AND
//     persists normally.
func TestTryLoadPreviousACPSession_SuppressesReplayThenResumes(t *testing.T) {
	t.Parallel()

	const replayUpdates = 4
	const prevSessionID = "acp-prev-session"

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
	t.Cleanup(host.Stop)

	clientToAgentReader, clientToAgentWriter := io.Pipe()
	agentToClientReader, agentToClientWriter := io.Pipe()
	t.Cleanup(func() {
		clientToAgentReader.Close()
		clientToAgentWriter.Close()
		agentToClientReader.Close()
		agentToClientWriter.Close()
	})

	server := &loadReplayFakeAgent{
		t:           t,
		reader:      bufio.NewReader(clientToAgentReader),
		writer:      agentToClientWriter,
		sessionID:   acpsdk.SessionId(prevSessionID),
		replayCount: replayUpdates,
	}
	go server.Serve()

	acpConn := acpsdk.NewClientSideConnection(
		&sessionHostClient{host: host},
		clientToAgentWriter,
		agentToClientReader,
	)
	host.mu.Lock()
	host.acpConn = acpConn
	host.status = HostReady
	host.mu.Unlock()

	loaded, err := host.tryLoadPreviousACPSession(
		context.Background(),
		"claude-code",
		nil, // nil settings => applySessionSettings is a no-op (no extra RPC round-trips)
		prevSessionID,
		true,           // supportsLoadSession
		10*time.Second, // timeout
		false,          // allowNewSessionFallback
	)
	if err != nil {
		t.Fatalf("tryLoadPreviousACPSession returned error: %v", err)
	}
	if !loaded {
		t.Fatal("tryLoadPreviousACPSession returned loaded=false, want true")
	}

	// The notification barrier guarantees every replayed update emitted before
	// the load response was processed while LoadSession blocked (replaySuppressed
	// still true). None should have leaked into the viewer buffer or persistence.
	host.bufMu.RLock()
	bufLen := len(host.messageBuf)
	host.bufMu.RUnlock()
	if bufLen != 0 {
		t.Fatalf("replayed updates leaked into broadcast buffer: got %d buffered, want 0", bufLen)
	}
	if got := len(reporter.Messages()); got != 0 {
		t.Fatalf("replayed updates were persisted: got %d enqueued, want 0", got)
	}

	// The suppression flag must always be cleared once the load completes.
	if host.replaySuppressed.Load() {
		t.Fatal("replaySuppressed still true after tryLoadPreviousACPSession returned")
	}

	// A post-load session/update (genuine agent output after resume) must flow
	// through both the broadcast buffer and the message reporter.
	postLoad := acpsdk.SessionNotification{
		SessionId: acpsdk.SessionId(prevSessionID),
		Update: acpsdk.SessionUpdate{
			AgentMessageChunk: &acpsdk.SessionUpdateAgentMessageChunk{
				Content: acpsdk.ContentBlock{
					Text: &acpsdk.ContentBlockText{Text: "post-load reply"},
				},
			},
		},
	}
	if err := (&sessionHostClient{host: host}).SessionUpdate(context.Background(), postLoad); err != nil {
		t.Fatalf("post-load SessionUpdate: %v", err)
	}

	host.bufMu.RLock()
	bufLen = len(host.messageBuf)
	host.bufMu.RUnlock()
	if bufLen != 1 {
		t.Fatalf("post-load update not broadcast: got %d buffered, want 1", bufLen)
	}
	msgs := reporter.Messages()
	if len(msgs) != 1 {
		t.Fatalf("post-load update not persisted: got %d enqueued, want 1", len(msgs))
	}
	if msgs[0].Content != "post-load reply" {
		t.Fatalf("persisted content = %q, want 'post-load reply'", msgs[0].Content)
	}
}
