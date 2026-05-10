// Package acp implements the ACP (Agent Communication Protocol) server side
// for the SAM harness, allowing the VM agent to communicate with the harness
// over JSON-RPC via stdin/stdout.
package acp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/workspace/harness/agent"
	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/tools"
	"github.com/workspace/harness/transcript"
)

// Handler implements the acpsdk.Agent interface, bridging ACP JSON-RPC
// messages to the harness agent loop.
type Handler struct {
	conn *acpsdk.AgentSideConnection

	provider llm.Provider
	registry *tools.Registry
	config   agent.Config

	mu       sync.Mutex
	sessions map[string]*sessionState
}

type sessionState struct {
	cancel context.CancelFunc
	cwd    string
}

// Deps holds the dependencies needed by the ACP handler to run the agent loop.
type Deps struct {
	Provider llm.Provider
	Registry *tools.Registry
	Config   agent.Config
}

// NewHandler creates a new ACP handler with the given dependencies.
func NewHandler(deps Deps) *Handler {
	return &Handler{
		provider: deps.Provider,
		registry: deps.Registry,
		config:   deps.Config,
		sessions: make(map[string]*sessionState),
	}
}

// SetAgentConnection stores the connection reference so the handler can send
// session update notifications back to the client.
func (h *Handler) SetAgentConnection(conn *acpsdk.AgentSideConnection) {
	h.conn = conn
}

// Serve creates an AgentSideConnection over the given reader/writer and blocks
// until the peer disconnects.
func Serve(h *Handler, out io.Writer, in io.Reader) {
	asc := acpsdk.NewAgentSideConnection(h, out, in)
	asc.SetLogger(slog.Default())
	h.SetAgentConnection(asc)
	<-asc.Done()
}

// --- Agent interface implementation ---

func (h *Handler) Authenticate(_ context.Context, _ acpsdk.AuthenticateRequest) (acpsdk.AuthenticateResponse, error) {
	return acpsdk.AuthenticateResponse{}, nil
}

func (h *Handler) Initialize(_ context.Context, _ acpsdk.InitializeRequest) (acpsdk.InitializeResponse, error) {
	return acpsdk.InitializeResponse{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
		AgentInfo: &acpsdk.Implementation{
			Name:    "sam-harness",
			Version: "0.1.0",
		},
		AgentCapabilities: acpsdk.AgentCapabilities{
			LoadSession: false,
		},
	}, nil
}

func (h *Handler) NewSession(_ context.Context, params acpsdk.NewSessionRequest) (acpsdk.NewSessionResponse, error) {
	sid := randomSessionID()

	cwd := params.Cwd
	if cwd == "" {
		cwd = h.config.WorkDir
	}

	h.mu.Lock()
	h.sessions[sid] = &sessionState{cwd: cwd}
	h.mu.Unlock()

	return acpsdk.NewSessionResponse{
		SessionId: acpsdk.SessionId(sid),
	}, nil
}

func (h *Handler) Prompt(ctx context.Context, params acpsdk.PromptRequest) (acpsdk.PromptResponse, error) {
	sid := string(params.SessionId)

	h.mu.Lock()
	sess, ok := h.sessions[sid]
	h.mu.Unlock()
	if !ok {
		return acpsdk.PromptResponse{}, fmt.Errorf("session %s not found", sid)
	}

	// Cancel any previous in-flight prompt for this session.
	h.mu.Lock()
	if sess.cancel != nil {
		prev := sess.cancel
		h.mu.Unlock()
		prev()
	} else {
		h.mu.Unlock()
	}

	promptCtx, promptCancel := context.WithCancel(ctx)
	h.mu.Lock()
	sess.cancel = promptCancel
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		sess.cancel = nil
		h.mu.Unlock()
		promptCancel()
	}()

	// Extract text from prompt content blocks.
	userPrompt := extractText(params.Prompt)
	if userPrompt == "" {
		return acpsdk.PromptResponse{StopReason: acpsdk.StopReasonEndTurn}, nil
	}

	// Build a config copy with the session's working directory and an event
	// handler that streams session/update notifications via ACP.
	cfg := h.config
	if sess.cwd != "" {
		cfg.WorkDir = sess.cwd
	}
	cfg.Handler = &acpEventHandler{
		conn:      h.conn,
		sessionID: params.SessionId,
	}

	log := transcript.NewLog()
	result, err := agent.Run(promptCtx, h.provider, h.registry, log, cfg, userPrompt)

	if promptCtx.Err() != nil {
		return acpsdk.PromptResponse{StopReason: acpsdk.StopReasonCancelled}, nil
	}
	if err != nil {
		return acpsdk.PromptResponse{}, fmt.Errorf("agent run failed: %w", err)
	}

	stopReason := mapStopReason(result.StopReason)

	// Send the final assistant message as a session update if present.
	if result.FinalMessage != "" && h.conn != nil {
		_ = h.conn.SessionUpdate(ctx, acpsdk.SessionNotification{
			SessionId: params.SessionId,
			Update:    acpsdk.UpdateAgentMessageText(result.FinalMessage),
		})
	}

	resp := acpsdk.PromptResponse{
		StopReason: stopReason,
	}
	if params.MessageId != nil {
		resp.UserMessageId = params.MessageId
	}
	return resp, nil
}

func (h *Handler) Cancel(_ context.Context, params acpsdk.CancelNotification) error {
	h.mu.Lock()
	sess, ok := h.sessions[string(params.SessionId)]
	h.mu.Unlock()
	if ok && sess != nil && sess.cancel != nil {
		sess.cancel()
	}
	return nil
}

func (h *Handler) CloseSession(_ context.Context, params acpsdk.CloseSessionRequest) (acpsdk.CloseSessionResponse, error) {
	h.mu.Lock()
	sess, ok := h.sessions[string(params.SessionId)]
	if ok {
		if sess.cancel != nil {
			sess.cancel()
		}
		delete(h.sessions, string(params.SessionId))
	}
	h.mu.Unlock()
	return acpsdk.CloseSessionResponse{}, nil
}

func (h *Handler) ListSessions(_ context.Context, _ acpsdk.ListSessionsRequest) (acpsdk.ListSessionsResponse, error) {
	return acpsdk.ListSessionsResponse{}, acpsdk.NewMethodNotFound(acpsdk.AgentMethodSessionList)
}

func (h *Handler) ResumeSession(_ context.Context, _ acpsdk.ResumeSessionRequest) (acpsdk.ResumeSessionResponse, error) {
	return acpsdk.ResumeSessionResponse{}, acpsdk.NewMethodNotFound(acpsdk.AgentMethodSessionResume)
}

func (h *Handler) SetSessionConfigOption(_ context.Context, _ acpsdk.SetSessionConfigOptionRequest) (acpsdk.SetSessionConfigOptionResponse, error) {
	return acpsdk.SetSessionConfigOptionResponse{}, acpsdk.NewMethodNotFound(acpsdk.AgentMethodSessionSetConfigOption)
}

func (h *Handler) SetSessionMode(_ context.Context, _ acpsdk.SetSessionModeRequest) (acpsdk.SetSessionModeResponse, error) {
	return acpsdk.SetSessionModeResponse{}, nil
}

// --- helpers ---

// acpEventHandler implements agent.EventHandler and forwards events as ACP
// session/update notifications.
type acpEventHandler struct {
	conn      *acpsdk.AgentSideConnection
	sessionID acpsdk.SessionId

	mu         sync.Mutex
	toolCallID int
}

func (e *acpEventHandler) OnToken(token string) {
	if e.conn == nil {
		return
	}
	_ = e.conn.SessionUpdate(context.Background(), acpsdk.SessionNotification{
		SessionId: e.sessionID,
		Update:    acpsdk.UpdateAgentMessageText(token),
	})
}

func (e *acpEventHandler) OnToolStart(name string, params map[string]any) {
	if e.conn == nil {
		return
	}
	e.mu.Lock()
	e.toolCallID++
	id := fmt.Sprintf("tool_%d_%d", time.Now().UnixMilli(), e.toolCallID)
	e.mu.Unlock()

	_ = e.conn.SessionUpdate(context.Background(), acpsdk.SessionNotification{
		SessionId: e.sessionID,
		Update: acpsdk.StartToolCall(
			acpsdk.ToolCallId(id),
			name,
			acpsdk.WithStartStatus(acpsdk.ToolCallStatusInProgress),
			acpsdk.WithStartRawInput(params),
		),
	})
}

func (e *acpEventHandler) OnToolEnd(name string, result string, isError bool) {
	if e.conn == nil {
		return
	}
	status := acpsdk.ToolCallStatusCompleted
	if isError {
		status = acpsdk.ToolCallStatusFailed
	}

	// We don't track tool call IDs across start/end in the agent loop,
	// so emit a new agent message chunk with the tool result instead.
	_ = e.conn.SessionUpdate(context.Background(), acpsdk.SessionNotification{
		SessionId: e.sessionID,
		Update: acpsdk.UpdateAgentMessageText(
			fmt.Sprintf("[%s %s] %s", name, status, truncate(result, 500)),
		),
	})
}

func (e *acpEventHandler) OnTurnStart(turn, maxTurns int) {}
func (e *acpEventHandler) OnTurnEnd(turn int, toolCallCount int) {}

// extractText concatenates all text content blocks from the prompt.
func extractText(blocks []acpsdk.ContentBlock) string {
	var text string
	for _, b := range blocks {
		if b.Text != nil {
			if text != "" {
				text += "\n"
			}
			text += b.Text.Text
		}
	}
	return text
}

// mapStopReason converts a harness agent StopReason string to an ACP StopReason.
func mapStopReason(reason string) acpsdk.StopReason {
	switch reason {
	case "end_turn", "done":
		return acpsdk.StopReasonEndTurn
	case "max_turns":
		return acpsdk.StopReasonMaxTurnRequests
	case "max_tokens":
		return acpsdk.StopReasonMaxTokens
	case "cancelled":
		return acpsdk.StopReasonCancelled
	default:
		return acpsdk.StopReasonEndTurn
	}
}

func randomSessionID() string {
	var b [12]byte
	if _, err := io.ReadFull(rand.Reader, b[:]); err != nil {
		return fmt.Sprintf("sess_%d", time.Now().UnixNano())
	}
	return "sess_" + hex.EncodeToString(b[:])
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
