package acp

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

func TestAcceptPromptPublishesOnlyControlPlaneMessageID(t *testing.T) {
	for _, tc := range []struct {
		viewerID string
		want     string
	}{
		{viewerID: "server", want: "retry-message-001"},
		{viewerID: "control-plane", want: "retry-message-001"},
		{viewerID: "viewer-1", want: ""},
	} {
		t.Run(tc.viewerID, func(t *testing.T) {
			host, _ := newPromptRetryTestHost(t, promptRetryScript{})
			accepted, ok := host.AcceptPrompt(context.Background(), json.RawMessage(`1`),
				promptRetryParams(), tc.viewerID, false, "delivery-1", nil)
			if !ok {
				t.Fatal("prompt was not accepted")
			}
			if accepted.attempt.messageID != tc.want {
				t.Fatalf("messageID=%q, want %q", accepted.attempt.messageID, tc.want)
			}
		})
	}
}

type blockedLoopbackReporter struct {
	started chan struct{}
	release chan struct{}
}

func (r *blockedLoopbackReporter) Enqueue(MessageReportEntry) error {
	close(r.started)
	<-r.release
	return nil
}

type sdkLoopbackFixtureAgent struct {
	acpsdk.Agent
	conn     *acpsdk.AgentSideConnection
	observed chan acpsdk.UnstableCreateElicitationResponse
}

func (a *sdkLoopbackFixtureAgent) Prompt(ctx context.Context, _ acpsdk.PromptRequest) (acpsdk.PromptResponse, error) {
	response, err := a.conn.UnstableCreateElicitation(ctx,
		fixtureURLRequest("http://localhost:8765/cb?token=sk-sdk-secret-canary"))
	if err != nil {
		return acpsdk.PromptResponse{}, err
	}
	a.observed <- response
	return acpsdk.PromptResponse{StopReason: acpsdk.StopReasonEndTurn}, nil
}

func TestAcpURLLoopbackClassificationRequiresOnlyExplicitLocalCallback(t *testing.T) {
	config := testURLConfig()
	for _, tc := range []struct {
		name, raw string
		want      acpURLStatus
	}{
		{"remote HTTPS", "https://auth.example.com/approve", acpURLEligible},
		{"direct localhost", "http://localhost:8765/callback", acpURLLoopbackOnly},
		{"direct IPv4 loopback", "http://127.0.0.1:8765/callback", acpURLLoopbackOnly},
		{"direct IPv6 loopback", "http://[::1]:8765/callback", acpURLLoopbackOnly},
		{"HTTPS localhost", "https://localhost/callback", acpURLLoopbackOnly},
		{"callback query", "https://auth.example.com/start?callback_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcb", acpURLLoopbackOnly},
		{"nested redirect query", "https://auth.example.com/start?next=https%3A%2F%2Fnext.example.com%2F%3Fcallback%3Dhttp%253A%252F%252Flocalhost%253A8765%252Fcb", acpURLLoopbackOnly},
		{"nonloopback HTTP", "http://auth.example.com/start", acpURLInvalid},
		{"nonloopback IP", "https://192.0.2.1/start", acpURLInvalid},
		{"local-looking suffix spoof", "https://localhost.evil.example/start", acpURLEligible},
		{"malformed local subdomain", "http://-bad.localhost/cb", acpURLInvalid},
		{"zero local port", "http://localhost:0/cb", acpURLInvalid},
		{"out of range local port", "http://localhost:999999/cb", acpURLInvalid},
		{"empty local port", "http://localhost:/cb", acpURLInvalid},
		{"userinfo with local callback", "http://user:pass@localhost/cb", acpURLInvalid},
		{"fragment with local callback", "http://localhost/cb#secret", acpURLInvalid},
		{"malformed query with local callback", "https://auth.example.com/start?callback=%ZZ", acpURLInvalid},
		{"invalid additional callback", "https://auth.example.com/start?callback=http%3A%2F%2Flocalhost%2Fcb&next=http%3A%2F%2Fevil.example%2Fcb", acpURLInvalid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyAcpURLDepth(tc.raw, 0, config.URLMaxChars, config.URLRedirectDepth)
			if got != tc.want {
				t.Fatalf("URL status = %v, want %v", got, tc.want)
			}
			if eligibleAcpURL(tc.raw, config.URLMaxChars, config.URLRedirectDepth) != (tc.want == acpURLEligible) {
				t.Fatal("loopback classification changed URL acceptance")
			}
		})
	}
	if got := classifyAcpURLDepth("http://localhost/cb", 0, 8, config.URLRedirectDepth); got != acpURLInvalid {
		t.Fatalf("over-length local URL = %v", got)
	}
	if got := classifyAcpURLDepth("https://auth.example.com/?next=http%3A%2F%2Flocalhost%2Fcb", 0, config.URLMaxChars, 0); got != acpURLInvalid {
		t.Fatalf("over-depth callback = %v", got)
	}
}

func TestLoopbackRejectionReportsOnlyFixedTextForActiveRequest(t *testing.T) {
	const canary = "sk-loopback-secret-canary-12345"
	recorder := newInteractionRecorder(t, 201)
	host, client := newInteractionHost(recorder)
	t.Cleanup(host.Stop)
	host.ConfigureAcpInteractions(testURLConfig())
	reporter := &mockMessageReporter{}
	host.config.MessageReporter = reporter
	request := fixtureURLRequest("https://auth.example.com/start?callback_uri=http%3A%2F%2Flocalhost%3A8765%2Fcb%3Ftoken%3D" + canary)
	request.Url.Message = "Untrusted wrapper text " + canary
	response, err := host.requestURL(context.Background(), client.interactionGeneration, request)
	if err != nil || response.Cancel == nil {
		t.Fatalf("loopback request response = %+v, err %v", response, err)
	}
	messages := reporter.Messages()
	if len(messages) != 1 || messages[0].Role != "system" || messages[0].SessionID != host.config.SessionID ||
		messages[0].Content != unsupportedLoopbackAuthMessage || messages[0].MessageID == "" || messages[0].Timestamp == "" ||
		messages[0].ToolMetadata != `{"promptMessageId":"prompt-user-a"}` {
		t.Fatalf("unexpected loopback report: %#v", messages)
	}
	if strings.Contains(messages[0].Content, canary) || strings.Contains(messages[0].Content, "localhost") ||
		strings.Contains(messages[0].ToolMetadata, canary) || len(recorder.creates) != 0 {
		t.Fatal("loopback URL or wrapper metadata escaped into transcript or Worker create")
	}
}

func TestPinnedSDKLoopbackRejectionReachesMessageReporter(t *testing.T) {
	recorder := newInteractionRecorder(t, 201)
	host, _ := newInteractionHost(recorder)
	host.ConfigureAcpInteractions(testURLConfig())
	t.Cleanup(host.Stop)
	reporter := &mockMessageReporter{}
	host.config.MessageReporter = reporter
	clientToAgentReader, clientToAgentWriter := io.Pipe()
	agentToClientReader, agentToClientWriter := io.Pipe()
	t.Cleanup(func() {
		_ = clientToAgentReader.Close()
		_ = clientToAgentWriter.Close()
		_ = agentToClientReader.Close()
		_ = agentToClientWriter.Close()
	})
	agent := &sdkLoopbackFixtureAgent{observed: make(chan acpsdk.UnstableCreateElicitationResponse, 1)}
	agent.conn = acpsdk.NewAgentSideConnection(agent, agentToClientWriter, clientToAgentReader)
	client := &sessionHostClient{host: host, interactionGeneration: host.interactionGeneration}
	clientConn := acpsdk.NewClientSideConnection(client, clientToAgentWriter, agentToClientReader)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := clientConn.Prompt(ctx, acpsdk.PromptRequest{
		SessionId: "sdk-session", Prompt: []acpsdk.ContentBlock{acpsdk.TextBlock("test loopback")},
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case response := <-agent.observed:
		if response.Cancel == nil {
			t.Fatalf("SDK loopback response = %+v", response)
		}
	default:
		t.Fatal("SDK agent did not receive loopback rejection")
	}
	messages := reporter.Messages()
	if len(messages) != 1 || messages[0].Role != "system" || messages[0].Content != unsupportedLoopbackAuthMessage ||
		strings.Contains(messages[0].Content, "sk-sdk-secret-canary") || len(recorder.creates) != 0 {
		t.Fatalf("unsafe SDK loopback report: %#v", messages)
	}
}

func TestLoopbackRejectionDoesNotReportWithoutTrustedRequestContext(t *testing.T) {
	for _, tc := range []struct {
		name    string
		prepare func(*SessionHost, *sessionHostClient)
		url     string
	}{
		{"nonloopback HTTP", nil, "http://auth.example.com/start"},
		{"malformed local URL", nil, "http://localhost/cb#fragment"},
		{"disabled URLs", func(h *SessionHost, _ *sessionHostClient) {
			c := testURLConfig()
			c.URLsEnabled = false
			h.ConfigureAcpInteractions(c)
		}, "http://localhost/cb"},
		{"missing callback token", func(h *SessionHost, _ *sessionHostClient) { h.config.CallbackToken = "" }, "http://localhost/cb"},
		{"stale generation", func(_ *SessionHost, c *sessionHostClient) { c.interactionGeneration = "stale" }, "http://localhost/cb"},
		{"inactive prompt", func(h *SessionHost, _ *sessionHostClient) {
			attempt, _ := h.activePromptAttempt()
			h.releasePrompt(attempt)
		}, "http://localhost/cb"},
		{"missing prompt message ID", func(h *SessionHost, _ *sessionHostClient) {
			attempt, _ := h.activePromptAttempt()
			attempt.messageID = ""
		}, "http://localhost/cb"},
		{"untrusted prompt message ID", func(h *SessionHost, _ *sessionHostClient) {
			attempt, _ := h.activePromptAttempt()
			attempt.messageID = "https://evil.example/?token=sk-secret-canary"
		}, "http://localhost/cb"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := newInteractionRecorder(t, 201)
			host, client := newInteractionHost(recorder)
			t.Cleanup(host.Stop)
			host.ConfigureAcpInteractions(testURLConfig())
			reporter := &mockMessageReporter{}
			host.config.MessageReporter = reporter
			if tc.prepare != nil {
				tc.prepare(host, client)
			}
			response, err := host.requestURL(context.Background(), client.interactionGeneration, fixtureURLRequest(tc.url))
			if err != nil || response.Cancel == nil {
				t.Fatalf("request response = %+v, err %v", response, err)
			}
			if got := reporter.Messages(); len(got) != 0 {
				t.Fatalf("untrusted request reported: %#v", got)
			}
		})
	}
}

func TestLoopbackRejectionDoesNotReportMalformedWrapper(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*acpsdk.UnstableCreateElicitationRequest)
	}{
		{"missing URL variant", func(r *acpsdk.UnstableCreateElicitationRequest) { r.Url = nil }},
		{"ambiguous form and URL", func(r *acpsdk.UnstableCreateElicitationRequest) { r.Form = &acpsdk.UnstableCreateElicitationForm{} }},
		{"untrusted wrapper metadata", func(r *acpsdk.UnstableCreateElicitationRequest) {
			r.Url.Meta = map[string]any{"token": "sk-secret-canary"}
		}},
		{"empty elicitation ID", func(r *acpsdk.UnstableCreateElicitationRequest) { r.Url.ElicitationId = "" }},
		{"oversize wrapper message", func(r *acpsdk.UnstableCreateElicitationRequest) {
			r.Url.Message = strings.Repeat("x", testURLConfig().RequestMaxBytes+1)
		}},
		{"oversize encoded request", func(r *acpsdk.UnstableCreateElicitationRequest) {
			r.Url.Message = strings.Repeat("x", testURLConfig().RequestMaxBytes-10)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := newInteractionRecorder(t, 201)
			host, client := newInteractionHost(recorder)
			t.Cleanup(host.Stop)
			host.ConfigureAcpInteractions(testURLConfig())
			reporter := &mockMessageReporter{}
			host.config.MessageReporter = reporter
			request := fixtureURLRequest("http://localhost/cb?token=sk-secret-canary")
			tc.mutate(&request)
			response, err := host.requestURL(context.Background(), client.interactionGeneration, request)
			if err != nil || response.Cancel == nil || len(reporter.Messages()) != 0 {
				t.Fatalf("malformed request produced guidance: response=%+v err=%v messages=%#v", response, err, reporter.Messages())
			}
		})
	}
}

func TestLoopbackRejectionDoesNotReportCanceledRequest(t *testing.T) {
	recorder := newInteractionRecorder(t, 201)
	host, client := newInteractionHost(recorder)
	t.Cleanup(host.Stop)
	host.ConfigureAcpInteractions(testURLConfig())
	reporter := &mockMessageReporter{}
	host.config.MessageReporter = reporter
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	response, err := host.requestURL(ctx, client.interactionGeneration, fixtureURLRequest("http://localhost/cb"))
	if err != nil || response.Cancel == nil || len(reporter.Messages()) != 0 {
		t.Fatalf("canceled request produced guidance: response=%+v err=%v messages=%#v", response, err, reporter.Messages())
	}
}

func TestLoopbackReportRejectsPreviousAttemptInSameGeneration(t *testing.T) {
	recorder := newInteractionRecorder(t, 201)
	host, client := newInteractionHost(recorder)
	t.Cleanup(host.Stop)
	host.ConfigureAcpInteractions(testURLConfig())
	reporter := &mockMessageReporter{}
	host.config.MessageReporter = reporter
	attemptA, _ := host.activePromptAttempt()
	host.releasePrompt(attemptA)
	ctxB, cancelB := context.WithCancel(host.lifecycleContext())
	defer cancelB()
	if _, ok := host.beginPromptForDelivery(ctxB, cancelB, "prompt-b", nil); !ok {
		t.Fatal("could not start second prompt")
	}
	host.reportUnsupportedLoopbackAuth(context.Background(), client.interactionGeneration, attemptA.id)
	if got := reporter.Messages(); len(got) != 0 {
		t.Fatalf("attempt A reported into B: %#v", got)
	}
}

func TestLoopbackReportRechecksCancellationAfterInitialRequestCheck(t *testing.T) {
	recorder := newInteractionRecorder(t, 201)
	host, client := newInteractionHost(recorder)
	t.Cleanup(host.Stop)
	host.ConfigureAcpInteractions(testURLConfig())
	reporter := &mockMessageReporter{}
	host.config.MessageReporter = reporter
	attempt, _ := host.activePromptAttempt()
	ctx, cancel := context.WithCancel(context.Background())
	// Hold the validation lock after the request's first cancellation check.
	host.promptMu.Lock()
	done := make(chan struct{})
	go func() {
		host.reportUnsupportedLoopbackAuth(ctx, client.interactionGeneration, attempt.id)
		close(done)
	}()
	cancel()
	host.promptMu.Unlock()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("report did not return after cancellation")
	}
	if got := reporter.Messages(); len(got) != 0 {
		t.Fatalf("canceled request reported: %#v", got)
	}
}

func TestBlockedLoopbackReporterDoesNotBlockPromptLifecycle(t *testing.T) {
	recorder := newInteractionRecorder(t, 201)
	host, client := newInteractionHost(recorder)
	t.Cleanup(host.Stop)
	host.ConfigureAcpInteractions(testURLConfig())
	reporter := &blockedLoopbackReporter{started: make(chan struct{}), release: make(chan struct{})}
	host.config.MessageReporter = reporter
	attempt, _ := host.activePromptAttempt()
	reportDone := make(chan struct{})
	go func() {
		host.reportUnsupportedLoopbackAuth(context.Background(), client.interactionGeneration, attempt.id)
		close(reportDone)
	}()
	select {
	case <-reporter.started:
	case <-time.After(2 * time.Second):
		t.Fatal("reporter did not begin")
	}
	lifecycleDone := make(chan struct{})
	go func() {
		host.releasePrompt(attempt)
		ctxB, cancelB := context.WithCancel(host.lifecycleContext())
		defer cancelB()
		_, _ = host.beginPromptForDelivery(ctxB, cancelB, "prompt-b", nil)
		close(lifecycleDone)
	}()
	select {
	case <-lifecycleDone:
	case <-time.After(2 * time.Second):
		t.Fatal("blocked reporter pinned prompt lifecycle")
	}
	close(reporter.release)
	<-reportDone
}
