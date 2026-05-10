package acp

import (
	"context"
	"io"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/workspace/harness/agent"
	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/tools"
)

// testClientFuncs implements acpsdk.Client for testing.
type testClientFuncs struct {
	SessionUpdateFunc     func(context.Context, acpsdk.SessionNotification) error
	RequestPermissionFunc func(context.Context, acpsdk.RequestPermissionRequest) (acpsdk.RequestPermissionResponse, error)
}

func (c testClientFuncs) SessionUpdate(ctx context.Context, n acpsdk.SessionNotification) error {
	if c.SessionUpdateFunc != nil {
		return c.SessionUpdateFunc(ctx, n)
	}
	return nil
}

func (c testClientFuncs) RequestPermission(ctx context.Context, r acpsdk.RequestPermissionRequest) (acpsdk.RequestPermissionResponse, error) {
	if c.RequestPermissionFunc != nil {
		return c.RequestPermissionFunc(ctx, r)
	}
	return acpsdk.RequestPermissionResponse{
		Outcome: acpsdk.RequestPermissionOutcome{
			Selected: &acpsdk.RequestPermissionOutcomeSelected{OptionId: "allow"},
		},
	}, nil
}

func (c testClientFuncs) ReadTextFile(_ context.Context, _ acpsdk.ReadTextFileRequest) (acpsdk.ReadTextFileResponse, error) {
	return acpsdk.ReadTextFileResponse{}, nil
}

func (c testClientFuncs) WriteTextFile(_ context.Context, _ acpsdk.WriteTextFileRequest) (acpsdk.WriteTextFileResponse, error) {
	return acpsdk.WriteTextFileResponse{}, nil
}

func (c testClientFuncs) CreateTerminal(_ context.Context, _ acpsdk.CreateTerminalRequest) (acpsdk.CreateTerminalResponse, error) {
	return acpsdk.CreateTerminalResponse{}, nil
}

func (c testClientFuncs) KillTerminal(_ context.Context, _ acpsdk.KillTerminalRequest) (acpsdk.KillTerminalResponse, error) {
	return acpsdk.KillTerminalResponse{}, nil
}

func (c testClientFuncs) TerminalOutput(_ context.Context, _ acpsdk.TerminalOutputRequest) (acpsdk.TerminalOutputResponse, error) {
	return acpsdk.TerminalOutputResponse{}, nil
}

func (c testClientFuncs) ReleaseTerminal(_ context.Context, _ acpsdk.ReleaseTerminalRequest) (acpsdk.ReleaseTerminalResponse, error) {
	return acpsdk.ReleaseTerminalResponse{}, nil
}

func (c testClientFuncs) WaitForTerminalExit(_ context.Context, _ acpsdk.WaitForTerminalExitRequest) (acpsdk.WaitForTerminalExitResponse, error) {
	return acpsdk.WaitForTerminalExitResponse{}, nil
}

// setupPair creates a connected client/agent pair for testing, returning the
// client-side connection and a cleanup function.
func setupPair(t *testing.T, handler *Handler, clientFuncs testClientFuncs) *acpsdk.ClientSideConnection {
	t.Helper()

	// c2a: client writes, agent reads
	c2aR, c2aW := io.Pipe()
	// a2c: agent writes, client reads
	a2cR, a2cW := io.Pipe()

	// Agent side
	asc := acpsdk.NewAgentSideConnection(handler, a2cW, c2aR)
	handler.SetAgentConnection(asc)

	// Client side
	clientConn := acpsdk.NewClientSideConnection(clientFuncs, c2aW, a2cR)

	t.Cleanup(func() {
		c2aW.Close()
		a2cW.Close()
	})

	return clientConn
}

func TestInitialize(t *testing.T) {
	handler := NewHandler(Deps{
		Provider: llm.NewMockProvider(&llm.Response{Content: "test"}),
		Registry: tools.NewRegistry(),
		Config:   agent.Config{WorkDir: t.TempDir()},
	})

	clientConn := setupPair(t, handler, testClientFuncs{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	resp, err := clientConn.Initialize(ctx, acpsdk.InitializeRequest{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
	})
	if err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}
	if resp.ProtocolVersion != acpsdk.ProtocolVersionNumber {
		t.Errorf("ProtocolVersion = %d, want %d", resp.ProtocolVersion, acpsdk.ProtocolVersionNumber)
	}
	if resp.AgentInfo == nil || resp.AgentInfo.Name != "sam-harness" {
		t.Errorf("AgentInfo.Name = %v, want sam-harness", resp.AgentInfo)
	}
}

func TestNewSession(t *testing.T) {
	handler := NewHandler(Deps{
		Provider: llm.NewMockProvider(&llm.Response{Content: "test"}),
		Registry: tools.NewRegistry(),
		Config:   agent.Config{WorkDir: t.TempDir()},
	})

	clientConn := setupPair(t, handler, testClientFuncs{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := clientConn.Initialize(ctx, acpsdk.InitializeRequest{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
	})
	if err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}

	sessResp, err := clientConn.NewSession(ctx, acpsdk.NewSessionRequest{
		Cwd:        t.TempDir(),
		McpServers: []acpsdk.McpServer{},
	})
	if err != nil {
		t.Fatalf("NewSession failed: %v", err)
	}
	if sessResp.SessionId == "" {
		t.Error("SessionId is empty")
	}
}

func TestPromptEndToEnd(t *testing.T) {
	mockResp := &llm.Response{Content: "Hello, I completed the task."}
	handler := NewHandler(Deps{
		Provider: llm.NewMockProvider(mockResp),
		Registry: tools.NewRegistry(),
		Config:   agent.Config{WorkDir: t.TempDir(), MaxTurns: 1},
	})

	var updates []acpsdk.SessionNotification
	clientConn := setupPair(t, handler, testClientFuncs{
		SessionUpdateFunc: func(_ context.Context, n acpsdk.SessionNotification) error {
			updates = append(updates, n)
			return nil
		},
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err := clientConn.Initialize(ctx, acpsdk.InitializeRequest{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
	})
	if err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}

	sessResp, err := clientConn.NewSession(ctx, acpsdk.NewSessionRequest{
		Cwd:        t.TempDir(),
		McpServers: []acpsdk.McpServer{},
	})
	if err != nil {
		t.Fatalf("NewSession failed: %v", err)
	}

	promptResp, err := clientConn.Prompt(ctx, acpsdk.PromptRequest{
		SessionId: sessResp.SessionId,
		Prompt:    []acpsdk.ContentBlock{acpsdk.TextBlock("What is 2+2?")},
	})
	if err != nil {
		t.Fatalf("Prompt failed: %v", err)
	}
	if promptResp.StopReason != acpsdk.StopReasonEndTurn {
		t.Errorf("StopReason = %s, want %s", promptResp.StopReason, acpsdk.StopReasonEndTurn)
	}

	// Verify we received at least one session update with the final message.
	if len(updates) == 0 {
		t.Error("expected at least one session update notification")
	}
}

func TestPromptInvalidSession(t *testing.T) {
	handler := NewHandler(Deps{
		Provider: llm.NewMockProvider(&llm.Response{Content: "test"}),
		Registry: tools.NewRegistry(),
		Config:   agent.Config{WorkDir: t.TempDir()},
	})

	clientConn := setupPair(t, handler, testClientFuncs{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := clientConn.Initialize(ctx, acpsdk.InitializeRequest{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
	})
	if err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}

	_, err = clientConn.Prompt(ctx, acpsdk.PromptRequest{
		SessionId: "nonexistent",
		Prompt:    []acpsdk.ContentBlock{acpsdk.TextBlock("test")},
	})
	if err == nil {
		t.Error("expected error for nonexistent session, got nil")
	}
}

func TestCancel(t *testing.T) {
	handler := NewHandler(Deps{
		Provider: llm.NewMockProvider(&llm.Response{Content: "test"}),
		Registry: tools.NewRegistry(),
		Config:   agent.Config{WorkDir: t.TempDir()},
	})

	clientConn := setupPair(t, handler, testClientFuncs{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := clientConn.Initialize(ctx, acpsdk.InitializeRequest{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
	})
	if err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}

	sessResp, err := clientConn.NewSession(ctx, acpsdk.NewSessionRequest{
		Cwd:        t.TempDir(),
		McpServers: []acpsdk.McpServer{},
	})
	if err != nil {
		t.Fatalf("NewSession failed: %v", err)
	}

	// Cancel should not error even if no prompt is in flight.
	err = clientConn.Cancel(ctx, acpsdk.CancelNotification{
		SessionId: sessResp.SessionId,
	})
	if err != nil {
		t.Errorf("Cancel failed: %v", err)
	}
}

func TestExtractText(t *testing.T) {
	tests := []struct {
		name   string
		blocks []acpsdk.ContentBlock
		want   string
	}{
		{
			name:   "single text block",
			blocks: []acpsdk.ContentBlock{acpsdk.TextBlock("hello world")},
			want:   "hello world",
		},
		{
			name: "multiple text blocks",
			blocks: []acpsdk.ContentBlock{
				acpsdk.TextBlock("first"),
				acpsdk.TextBlock("second"),
			},
			want: "first\nsecond",
		},
		{
			name:   "empty blocks",
			blocks: []acpsdk.ContentBlock{},
			want:   "",
		},
		{
			name:   "nil blocks",
			blocks: nil,
			want:   "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractText(tt.blocks)
			if got != tt.want {
				t.Errorf("extractText() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestMapStopReason(t *testing.T) {
	tests := []struct {
		input string
		want  acpsdk.StopReason
	}{
		{"end_turn", acpsdk.StopReasonEndTurn},
		{"done", acpsdk.StopReasonEndTurn},
		{"max_turns", acpsdk.StopReasonMaxTurnRequests},
		{"max_tokens", acpsdk.StopReasonMaxTokens},
		{"cancelled", acpsdk.StopReasonCancelled},
		{"unknown", acpsdk.StopReasonEndTurn},
		{"", acpsdk.StopReasonEndTurn},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := mapStopReason(tt.input)
			if got != tt.want {
				t.Errorf("mapStopReason(%q) = %s, want %s", tt.input, got, tt.want)
			}
		})
	}
}

func TestCloseSession(t *testing.T) {
	handler := NewHandler(Deps{
		Provider: llm.NewMockProvider(&llm.Response{Content: "test"}),
		Registry: tools.NewRegistry(),
		Config:   agent.Config{WorkDir: t.TempDir()},
	})

	clientConn := setupPair(t, handler, testClientFuncs{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := clientConn.Initialize(ctx, acpsdk.InitializeRequest{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
	})
	if err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}

	sessResp, err := clientConn.NewSession(ctx, acpsdk.NewSessionRequest{
		Cwd:        t.TempDir(),
		McpServers: []acpsdk.McpServer{},
	})
	if err != nil {
		t.Fatalf("NewSession failed: %v", err)
	}

	_, err = clientConn.CloseSession(ctx, acpsdk.CloseSessionRequest{
		SessionId: sessResp.SessionId,
	})
	if err != nil {
		t.Errorf("CloseSession failed: %v", err)
	}

	// Prompt after close should fail.
	_, err = clientConn.Prompt(ctx, acpsdk.PromptRequest{
		SessionId: sessResp.SessionId,
		Prompt:    []acpsdk.ContentBlock{acpsdk.TextBlock("test")},
	})
	if err == nil {
		t.Error("expected error when prompting a closed session")
	}
}
