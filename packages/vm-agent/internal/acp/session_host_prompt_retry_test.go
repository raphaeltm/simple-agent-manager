package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

func TestIsTransientProviderPromptError(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "observed claude overload 529",
			err:  errors.New(`Internal error: API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`),
			want: true,
		},
		{
			name: "rate limit 429",
			err:  errors.New(`provider returned HTTP 429 Too Many Requests`),
			want: true,
		},
		{
			name: "temporarily unavailable",
			err:  errors.New(`upstream temporarily unavailable`),
			want: true,
		},
		{
			name: "service unavailable 503",
			err:  errors.New(`API Error: 503 service unavailable`),
			want: true,
		},
		{
			name: "context canceled is not retryable",
			err:  context.Canceled,
			want: false,
		},
		{
			name: "context deadline is not retryable",
			err:  context.DeadlineExceeded,
			want: false,
		},
		{
			name: "non-retryable internal error",
			err:  errors.New(`Internal error: invalid tool call payload`),
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := isTransientProviderPromptError(tt.err); got != tt.want {
				t.Fatalf("isTransientProviderPromptError() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestHandlePromptRetriesTransientProviderErrorThenSucceeds(t *testing.T) {
	t.Parallel()

	host, server := newPromptRetryTestHost(t, promptRetryScript{
		responses: []promptRetryResponse{
			{errMessage: `Internal error: API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`},
			{stopReason: "end_turn"},
		},
	})

	var completed sync.WaitGroup
	completed.Add(1)
	host.config.OnPromptComplete = func(stopReason string, promptErr error) {
		defer completed.Done()
		if stopReason != "end_turn" {
			t.Errorf("stopReason = %q, want end_turn", stopReason)
		}
		if promptErr != nil {
			t.Errorf("promptErr = %v, want nil", promptErr)
		}
	}

	host.HandlePrompt(context.Background(), json.RawMessage(`1`), promptRetryParams(), "viewer-1")
	completed.Wait()

	if got := server.RequestCount(); got != 2 {
		t.Fatalf("prompt request count = %d, want 2", got)
	}
	if got := host.config.EventAppender.(*recordingEventAppender).Count("agent_session.prompt_retry"); got != 1 {
		t.Fatalf("prompt retry event count = %d, want 1", got)
	}
	if got := host.config.MessageReporter.(*mockMessageReporter).Messages(); len(got) != 1 {
		t.Fatalf("reported user messages = %d, want 1 to avoid duplicate replay", len(got))
	}
}

func TestHandlePromptExhaustsTransientProviderRetriesBeforeFailure(t *testing.T) {
	t.Parallel()

	host, server := newPromptRetryTestHost(t, promptRetryScript{
		responses: []promptRetryResponse{
			{errMessage: `Internal error: API Error: 529 overloaded_error`},
			{errMessage: `Internal error: API Error: 529 overloaded_error`},
			{errMessage: `Internal error: API Error: 529 overloaded_error`},
		},
	})

	errCh := make(chan error, 1)
	host.config.OnPromptComplete = func(stopReason string, promptErr error) {
		if stopReason != "error" {
			errCh <- fmt.Errorf("stopReason = %q, want error", stopReason)
			return
		}
		if promptErr == nil {
			errCh <- errors.New("promptErr = nil, want retry exhaustion error")
			return
		}
		errCh <- nil
	}

	host.HandlePrompt(context.Background(), json.RawMessage(`2`), promptRetryParams(), "viewer-1")
	if err := <-errCh; err != nil {
		t.Fatal(err)
	}

	if got := server.RequestCount(); got != 3 {
		t.Fatalf("prompt request count = %d, want 3", got)
	}
	if got := host.config.EventAppender.(*recordingEventAppender).Count("agent_session.prompt_retry"); got != 2 {
		t.Fatalf("prompt retry event count = %d, want 2", got)
	}
}

func TestHandlePromptDoesNotRetryNonRetryableError(t *testing.T) {
	t.Parallel()

	host, server := newPromptRetryTestHost(t, promptRetryScript{
		responses: []promptRetryResponse{
			{errMessage: "Internal error: invalid request payload"},
		},
	})

	errCh := make(chan error, 1)
	host.config.OnPromptComplete = func(stopReason string, promptErr error) {
		if stopReason != "error" {
			errCh <- fmt.Errorf("stopReason = %q, want error", stopReason)
			return
		}
		if promptErr == nil {
			errCh <- errors.New("promptErr = nil, want non-retryable error")
			return
		}
		errCh <- nil
	}

	host.HandlePrompt(context.Background(), json.RawMessage(`3`), promptRetryParams(), "viewer-1")
	if err := <-errCh; err != nil {
		t.Fatal(err)
	}

	if got := server.RequestCount(); got != 1 {
		t.Fatalf("prompt request count = %d, want 1", got)
	}
	if got := host.config.EventAppender.(*recordingEventAppender).Count("agent_session.prompt_retry"); got != 0 {
		t.Fatalf("prompt retry event count = %d, want 0", got)
	}
}

type promptRetryResponse struct {
	errMessage string
	stopReason string
}

type promptRetryScript struct {
	responses []promptRetryResponse
}

type promptRetryFakeAgent struct {
	t      *testing.T
	mu     sync.Mutex
	count  int
	reader *bufio.Reader
	writer io.Writer
	script promptRetryScript
}

func (a *promptRetryFakeAgent) Serve() {
	for {
		line, err := a.reader.ReadString('\n')
		if errors.Is(err, io.EOF) {
			return
		}
		if err != nil {
			if strings.Contains(err.Error(), "closed pipe") {
				return
			}
			a.t.Errorf("read prompt request: %v", err)
			return
		}
		var req struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      json.RawMessage `json:"id"`
			Method  string          `json:"method"`
		}
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			a.t.Errorf("unmarshal prompt request: %v", err)
			return
		}
		if req.Method != "session/prompt" {
			a.t.Errorf("method = %q, want session/prompt", req.Method)
			return
		}

		a.mu.Lock()
		index := a.count
		a.count++
		a.mu.Unlock()

		response := promptRetryResponse{errMessage: "Internal error: unexpected extra prompt"}
		if index < len(a.script.responses) {
			response = a.script.responses[index]
		}

		if response.errMessage != "" {
			a.writeJSON(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"error": map[string]interface{}{
					"code":    -32603,
					"message": response.errMessage,
				},
			})
			continue
		}
		stopReason := response.stopReason
		if strings.TrimSpace(stopReason) == "" {
			stopReason = "end_turn"
		}
		a.writeJSON(map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      json.RawMessage(req.ID),
			"result": map[string]interface{}{
				"stopReason": stopReason,
			},
		})
	}
}

func (a *promptRetryFakeAgent) writeJSON(v interface{}) {
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

func (a *promptRetryFakeAgent) RequestCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.count
}

type recordingEventAppender struct {
	mu     sync.Mutex
	events []string
}

func (a *recordingEventAppender) AppendEvent(_ string, _ string, eventType string, _ string, _ map[string]interface{}) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.events = append(a.events, eventType)
}

func (a *recordingEventAppender) Count(eventType string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	count := 0
	for _, event := range a.events {
		if event == eventType {
			count++
		}
	}
	return count
}

func newPromptRetryTestHost(t *testing.T, script promptRetryScript) (*SessionHost, *promptRetryFakeAgent) {
	t.Helper()

	reporter := &mockMessageReporter{}
	events := &recordingEventAppender{}
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:               "test-session",
			WorkspaceID:             "test-workspace",
			MessageReporter:         reporter,
			EventAppender:           events,
			PromptRetryMaxRetries:   2,
			PromptRetryInitialDelay: time.Millisecond,
			PromptRetryMaxDelay:     time.Millisecond,
			PromptRetrySleeper: func(ctx context.Context, _ time.Duration) error {
				select {
				case <-ctx.Done():
					return ctx.Err()
				default:
					return nil
				}
			},
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

	server := &promptRetryFakeAgent{
		t:      t,
		reader: bufio.NewReader(clientToAgentReader),
		writer: agentToClientWriter,
		script: script,
	}
	go server.Serve()

	acpConn := acpsdk.NewClientSideConnection(
		&sessionHostClient{host: host},
		clientToAgentWriter,
		agentToClientReader,
	)

	host.mu.Lock()
	host.acpConn = acpConn
	host.sessionID = "acp-session-retry"
	host.status = HostReady
	host.mu.Unlock()

	return host, server
}

func promptRetryParams() json.RawMessage {
	params, _ := json.Marshal(map[string]interface{}{
		"messageId": "retry-message-001",
		"prompt": []map[string]string{
			{"type": "text", "text": "please continue"},
		},
	})
	return params
}
