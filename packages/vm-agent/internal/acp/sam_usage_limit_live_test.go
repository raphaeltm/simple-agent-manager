package acp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"sync/atomic"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// Opt-in contract test with the real pinned Claude ACP adapter (idea 01M89JXTFHW4W3PQ65GTED6D0K).
// The adapter talks to a local server that answers every model call with the exact 429 the SAM
// AI proxy sends, and the error the adapter returns over ACP is classified the way the prompt
// path classifies it. The control answers with a provider's own 429, which must stay
// provider_overloaded. Never contacts a model.
//
//	SAM_LIVE_CLAUDE_ACP=$(command -v claude-agent-acp) go test ./internal/acp -run LiveClaudeAdapter -v
func TestLiveClaudeAdapterSAMUsageLimit(t *testing.T) {
	adapter := os.Getenv("SAM_LIVE_CLAUDE_ACP")
	if adapter == "" {
		t.Skip("set SAM_LIVE_CLAUDE_ACP to the claude-agent-acp binary")
	}
	for _, tc := range []struct{ name, body, want string }{
		{"administrator monthly ceiling", samAdminCapBody, samUsageLimitReason},
		{"personal monthly cap", samUserCapBody, samUsageLimitReason},
		{"daily token budget", samDailyBody, samUsageLimitReason},
		{"control: provider rate limit", providerRateBody, "provider_overloaded"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("retry-after", "0")
				w.Header().Set("x-should-retry", "false")
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer server.Close()

			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
			defer cancel()
			cmd := exec.CommandContext(ctx, adapter)
			cmd.Env = append(os.Environ(),
				"ANTHROPIC_BASE_URL="+server.URL,
				"ANTHROPIC_API_KEY=sk-test-not-a-real-key",
				"HOME="+t.TempDir(),
				"CLAUDE_CODE_MAX_RETRIES=0",
				"DISABLE_TELEMETRY=1",
				"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
			)
			stdin, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			stdout, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			cmd.Stderr = io.Discard
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()

			host := newTestSessionHost(t)
			defer host.Stop()
			conn := acpsdk.NewClientSideConnection(&sessionHostClient{host: host}, stdin, stdout)
			if _, err := conn.Initialize(ctx, acpsdk.InitializeRequest{ProtocolVersion: acpsdk.ProtocolVersionNumber}); err != nil {
				t.Fatalf("initialize: %v", err)
			}
			session, err := conn.NewSession(ctx, acpsdk.NewSessionRequest{Cwd: t.TempDir(), McpServers: []acpsdk.McpServer{}})
			if err != nil {
				t.Fatalf("new session: %v", err)
			}
			_, promptErr := conn.Prompt(ctx, acpsdk.PromptRequest{
				SessionId: session.SessionId,
				Prompt:    []acpsdk.ContentBlock{acpsdk.TextBlock("Reply with PONG.")},
			})
			if promptErr == nil {
				t.Fatal("prompt succeeded against a server that only answers 429")
			}
			var request *acpsdk.RequestError
			if errors.As(promptErr, &request) {
				data, _ := json.Marshal(request.Data)
				t.Logf("adapter error: code=%d message=%.160q data=%.240s (model calls: %d)", request.Code, request.Message, data, calls.Load())
			}
			if calls.Load() == 0 {
				t.Fatal("the adapter never reached the local model server")
			}
			if got := ClassifyPromptError(promptErr); got != tc.want {
				t.Fatalf("reason = %q, want %q", got, tc.want)
			}
		})
	}
}
